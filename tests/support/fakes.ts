/**
 * In-memory stand-ins for Obsidian's vault adapter and the Proton Drive SDK
 * client, faithful enough to drive `SyncEngine` end to end.
 *
 * They model only what the engine relies on: paths, bytes, mtimes, node uids,
 * parents, revisions and the trash. Anything they get wrong about the real
 * APIs is a gap in these tests, so they stay deliberately plain.
 */
import { createHash } from 'node:crypto';

import { DriveEventType, NodeWithSameNameExistsValidationError } from '@protontech/drive-sdk';

import { TFile, TFolder, type App, type DataAdapter, type TAbstractFile } from 'obsidian';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function sha1(data: Uint8Array): string {
    return createHash('sha1').update(data).digest('hex');
}

function parentOf(path: string): string {
    const index = path.lastIndexOf('/');
    return index === -1 ? '' : path.slice(0, index);
}

// -- vault -------------------------------------------------------------------

export class MemoryVault {
    readonly files = new Map<string, { data: Uint8Array; mtime: number }>();
    readonly folders = new Set<string>();
    /** Operations that went through the Vault API or the file manager, rather than the adapter. */
    readonly viaVaultApi: [string, string][] = [];
    private clock = 1_000_000;

    write(path: string, text: string): void {
        this.ensureParents(path);
        this.files.set(path, { data: encoder.encode(text), mtime: this.tick() });
    }

    read(path: string): string | undefined {
        const file = this.files.get(path);
        return file ? decoder.decode(file.data) : undefined;
    }

    mkdir(path: string): void {
        this.ensureParents(`${path}/x`);
    }

    /** Rename a file or a folder, as Obsidian would. */
    rename(from: string, to: string): void {
        this.ensureParents(to);
        if (this.files.has(from)) {
            this.files.set(to, this.files.get(from)!);
            this.files.delete(from);
            return;
        }
        for (const path of [...this.files.keys()]) {
            if (path.startsWith(`${from}/`)) {
                this.files.set(`${to}${path.slice(from.length)}`, this.files.get(path)!);
                this.files.delete(path);
            }
        }
        for (const folder of [...this.folders]) {
            if (folder === from || folder.startsWith(`${from}/`)) {
                this.folders.delete(folder);
                this.folders.add(`${to}${folder.slice(from.length)}`);
            }
        }
    }

    remove(path: string): void {
        this.files.delete(path);
        for (const other of [...this.files.keys()]) {
            if (other.startsWith(`${path}/`)) {
                this.files.delete(other);
            }
        }
        for (const folder of [...this.folders]) {
            if (folder === path || folder.startsWith(`${path}/`)) {
                this.folders.delete(folder);
            }
        }
    }

    /** Notes only: the plugin's own files under the config folder are not part of what the user wrote. */
    notePaths(): string[] {
        return [...this.files.keys()].filter((path) => !path.startsWith('.obsidian/')).sort();
    }

    /**
     * Obsidian's app, as far as the plugin uses it: the adapter, and the parts
     * of the Vault API and file manager that work on the files Obsidian
     * indexes, which, as in Obsidian, are those with no dot-named segment.
     */
    app(): App {
        const vault = this;
        const adapter = this.adapter();
        const lookup = (path: string): TAbstractFile | null => {
            if (path.split('/').some((segment) => segment.startsWith('.'))) {
                return null;
            }
            if (vault.files.has(path)) {
                return Object.assign(new TFile(), { path });
            }
            return vault.folders.has(path) ? Object.assign(new TFolder(), { path }) : null;
        };
        return {
            vault: {
                adapter,
                configDir: '.obsidian',
                getAbstractFileByPath: lookup,
                async modifyBinary(file: TFile, data: ArrayBuffer, options?: { mtime?: number }) {
                    vault.viaVaultApi.push(['modify', file.path]);
                    await adapter.writeBinary(file.path, data, options);
                },
                async createBinary(path: string, data: ArrayBuffer, options?: { mtime?: number }) {
                    if (vault.files.has(path)) {
                        throw new Error('File already exists.');
                    }
                    vault.viaVaultApi.push(['create', path]);
                    await adapter.writeBinary(path, data, options);
                    return lookup(path);
                },
                async rename(file: TAbstractFile, to: string) {
                    vault.viaVaultApi.push(['rename', file.path]);
                    vault.rename(file.path, to);
                },
                async copy(file: TFile, to: string) {
                    vault.viaVaultApi.push(['copy', file.path]);
                    await adapter.copy(file.path, to);
                },
            },
            fileManager: {
                async trashFile(file: TAbstractFile) {
                    vault.viaVaultApi.push(['trash', file.path]);
                    vault.remove(file.path);
                },
            },
        } as unknown as App;
    }

    adapter(): DataAdapter {
        const vault = this;
        const adapter = {
            async list(folder: string) {
                const prefix = folder === '' ? '' : `${folder}/`;
                const direct = (path: string) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/');
                return {
                    files: [...vault.files.keys()].filter(direct),
                    folders: [...vault.folders].filter(direct),
                };
            },
            async stat(path: string) {
                const file = vault.files.get(path);
                if (file) {
                    return { type: 'file', size: file.data.byteLength, mtime: file.mtime, ctime: file.mtime };
                }
                return vault.folders.has(path) ? { type: 'folder', size: 0, mtime: 0, ctime: 0 } : null;
            },
            async exists(path: string) {
                return path === '' || vault.files.has(path) || vault.folders.has(path);
            },
            async read(path: string) {
                return decoder.decode(vault.mustRead(path));
            },
            async readBinary(path: string) {
                return vault.mustRead(path).slice().buffer;
            },
            async write(path: string, text: string) {
                vault.write(path, text);
            },
            async writeBinary(path: string, data: ArrayBuffer, options?: { mtime?: number }) {
                vault.ensureParents(path);
                vault.files.set(path, { data: new Uint8Array(data.slice(0)), mtime: options?.mtime ?? vault.tick() });
            },
            async mkdir(path: string) {
                vault.mkdir(path);
            },
            async rename(from: string, to: string) {
                vault.rename(from, to);
            },
            async copy(from: string, to: string) {
                vault.ensureParents(to);
                vault.files.set(to, { data: vault.mustRead(from).slice(), mtime: vault.tick() });
            },
            async trashSystem(path: string) {
                vault.remove(path);
                return true;
            },
            async trashLocal(path: string) {
                vault.remove(path);
            },
            async remove(path: string) {
                vault.remove(path);
            },
        };
        return adapter as unknown as DataAdapter;
    }

    private mustRead(path: string): Uint8Array {
        const file = this.files.get(path);
        if (!file) {
            throw new Error(`ENOENT: ${path}`);
        }
        return file.data;
    }

    private ensureParents(path: string): void {
        let parent = parentOf(path);
        while (parent !== '') {
            this.folders.add(parent);
            parent = parentOf(parent);
        }
    }

    private tick(): number {
        this.clock += 1000;
        return this.clock;
    }
}

// -- drive -------------------------------------------------------------------

type FakeRevision = { uid: string; data: Uint8Array; sha1: string; mtime?: Date; created: Date };

type FakeNode = {
    uid: string;
    parentUid: string | undefined;
    name: string;
    type: 'file' | 'folder';
    trashed: boolean;
    /** When it went to the trash, epoch ms. */
    trashedAt?: number;
    /** Its public link, if shared. */
    link?: { url: string; customPassword?: string; expirationTime?: Date };
    /** The active revision; `history` holds every revision, oldest first. */
    revision?: FakeRevision;
    history: FakeRevision[];
};

export const VOLUME_ROOT = 'volume-root';
export const SYNC_ROOT = 'sync-root';

export class FakeDrive {
    readonly nodes = new Map<string, FakeNode>();
    /** Makes node lookups fail, as a dropped connection mid-sync would. Listing child uids still works; resolving them is a lookup. */
    failLookups = false;
    /**
     * Runs while an upload of a new revision is in flight, after the plugin
     * decided to upload and before its revision lands: the window in which
     * another device can save the same file.
     */
    duringRevisionUpload: ((nodeUid: string) => void) | null = null;
    /** Runs while a download is in flight, before its bytes are handed over: the window in which the user can save the same note. */
    duringDownload: (() => void) | null = null;
    /** Like {@link duringRevisionUpload}, for the upload of a new file. */
    duringNewFileUpload: ((name: string) => void) | null = null;
    /** Makes the event feed fail after yielding this many events, once. */
    failEventsAfter: number | null = null;
    /** How many nodes have been looked up one by one or in batches. */
    lookups = 0;
    /**
     * Record an event for every change a client makes, as Drive does. Off by
     * default, where tests emit the events they mean to deliver themselves;
     * the multi-device simulation turns it on.
     */
    autoEvents = false;
    /** Folder listings so far: what a full walk of the tree costs. */
    listings = 0;
    /** Names of uploaded files, in the order their uploads completed. */
    readonly uploadLog: string[] = [];
    private readonly events: {
        type: DriveEventType;
        nodeUid: string;
        parentNodeUid: string | undefined;
        eventId: string;
        treeEventScopeId: string;
        isTrashed: boolean;
        isShared: boolean;
    }[] = [];

    /** Record that a node changed, as Drive's event feed would. */
    /** Called on every client change; emits only with {@link autoEvents}. */
    private changed(node: FakeNode, type: DriveEventType): void {
        if (this.autoEvents) {
            this.emit(node, type);
        }
    }

    emit(node: FakeNode, type: DriveEventType = DriveEventType.NodeUpdated): void {
        this.events.push({
            type,
            nodeUid: node.uid,
            parentNodeUid: node.parentUid,
            eventId: this.nextUid('event'),
            treeEventScopeId: 'scope',
            isTrashed: node.trashed,
            isShared: false,
        });
    }
    private counter = 0;

    constructor() {
        this.nodes.set(VOLUME_ROOT, this.folder(VOLUME_ROOT, undefined, 'root'));
        this.nodes.set(SYNC_ROOT, this.folder(SYNC_ROOT, VOLUME_ROOT, 'Vault'));
    }

    /** Live node at a path under the sync root. */
    at(path: string): FakeNode | undefined {
        let current = this.nodes.get(SYNC_ROOT)!;
        for (const segment of path.split('/')) {
            const next = this.liveChildren(current.uid).find((node) => node.name === segment);
            if (!next) {
                return undefined;
            }
            current = next;
        }
        return current;
    }

    text(path: string): string | undefined {
        const node = this.at(path);
        return node?.revision ? decoder.decode(node.revision.data) : undefined;
    }

    /** Every live file under the sync root, as paths. */
    filePaths(parentUid = SYNC_ROOT, prefix = ''): string[] {
        const paths: string[] = [];
        for (const child of this.liveChildren(parentUid)) {
            const path = prefix === '' ? child.name : `${prefix}/${child.name}`;
            if (child.type === 'folder') {
                paths.push(...this.filePaths(child.uid, path));
            } else {
                paths.push(path);
            }
        }
        return paths.sort();
    }

    notePaths(): string[] {
        return this.filePaths().filter((path) => !path.startsWith('.obsidian/'));
    }

    /** Simulate another device deleting a file: it goes to Drive's trash. */
    trash(path: string, at = Date.now()): void {
        const node = this.at(path);
        if (node) {
            node.trashed = true;
            node.trashedAt = at;
        }
    }

    /** A trashed node by its path, which {@link at} does not find. */
    trashedAt(path: string): FakeNode | undefined {
        const names = path.split('/');
        let parent: string | undefined = SYNC_ROOT;
        let found: FakeNode | undefined;
        for (const name of names) {
            found = [...this.nodes.values()].find((node) => node.parentUid === parent && node.name === name);
            parent = found?.uid;
        }
        return found;
    }

    /** Simulate another device writing a file. */
    put(path: string, text: string): FakeNode {
        const parentUid = this.ensureFolderPath(parentOf(path));
        const name = path.slice(path.lastIndexOf('/') + 1);
        const existing = this.liveChildren(parentUid).find((node) => node.name === name);
        const data = encoder.encode(text);
        const node = existing ?? {
            uid: this.nextUid('file'),
            parentUid,
            name,
            type: 'file' as const,
            trashed: false,
            history: [],
        };
        this.nodes.set(node.uid, node);
        this.addRevision(node, data, new Date(9_000_000 + this.counter));
        return node;
    }

    client() {
        const drive = this;
        return {
            async getMyFilesRootFolder() {
                return drive.entity(drive.nodes.get(VOLUME_ROOT)!);
            },
            async getNode(uid: string) {
                const node = drive.nodes.get(uid);
                if (!node) {
                    throw new Error('Node not found');
                }
                return drive.entity(node);
            },
            async *iterateNodes(uids: string[]) {
                drive.lookups += uids.length;
                if (drive.failLookups) {
                    throw new Error('network down');
                }
                for (const uid of uids) {
                    const node = drive.nodes.get(uid);
                    yield node ? drive.entity(node) : { missingUid: uid };
                }
            },
            async getNodeHierarchy(uid: string) {
                if (drive.failLookups) {
                    throw new Error('network down');
                }
                const chain = [];
                let node = drive.nodes.get(uid);
                while (node) {
                    chain.unshift(drive.entity(node));
                    node = node.parentUid ? drive.nodes.get(node.parentUid) : undefined;
                }
                return chain;
            },
            async *iterateFolderChildrenNodeUids(uid: string) {
                drive.listings++;
                for (const node of drive.nodes.values()) {
                    if (node.parentUid === uid) {
                        yield node.uid;
                    }
                }
            },
            async createFolder(parentUid: string, name: string) {
                drive.assertFree(parentUid, name);
                const node = drive.folder(drive.nextUid('folder'), parentUid, name);
                drive.nodes.set(node.uid, node);
                drive.changed(node, DriveEventType.NodeCreated);
                return drive.entity(node);
            },
            async getFileUploader(parentUid: string, name: string, metadata: UploadMetadata) {
                drive.assertFree(parentUid, name);
                return drive.uploader(metadata, () => {
                    // Checked again at commit time, as Drive does: the name
                    // may have been taken while the content was uploading.
                    drive.duringNewFileUpload?.(name);
                    drive.assertFree(parentUid, name);
                    const node: FakeNode = {
                        uid: drive.nextUid('file'),
                        parentUid,
                        name,
                        type: 'file',
                        trashed: false,
                        history: [],
                    };
                    drive.nodes.set(node.uid, node);
                    return node;
                });
            },
            async getFileRevisionUploader(nodeUid: string, metadata: UploadMetadata) {
                return drive.uploader(metadata, () => {
                    drive.duringRevisionUpload?.(nodeUid);
                    return drive.nodes.get(nodeUid)!;
                });
            },
            async getFileDownloader(uid: string) {
                return drive.downloader(drive.nodes.get(uid)!.revision!);
            },
            async getFileRevisionDownloader(revisionUid: string) {
                const revision = [...drive.nodes.values()]
                    .flatMap((node) => node.history)
                    .find((candidate) => candidate.uid === revisionUid);
                if (!revision) {
                    throw new Error('Revision not found');
                }
                return drive.downloader(revision);
            },
            async *iterateRevisions(uid: string) {
                for (const revision of drive.nodes.get(uid)!.history) {
                    yield {
                        uid: revision.uid,
                        creationTime: revision.created,
                        claimedDigests: { sha1: revision.sha1, sha1Verified: true },
                        claimedSize: revision.data.byteLength,
                        claimedModificationTime: revision.mtime,
                    };
                }
            },
            async *iterateTrashedNodeUids() {
                for (const node of drive.nodes.values()) {
                    if (node.trashed) {
                        yield node.uid;
                    }
                }
            },
            async *restoreNodes(uids: string[]) {
                for (const uid of uids) {
                    const node = drive.nodes.get(uid)!;
                    node.trashed = false;
                    delete node.trashedAt;
                    drive.changed(node, DriveEventType.NodeUpdated);
                    yield { uid, ok: true };
                }
            },
            async getSharingInfo(uid: string) {
                const link = drive.nodes.get(uid)!.link;
                return link ? { protonInvitations: [], nonProtonInvitations: [], members: [], urlAccess: drive.urlAccess(link) } : undefined;
            },
            async shareNode(uid: string, settings: { urlAccess: { customPassword?: string; expiration?: Date } }) {
                const node = drive.nodes.get(uid)!;
                node.link = {
                    url: node.link?.url ?? `https://drive.proton.me/urls/${uid}#generated`,
                    ...(settings.urlAccess.customPassword !== undefined && { customPassword: settings.urlAccess.customPassword }),
                    ...(settings.urlAccess.expiration !== undefined && { expirationTime: settings.urlAccess.expiration }),
                };
                return { protonInvitations: [], nonProtonInvitations: [], members: [], urlAccess: drive.urlAccess(node.link) };
            },
            async unshareNode(uid: string) {
                delete drive.nodes.get(uid)!.link;
            },
            async *trashNodes(uids: string[]) {
                for (const uid of uids) {
                    drive.nodes.get(uid)!.trashed = true;
                    drive.nodes.get(uid)!.trashedAt = Date.now();
                    drive.changed(drive.nodes.get(uid)!, DriveEventType.NodeUpdated);
                    yield { uid, ok: true };
                }
            },
            async renameNode(uid: string, name: string) {
                const node = drive.nodes.get(uid)!;
                drive.assertFree(node.parentUid!, name);
                node.name = name;
                drive.changed(node, DriveEventType.NodeUpdated);
                return drive.entity(node);
            },
            async *moveNodes(uids: string[], parentUid: string) {
                for (const uid of uids) {
                    const node = drive.nodes.get(uid)!;
                    drive.assertFree(parentUid, node.name);
                    node.parentUid = parentUid;
                    drive.changed(node, DriveEventType.NodeUpdated);
                    yield { uid, ok: true };
                }
            },
            async *iterateEvents(_scope: string, lastEventId?: string) {
                if (!lastEventId) {
                    // What the SDK does without a cursor: say where the feed is.
                    yield {
                        type: DriveEventType.FastForward,
                        treeEventScopeId: 'scope',
                        eventId: drive.events.at(-1)?.eventId ?? 'event-0',
                    };
                    return;
                }
                const start = drive.events.findIndex((event) => event.eventId === lastEventId) + 1;
                let yielded = 0;
                for (const event of drive.events.slice(start)) {
                    if (drive.failEventsAfter !== null && yielded >= drive.failEventsAfter) {
                        drive.failEventsAfter = null;
                        throw new Error('network down');
                    }
                    yield event;
                    yielded++;
                }
            },
        };
    }

    private uploader(metadata: UploadMetadata, target: () => FakeNode) {
        const drive = this;
        return {
            async uploadFromStream(
                stream: ReadableStream<Uint8Array>,
                _thumbnails: unknown,
                onProgress?: (bytes: number) => void,
            ) {
                const chunks: Uint8Array[] = [];
                const reader = stream.getReader();
                for (let read = await reader.read(); !read.done; read = await reader.read()) {
                    chunks.push(read.value);
                }
                const data = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
                let offset = 0;
                for (const chunk of chunks) {
                    data.set(chunk, offset);
                    offset += chunk.byteLength;
                }
                if (sha1(data) !== metadata.expectedSha1 || data.byteLength !== metadata.expectedSize) {
                    throw new Error('Integrity check failed');
                }
                onProgress?.(data.byteLength);
                const node = target();
                const created = node.revision === undefined;
                drive.addRevision(node, data, metadata.modificationTime);
                drive.uploadLog.push(node.name);
                drive.changed(node, created ? DriveEventType.NodeCreated : DriveEventType.NodeUpdated);
                return { completion: async () => ({ nodeUid: node.uid, nodeRevisionUid: node.revision!.uid }) };
            },
        };
    }

    private downloader(revision: FakeRevision) {
        const drive = this;
        return {
            downloadToStream(sink: WritableStream<Uint8Array>) {
                const done = (async () => {
                    drive.duringDownload?.();
                    const writer = sink.getWriter();
                    await writer.write(revision.data.slice());
                    await writer.close();
                })();
                return { completion: () => done, isDownloadCompleteWithSignatureIssues: () => false };
            },
        };
    }

    private addRevision(node: FakeNode, data: Uint8Array, mtime: Date | undefined): void {
        const revision: FakeRevision = {
            uid: this.nextUid('rev'),
            data,
            sha1: sha1(data),
            mtime,
            created: new Date(1_000_000_000 + this.counter * 1000),
        };
        node.history.push(revision);
        node.revision = revision;
    }

    private folder(uid: string, parentUid: string | undefined, name: string): FakeNode {
        return { uid, parentUid, name, type: 'folder', trashed: false, history: [] };
    }

    private entity(node: FakeNode) {
        return {
            uid: node.uid,
            parentUid: node.parentUid,
            name: { ok: true, value: node.name },
            type: node.type,
            trashTime: node.trashed ? new Date(node.trashedAt ?? Date.now()) : undefined,
            treeEventScopeId: 'scope',
            activeRevision: node.revision && {
                uid: node.revision.uid,
                claimedDigests: { sha1: node.revision.sha1 },
                claimedSize: node.revision.data.byteLength,
                claimedModificationTime: node.revision.mtime,
            },
        };
    }

    private urlAccess(link: NonNullable<FakeNode['link']>) {
        return { uid: 'link', creationTime: new Date(), role: 'viewer', numberOfInitializedDownloads: 0, ...link };
    }

    private liveChildren(parentUid: string): FakeNode[] {
        return [...this.nodes.values()].filter((node) => node.parentUid === parentUid && !node.trashed);
    }

    private assertFree(parentUid: string, name: string): void {
        const existing = this.liveChildren(parentUid).find((node) => node.name === name);
        if (existing) {
            throw new NodeWithSameNameExistsValidationError(`A node named "${name}" already exists`, 2500, existing.uid);
        }
    }

    ensureFolderPath(path: string): string {
        let uid = SYNC_ROOT;
        if (path === '') {
            return uid;
        }
        for (const segment of path.split('/')) {
            let next = this.liveChildren(uid).find((node) => node.name === segment);
            if (!next) {
                next = this.folder(this.nextUid('folder'), uid, segment);
                this.nodes.set(next.uid, next);
            }
            uid = next.uid;
        }
        return uid;
    }

    private nextUid(kind: string): string {
        this.counter++;
        return `${kind}-${this.counter}`;
    }
}

type UploadMetadata = { expectedSha1: string; expectedSize: number; modificationTime: Date };
