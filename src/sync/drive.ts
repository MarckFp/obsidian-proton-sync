import {
    NodeType,
    type FileDownloader,
    type NodeEntity,
    type ProtonDriveClient,
    type Revision,
    type Thumbnail,
} from '@protontech/drive-sdk';

import type { Logger } from '../util/logger';
import { joinPath } from './paths';
import type { RemoteState } from './types';

/** A snapshot of the Drive subtree the vault maps onto. */
export type RemoteTree = {
    /** Vault-relative path to the file's remote state. */
    files: Map<string, RemoteState>;
    /** Vault-relative path to the folder's node uid, excluding the root. */
    folders: Map<string, string>;
    /** Node uid to vault-relative path, for files and folders alike. */
    nodePaths: Map<string, string>;
    /** Event scope covering the tree, used to subscribe to remote changes. */
    treeEventScopeId: string;
    /** Paths whose name could not be decrypted, and which were skipped. */
    skipped: string[];
};

/**
 * How many child uids are resolved per `iterateNodes` call. Large enough that
 * the SDK's own batching (30 per request) runs at full width, small enough
 * that `hasLiveChildren` can stop early without loading a whole big folder.
 */
const CHILD_BATCH_SIZE = 90;

/**
 * The children of a folder, as nodes.
 *
 * The SDK deprecated `iterateFolderChildren` in favour of listing uids and
 * resolving them with `iterateNodes`, which serves fresh nodes from its cache
 * and batch-loads the rest, the same work the old call did internally. A child
 * that disappears between listing and loading comes back as missing and is
 * skipped: it is no longer in the folder.
 */
export async function* iterateChildNodes(
    client: Pick<ProtonDriveClient, 'iterateFolderChildrenNodeUids' | 'iterateNodes'>,
    parentUid: string,
    filterOptions?: { type?: NodeType },
): AsyncGenerator<NodeEntity> {
    let batch: string[] = [];
    for await (const uid of client.iterateFolderChildrenNodeUids(parentUid, filterOptions)) {
        batch.push(uid);
        if (batch.length >= CHILD_BATCH_SIZE) {
            yield* resolveNodes(client, batch);
            batch = [];
        }
    }
    if (batch.length > 0) {
        yield* resolveNodes(client, batch);
    }
}

async function* resolveNodes(client: Pick<ProtonDriveClient, 'iterateNodes'>, uids: string[]): AsyncGenerator<NodeEntity> {
    for await (const node of client.iterateNodes(uids)) {
        if (!('missingUid' in node)) {
            yield node;
        }
    }
}

/**
 * The Drive side of the sync, wrapping `ProtonDriveClient` in the vocabulary
 * the engine uses: vault-relative paths rather than node uids.
 */
export class DriveIO {
    constructor(
        private readonly client: ProtonDriveClient,
        private readonly logger: Logger,
    ) {}

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
            nodePaths: new Map(),
            treeEventScopeId: root.treeEventScopeId,
            skipped: [],
        };

        const listFolder = async (folder: { uid: string; path: string }, found: (subfolder: { uid: string; path: string }) => void) => {
            for await (const child of iterateChildNodes(this.client, folder.uid)) {
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
                tree.nodePaths.set(child.uid, path);

                if (child.type === NodeType.Folder) {
                    tree.folders.set(path, child.uid);
                    if (shouldDescend(path)) {
                        found({ uid: child.uid, path });
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
        };

        await walkConcurrently({ uid: rootUid, path: '' }, LIST_CONCURRENCY, listFolder);
        return tree;
    }

    /**
     * Fetch several nodes at once. A uid maps to null when Drive reports that
     * the node does not exist (or is no longer visible to this account), which
     * is a definite answer; a failed request throws instead.
     */
    async lookupNodes(nodeUids: string[]): Promise<Map<string, NodeEntity | null>> {
        const found = new Map<string, NodeEntity | null>();
        for (let i = 0; i < nodeUids.length; i += LOOKUP_BATCH) {
            for await (const node of this.client.iterateNodes(nodeUids.slice(i, i + LOOKUP_BATCH))) {
                if ('missingUid' in node) {
                    found.set(node.missingUid, null);
                } else {
                    found.set(node.uid, node);
                }
            }
        }
        return found;
    }

    /**
     * Where a node is now, relative to the sync root.
     *
     * The distinction that matters is between "gone" and "not where we
     * looked". Only the former may delete a file from the vault; treating a
     * file that merely moved, or one whose lookup failed, as deleted is how a
     * sync tool destroys notes that were never lost. Errors propagate, so the
     * caller can leave the path alone until a lookup succeeds.
     */
    async locate(nodeUid: string, rootUid: string): Promise<NodeLocation> {
        const node = (await this.lookupNodes([nodeUid])).get(nodeUid);
        if (!node || node.trashTime !== undefined) {
            return { kind: 'deleted' };
        }

        const hierarchy = await this.client.getNodeHierarchy(nodeUid);
        // Trashing a folder trashes only the folder node; everything inside
        // it keeps a clean record of its own, so the ancestors have to be
        // checked too.
        if (hierarchy.some((ancestor) => ancestor.trashTime !== undefined)) {
            return { kind: 'deleted' };
        }
        const rootIndex = hierarchy.findIndex((ancestor) => ancestor.uid === rootUid);
        if (rootIndex === -1) {
            return { kind: 'outside' };
        }

        const segments: string[] = [];
        for (const ancestor of hierarchy.slice(rootIndex + 1)) {
            const name = nodeName(ancestor);
            if (name === undefined) {
                return { kind: 'unknown' };
            }
            segments.push(name);
        }
        return { kind: 'at', path: segments.join('/'), node };
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
        for await (const child of iterateChildNodes(this.client, parentUid)) {
            if (child.trashTime !== undefined) {
                continue;
            }
            const name = nodeName(child);
            if (name !== undefined) {
                yield { node: child, name };
            }
        }
    }

    /**
     * Whether a folder still holds anything, trashed items aside. Children
     * whose names cannot be decrypted count: they are still someone's files.
     */
    async hasLiveChildren(folderUid: string): Promise<boolean> {
        for await (const child of iterateChildNodes(this.client, folderUid)) {
            if (child.trashTime === undefined) {
                return true;
            }
        }
        return false;
    }

    /** The node's decrypted name, or undefined when it could not be decrypted. */
    nameOf(node: NodeEntity): string | undefined {
        return nodeName(node);
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
        source: UploadSource,
        signal?: AbortSignal,
        onProgress?: (bytes: number) => void,
    ): Promise<{ nodeUid: string; revisionUid: string }> {
        return this.withThumbnailFallback(source, async (stream, thumbnails) => {
            const uploader = await this.client.getFileUploader(parentUid, name, uploadMetadata(source), signal);
            const controller = await uploader.uploadFromStream(stream, thumbnails, onProgress);
            const { nodeUid, nodeRevisionUid } = await controller.completion();
            return { nodeUid, revisionUid: nodeRevisionUid };
        });
    }

    async uploadRevision(
        nodeUid: string,
        source: UploadSource,
        signal?: AbortSignal,
        onProgress?: (bytes: number) => void,
    ): Promise<{ nodeUid: string; revisionUid: string }> {
        return this.withThumbnailFallback(source, async (stream, thumbnails) => {
            const uploader = await this.client.getFileRevisionUploader(nodeUid, uploadMetadata(source), signal);
            const controller = await uploader.uploadFromStream(stream, thumbnails, onProgress);
            const result = await controller.completion();
            return { nodeUid: result.nodeUid, revisionUid: result.nodeRevisionUid };
        });
    }

    /**
     * Run an upload with the source's thumbnails, and once more without them
     * if that fails.
     *
     * A thumbnail is a convenience for Drive's own apps, generated locally by
     * the browser's image decoder; an image Drive refuses a thumbnail for must
     * still reach Drive. Only possible for sources held in memory, since a file
     * stream cannot be replayed.
     */
    private async withThumbnailFallback<T>(
        source: UploadSource,
        run: (stream: ReadableStream<Uint8Array>, thumbnails: Thumbnail[]) => Promise<T>,
    ): Promise<T> {
        if (source.thumbnails.length === 0 || !source.replay) {
            return run(source.stream(), source.thumbnails);
        }
        try {
            return await run(source.stream(), source.thumbnails);
        } catch (error) {
            this.logger.debug('Upload with a thumbnail failed; retrying without one', error);
            return run(source.stream(), []);
        }
    }

    /** Download the active revision into memory. Meant for files of modest size. */
    async downloadFile(nodeUid: string, signal?: AbortSignal, onProgress?: (bytes: number) => void): Promise<ArrayBuffer> {
        return collect((sink) => this.downloadTo(nodeUid, sink, signal, onProgress));
    }

    /** Stream the active revision into `sink`, so large files never sit in memory whole. */
    async downloadTo(
        nodeUid: string,
        sink: WritableStream<Uint8Array>,
        signal?: AbortSignal,
        onProgress?: (bytes: number) => void,
    ): Promise<void> {
        await completeDownload(await this.client.getFileDownloader(nodeUid, signal), sink, onProgress);
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
    async downloadRevision(
        revisionUid: string,
        signal?: AbortSignal,
        onProgress?: (bytes: number) => void,
    ): Promise<ArrayBuffer> {
        return collect((sink) => this.downloadRevisionTo(revisionUid, sink, signal, onProgress));
    }

    async downloadRevisionTo(
        revisionUid: string,
        sink: WritableStream<Uint8Array>,
        signal?: AbortSignal,
        onProgress?: (bytes: number) => void,
    ): Promise<void> {
        await completeDownload(await this.client.getFileRevisionDownloader(revisionUid, signal), sink, onProgress);
    }

    /**
     * Revisions of a node created after `afterUid` and before `beforeUid`,
     * oldest first. Empty when either is no longer in the history.
     *
     * Drive has no conditional upload: a new revision replaces whatever is
     * active, even if another device uploaded one a moment earlier. Listing
     * what landed between the revision an upload started from and the one it
     * produced is how the engine notices that it has just superseded someone
     * else's edit.
     */
    async revisionsBetween(nodeUid: string, afterUid: string, beforeUid: string): Promise<Revision[]> {
        const revisions: Revision[] = [];
        for await (const revision of this.client.iterateRevisions(nodeUid)) {
            revisions.push(revision);
        }
        revisions.sort((a, b) => a.creationTime.getTime() - b.creationTime.getTime());
        const start = revisions.findIndex((revision) => revision.uid === afterUid);
        const end = revisions.findIndex((revision) => revision.uid === beforeUid);
        return start === -1 || end <= start ? [] : revisions.slice(start + 1, end);
    }

    /** Every revision of a node, newest first, asked of Drive itself. */
    async listRevisions(nodeUid: string): Promise<Revision[]> {
        const revisions: Revision[] = [];
        for await (const revision of this.client.iterateRevisions(nodeUid)) {
            revisions.push(revision);
        }
        return revisions.sort((a, b) => b.creationTime.getTime() - a.creationTime.getTime());
    }

    /**
     * The newest revision of a node, asked of Drive itself. Revision listings
     * are not served from the SDK's cache, so this sees an upload another
     * device made a moment ago, which a cached node would not.
     */
    async latestRevisionUid(nodeUid: string): Promise<string | null> {
        let latest: Revision | null = null;
        for await (const revision of this.client.iterateRevisions(nodeUid)) {
            if (!latest || revision.creationTime.getTime() >= latest.creationTime.getTime()) {
                latest = revision;
            }
        }
        return latest?.uid ?? null;
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

    /** The id of the newest event in a scope, to start following it from now. */
    async latestEventId(treeEventScopeId: string): Promise<string | null> {
        // Without a cursor the SDK answers with a single fast-forward event
        // that carries the latest id.
        for await (const event of this.client.iterateEvents(treeEventScopeId)) {
            return event.eventId;
        }
        return null;
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

/** Nodes per `iterateNodes` request. */
const LOOKUP_BATCH = 100;

/**
 * Folders listed at once while walking the tree. A listing is a few small
 * requests, so a handful in flight cuts a first sync of a deep vault several
 * times over, while staying far from what Proton's rate limits would notice.
 */
const LIST_CONCURRENCY = 4;

/**
 * Breadth-first walk with up to `concurrency` folders in flight. `visit`
 * reports each subfolder to descend into; the walk ends when every reported
 * folder has been visited, and stops at the first failure.
 */
export async function walkConcurrently<T>(
    root: T,
    concurrency: number,
    visit: (folder: T, found: (subfolder: T) => void) => Promise<void>,
): Promise<void> {
    const queue: T[] = [root];
    let active = 0;
    let failed = false;

    await new Promise<void>((resolve, reject) => {
        const pump = () => {
            if (failed) {
                return;
            }
            if (queue.length === 0 && active === 0) {
                resolve();
                return;
            }
            while (active < Math.max(1, concurrency) && queue.length > 0) {
                const folder = queue.shift()!;
                active++;
                visit(folder, (subfolder) => queue.push(subfolder)).then(
                    () => {
                        active--;
                        pump();
                    },
                    (error: unknown) => {
                        failed = true;
                        reject(error instanceof Error ? error : new Error(String(error)));
                    },
                );
            }
        };
        pump();
    });
}

export type NodeLocation =
    /** The node, or a folder above it, is in the trash or no longer exists. */
    | { kind: 'deleted' }
    /** Alive, but no longer under the sync root. */
    | { kind: 'outside' }
    /** Somewhere in its path a name could not be decrypted. */
    | { kind: 'unknown' }
    | { kind: 'at'; path: string; node: NodeEntity };

/** What an upload needs to know about the bytes it is sending. */
export type UploadSource = {
    mediaType: string;
    size: number;
    sha1: string;
    modificationTime: Date;
    thumbnails: Thumbnail[];
    /** A fresh stream of the content. */
    stream: () => ReadableStream<Uint8Array>;
    /** Whether `stream` may be called more than once. */
    replay: boolean;
};

function uploadMetadata(source: UploadSource) {
    return {
        mediaType: source.mediaType,
        expectedSize: source.size,
        expectedSha1: source.sha1,
        modificationTime: source.modificationTime,
    };
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

/**
 * Run a download to completion.
 *
 * A download can finish and still throw, when the author's signature does not
 * verify. The bytes are intact but their origin is unproven, so they are
 * refused rather than silently written into the vault under the user's own
 * name.
 */
async function completeDownload(
    downloader: FileDownloader,
    sink: WritableStream<Uint8Array>,
    onProgress?: (bytes: number) => void,
): Promise<void> {
    const controller = downloader.downloadToStream(sink, onProgress);
    try {
        await controller.completion();
    } catch (error) {
        if (controller.isDownloadCompleteWithSignatureIssues()) {
            throw new Error(
                'Downloaded content could not be verified as authentic; refusing to write it to the vault',
                { cause: error },
            );
        }
        throw error;
    }
}

/** Run a download into memory. */
async function collect(download: (sink: WritableStream<Uint8Array>) => Promise<void>): Promise<ArrayBuffer> {
    const chunks: Uint8Array[] = [];
    await download(
        new WritableStream<Uint8Array>({
            write(chunk) {
                chunks.push(chunk);
            },
        }),
    );
    return concatChunks(chunks);
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
