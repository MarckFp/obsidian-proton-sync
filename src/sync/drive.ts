import { NodeType, type NodeEntity, type ProtonDriveClient } from '@protontech/drive-sdk';

import type { Logger } from '../util/logger';
import { joinPath } from './paths';
import type { RemoteState } from './types';

/** A snapshot of the Drive subtree the vault maps onto. */
export type RemoteTree = {
    /** Vault-relative path to the file's remote state. */
    files: Map<string, RemoteState>;
    /** Vault-relative path to the folder's node uid, excluding the root. */
    folders: Map<string, string>;
    /** Event scope covering the tree, used to subscribe to remote changes. */
    treeEventScopeId: string;
    /** Paths whose name could not be decrypted, and which were skipped. */
    skipped: string[];
};

/**
 * The Drive side of the sync, wrapping `ProtonDriveClient` in the vocabulary
 * the engine uses: vault-relative paths rather than node uids.
 */
export class DriveIO {
    constructor(
        private readonly client: ProtonDriveClient,
        private readonly logger: Logger,
    ) {}

    async getRootFolder(): Promise<NodeEntity> {
        return this.client.getMyFilesRootFolder();
    }

    async getNode(nodeUid: string): Promise<NodeEntity> {
        return this.client.getNode(nodeUid);
    }

    /**
     * Walk the subtree under `rootUid` into a path-keyed snapshot.
     *
     * This is the expensive operation in the whole plugin — it touches every
     * node — so it runs on a full reconciliation only. Steady-state syncing
     * works from Drive events instead, which is also what Proton's usage
     * guidelines require of third-party clients.
     */
    async listTree(rootUid: string, shouldDescend: (folderPath: string) => boolean): Promise<RemoteTree> {
        const root = await this.client.getNode(rootUid);
        const tree: RemoteTree = {
            files: new Map(),
            folders: new Map(),
            treeEventScopeId: root.treeEventScopeId,
            skipped: [],
        };

        const queue: { uid: string; path: string }[] = [{ uid: rootUid, path: '' }];

        while (queue.length > 0) {
            const folder = queue.pop()!;
            for await (const child of this.client.iterateFolderChildren(folder.uid)) {
                if (child.trashTime !== undefined) {
                    continue;
                }

                const name = nodeName(child);
                if (name === undefined) {
                    // An undecryptable name cannot be mapped to a vault path.
                    // Skipping is the only safe response; guessing a filename
                    // would create a duplicate on the next sync.
                    tree.skipped.push(joinPath(folder.path, `<${child.uid}>`));
                    continue;
                }

                const path = joinPath(folder.path, name);

                if (child.type === NodeType.Folder) {
                    tree.folders.set(path, child.uid);
                    if (shouldDescend(path)) {
                        queue.push({ uid: child.uid, path });
                    }
                    continue;
                }
                if (child.type !== NodeType.File) {
                    continue;
                }

                const remote = toRemoteState(child);
                if (remote) {
                    tree.files.set(path, remote);
                }
            }
        }

        return tree;
    }

    /** Resolve a node's path relative to the sync root, or null if outside it. */
    async getPathWithinRoot(nodeUid: string, rootUid: string): Promise<string | null> {
        const hierarchy = await this.client.getNodeHierarchy(nodeUid);
        const rootIndex = hierarchy.findIndex((node) => node.uid === rootUid);
        if (rootIndex === -1) {
            return null;
        }

        const segments: string[] = [];
        for (const node of hierarchy.slice(rootIndex + 1)) {
            const name = nodeName(node);
            if (name === undefined) {
                return null;
            }
            segments.push(name);
        }
        return segments.join('/');
    }

    /**
     * The live children of a folder, skipping trashed nodes and ones whose name
     * could not be decrypted.
     *
     * Used to find a node by name when the local record is missing or stale —
     * the case where a file was recreated remotely under a name the plugin
     * already knows.
     */
    async *iterateChildren(parentUid: string): AsyncGenerator<{ node: NodeEntity; name: string }> {
        for await (const child of this.client.iterateFolderChildren(parentUid)) {
            if (child.trashTime !== undefined) {
                continue;
            }
            const name = nodeName(child);
            if (name !== undefined) {
                yield { node: child, name };
            }
        }
    }

    /** Vault-facing view of a node's current revision, if it has one. */
    toRemoteState(node: NodeEntity): RemoteState | undefined {
        return toRemoteState(node);
    }

    async createFolder(parentUid: string, name: string): Promise<string> {
        const folder = await this.client.createFolder(parentUid, name);
        return folder.uid;
    }

    async uploadNewFile(
        parentUid: string,
        name: string,
        data: ArrayBuffer,
        options: { mediaType: string; sha1: string; modificationTime: Date },
        signal?: AbortSignal,
    ): Promise<{ nodeUid: string; revisionUid: string }> {
        const uploader = await this.client.getFileUploader(
            parentUid,
            name,
            {
                mediaType: options.mediaType,
                expectedSize: data.byteLength,
                expectedSha1: options.sha1,
                modificationTime: options.modificationTime,
            },
            signal,
        );
        const controller = await uploader.uploadFromStream(streamOf(data), []);
        const { nodeUid, nodeRevisionUid } = await controller.completion();
        return { nodeUid, revisionUid: nodeRevisionUid };
    }

    async uploadRevision(
        nodeUid: string,
        data: ArrayBuffer,
        options: { mediaType: string; sha1: string; modificationTime: Date },
        signal?: AbortSignal,
    ): Promise<{ nodeUid: string; revisionUid: string }> {
        const uploader = await this.client.getFileRevisionUploader(
            nodeUid,
            {
                mediaType: options.mediaType,
                expectedSize: data.byteLength,
                expectedSha1: options.sha1,
                modificationTime: options.modificationTime,
            },
            signal,
        );
        const controller = await uploader.uploadFromStream(streamOf(data), []);
        const result = await controller.completion();
        return { nodeUid: result.nodeUid, revisionUid: result.nodeRevisionUid };
    }

    async downloadFile(nodeUid: string, signal?: AbortSignal): Promise<ArrayBuffer> {
        const downloader = await this.client.getFileDownloader(nodeUid, signal);

        const chunks: Uint8Array[] = [];
        const sink = new WritableStream<Uint8Array>({
            write(chunk) {
                chunks.push(chunk);
            },
        });

        const controller = downloader.downloadToStream(sink);
        try {
            await controller.completion();
        } catch (error) {
            // A download can finish and still throw, when the author's
            // signature does not verify. The bytes are intact but their origin
            // is unproven, so they are refused rather than silently written
            // into the vault under the user's own name.
            if (controller.isDownloadCompleteWithSignatureIssues()) {
                throw new Error(
                    'Downloaded content could not be verified as authentic; refusing to write it to the vault',
                    { cause: error },
                );
            }
            throw error;
        }

        return concatChunks(chunks);
    }

    /**
     * Download a specific past revision.
     *
     * Used to recover the common ancestor of a conflict: the bytes both devices
     * started from are still on Drive, under the revision uid the last sync
     * recorded, which means a three-way merge is possible without the plugin
     * keeping its own copy of every file. Throws when the revision has been
     * pruned, which Drive does depending on the plan's revision history.
     */
    async downloadRevision(revisionUid: string, signal?: AbortSignal): Promise<ArrayBuffer> {
        const downloader = await this.client.getFileRevisionDownloader(revisionUid, signal);

        const chunks: Uint8Array[] = [];
        const sink = new WritableStream<Uint8Array>({
            write(chunk) {
                chunks.push(chunk);
            },
        });

        await downloader.downloadToStream(sink).completion();
        return concatChunks(chunks);
    }

    async trashNode(nodeUid: string): Promise<void> {
        for await (const result of this.client.trashNodes([nodeUid])) {
            if (!result.ok) {
                throw result.error;
            }
        }
    }

    async renameNode(nodeUid: string, newName: string): Promise<void> {
        await this.client.renameNode(nodeUid, newName);
    }

    async moveNode(nodeUid: string, newParentUid: string): Promise<void> {
        for await (const result of this.client.moveNodes([nodeUid], newParentUid)) {
            if (!result.ok) {
                throw result.error;
            }
        }
    }

    /** Event ids for the tree, resuming from `lastEventId` when provided. */
    iterateEvents(treeEventScopeId: string, lastEventId?: string, signal?: AbortSignal) {
        return this.client.iterateEvents(treeEventScopeId, lastEventId, signal);
    }

    logSkipped(tree: RemoteTree): void {
        if (tree.skipped.length > 0) {
            this.logger.warn(
                `Skipped ${tree.skipped.length} Drive item(s) whose name could not be decrypted: ` +
                    tree.skipped.slice(0, 5).join(', '),
            );
        }
    }
}

/** The decrypted name, or undefined when it could not be decrypted. */
function nodeName(node: NodeEntity): string | undefined {
    return node.name.ok ? node.name.value : undefined;
}

function toRemoteState(node: NodeEntity): RemoteState | undefined {
    const revision = node.activeRevision;
    if (!revision) {
        // A file with no active revision is an upload that never finished.
        return undefined;
    }
    return {
        nodeUid: node.uid,
        revisionUid: revision.uid,
        ...(revision.claimedDigests?.sha1 !== undefined && { hash: revision.claimedDigests.sha1 }),
        ...(revision.claimedSize !== undefined && { size: revision.claimedSize }),
        ...(revision.claimedModificationTime !== undefined && {
            mtime: revision.claimedModificationTime.getTime(),
        }),
    };
}

function streamOf(data: ArrayBuffer): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new Uint8Array(data));
            controller.close();
        },
    });
}

function concatChunks(chunks: Uint8Array[]): ArrayBuffer {
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return result.buffer;
}
