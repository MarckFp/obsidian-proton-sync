import { Platform, TFile, type App, type DataAdapter, type TAbstractFile } from 'obsidian';

import { sha1Hex } from '../util/hash';
import type { Logger } from '../util/logger';
import type { UploadSource } from './drive';
import { mediaTypeOf } from './media';
import { ancestorPaths, basename, joinPath, parentPath } from './paths';
import { imageThumbnails } from './thumbnails';
import type { LocalState, SyncBase } from './types';

/**
 * Above this size a file is streamed from and to disk instead of being held in
 * memory whole. Videos and large PDFs are the usual attachments that cross it;
 * reading a multi-gigabyte recording into a single buffer is how a renderer
 * process runs out of memory, and Node refuses buffers over 2 GiB outright.
 */
export const LARGE_FILE_BYTES = 32 * 1024 * 1024;

/** Read size when streaming. Matches Drive's block size, so each read feeds one block. */
const CHUNK_BYTES = 4 * 1024 * 1024;

/** How long a path stays marked as ours after we touch it; see {@link VaultIO.selfWrites}. */
const SELF_WRITE_HOLD_MS = 2000;

type DesktopModules = {
    fs: typeof import('fs').promises;
    createHash: typeof import('crypto').createHash;
};

let desktopModules: DesktopModules | null | undefined;

/**
 * Node's `fs` and `crypto`, which only exist on desktop.
 *
 * Loaded on first use rather than imported: on Android and iOS there is no
 * Node, and a top-level `require('fs')` would stop the plugin from loading at
 * all. Without them, files are read and written whole through the adapter.
 */
function nodeModules(): DesktopModules | null {
    if (desktopModules === undefined) {
        desktopModules = null;
        if (Platform.isDesktopApp) {
            try {
                desktopModules = {
                    fs: (window.require('fs') as typeof import('fs')).promises,
                    createHash: (window.require('crypto') as typeof import('crypto')).createHash,
                };
            } catch {
                // Not reachable from this renderer; stay on the adapter.
            }
        }
    }
    return desktopModules;
}

/** Where a download lands before it is complete. */
export type FileSink = {
    sink: WritableStream<Uint8Array>;
    /** Move the finished download into place and report the state it landed in. */
    commit: (mtime?: number) => Promise<LocalState>;
    /** Throw the partial download away. */
    abort: () => Promise<void>;
};

/**
 * The vault side of the sync: listing, reading and writing files.
 *
 * Changes to files Obsidian indexes go through its Vault API, as Obsidian's
 * plugin guidelines ask: it runs file operations one after another and keeps
 * its cache in step, and deleting through `FileManager.trashFile` honours the
 * user's "Deleted files" setting. Paths it does not index, the config folder
 * and anything else whose name starts with a dot, go through the adapter, the
 * only API that can reach them. Reads and listings use the adapter
 * throughout, since only it sees those paths and reports mtimes.
 */
export class VaultIO {
    private readonly adapter: DataAdapter;

    /**
     * Paths this plugin is currently writing.
     *
     * Obsidian reports our own writes back through the same vault events a user
     * edit produces. Without this, every download would immediately look like a
     * local change and be uploaded straight back — a loop that ends in an
     * unbounded chain of revisions.
     *
     * Counted rather than a plain set, so that two overlapping operations on
     * the same path cannot release each other's hold early.
     */
    private readonly selfWrites = new Map<string, number>();

    constructor(
        private readonly app: App,
        private readonly logger: Logger,
        /**
         * Where large downloads are written until complete: inside the
         * plugin's own folder, which never syncs, so a download cut short by a
         * crash leaves nothing in the vault and is swept at the next start;
         * see {@link sweepDownloads}. Null puts them beside their target.
         */
        private readonly downloadsDir: string | null = null,
    ) {
        this.adapter = app.vault.adapter;
    }

    /** The file or folder at `path` as Obsidian indexes it, or null for a path it does not index. */
    private indexed(path: string): TAbstractFile | null {
        return this.app.vault.getAbstractFileByPath?.(path) ?? null;
    }

    /** Remove downloads left unfinished by an earlier run. */
    async sweepDownloads(): Promise<void> {
        if (this.downloadsDir === null || !(await this.adapter.exists(this.downloadsDir))) {
            return;
        }
        try {
            const listing = await this.adapter.list(this.downloadsDir);
            for (const file of listing.files) {
                await this.adapter.remove(file);
            }
            if (listing.files.length > 0) {
                this.logger.info(`Removed ${listing.files.length} unfinished download(s) from an earlier session`);
            }
        } catch (error) {
            this.logger.warn('Could not clear unfinished downloads', error);
        }
    }

    /**
     * Remove partial downloads left beside their targets by versions that
     * wrote them there, among the files of a vault listing.
     */
    async removeLegacyPartialDownloads(files: string[]): Promise<void> {
        for (const path of files) {
            if (/^\.[^/]*\.proton-sync\.tmp$/.test(basename(path))) {
                try {
                    await this.adapter.remove(path);
                    this.logger.info(`Removed "${path}", a download left unfinished by an older version`);
                } catch (error) {
                    this.logger.debug(`Could not remove "${path}"`, error);
                }
            }
        }
    }

    /** True for a path we are writing, or one inside a folder we are moving. */
    isSelfWrite(path: string): boolean {
        return this.selfWrites.has(path) || ancestorPaths(path).some((ancestor) => this.selfWrites.has(ancestor));
    }

    /**
     * Every file and folder in the vault, as vault-relative paths.
     *
     * Folders are returned as well as files so that an empty folder the user
     * created still reaches the other devices — it has no file to carry it.
     */
    async list(
        shouldDescend: (folderPath: string) => boolean,
        from = '',
    ): Promise<{ files: string[]; folders: string[] }> {
        const files: string[] = [];
        const folders: string[] = [];
        const queue = [from];

        while (queue.length > 0) {
            const folder = queue.pop()!;
            let listing;
            try {
                listing = await this.adapter.list(folder);
            } catch (error) {
                this.logger.warn(`Could not list "${folder}"`, error);
                continue;
            }
            files.push(...listing.files);
            for (const subfolder of listing.folders) {
                if (shouldDescend(subfolder)) {
                    folders.push(subfolder);
                    queue.push(subfolder);
                }
            }
        }

        return { files, folders };
    }

    async exists(path: string): Promise<boolean> {
        return this.adapter.exists(path);
    }

    /**
     * Whether this exact path exists, letter case included.
     *
     * `exists` goes through the filesystem, which on Windows, macOS and iOS
     * answers yes for `note.md` when only `Note.md` is there. Renaming one to
     * the other is legitimate; the parent listing tells the two apart.
     */
    async existsExactly(path: string): Promise<boolean> {
        const parent = parentPath(path);
        if (parent !== '' && !(await this.adapter.exists(parent))) {
            return false;
        }
        const listing = await this.adapter.list(parent);
        return listing.files.includes(path) || listing.folders.includes(path);
    }

    /** Size and mtime, without reading the content. Undefined for a missing path or a folder. */
    async stat(path: string): Promise<{ size: number; mtime: number } | undefined> {
        const stat = await this.adapter.stat(path);
        return stat && stat.type === 'file' ? { size: stat.size, mtime: stat.mtime } : undefined;
    }

    /** Whether a folder holds any file at all, however deep. Empty subfolders do not count. */
    async hasFiles(path: string): Promise<boolean> {
        const listing = await this.adapter.list(path);
        if (listing.files.length > 0) {
            return true;
        }
        for (const folder of listing.folders) {
            if (await this.hasFiles(folder)) {
                return true;
            }
        }
        return false;
    }

    /** Copy a file within the vault, without reading it into memory. */
    async copy(fromPath: string, toPath: string): Promise<void> {
        this.holdSelfWrite(toPath);
        try {
            await this.ensureFolder(parentPath(toPath));
            const file = this.indexed(fromPath);
            if (file instanceof TFile && !isHidden(toPath)) {
                await this.app.vault.copy(file, toPath);
            } else {
                await this.adapter.copy(fromPath, toPath);
            }
        } finally {
            this.releaseSelfWrite(toPath);
        }
    }

    /**
     * Current local state of a path, or undefined if it is gone.
     *
     * `knownBase` is an optimisation, not a shortcut: when size and mtime still
     * match what the last sync recorded, the file cannot have changed in a way
     * that matters and the digest is reused instead of re-reading the bytes.
     * A full vault scan on a large vault is otherwise dominated by hashing.
     */
    async getState(
        path: string,
        knownBase?: Pick<SyncBase, 'hash' | 'size' | 'localMtime'>,
    ): Promise<LocalState | undefined> {
        const stat = await this.adapter.stat(path);
        if (!stat || stat.type !== 'file') {
            return undefined;
        }

        if (knownBase && knownBase.size === stat.size && knownBase.localMtime === stat.mtime) {
            return { hash: knownBase.hash, size: stat.size, mtime: stat.mtime };
        }

        const fullPath = this.fullPath(path);
        if (stat.size > LARGE_FILE_BYTES && fullPath) {
            return { hash: await hashFile(fullPath), size: stat.size, mtime: stat.mtime };
        }
        const data = await this.adapter.readBinary(path);
        return { hash: await sha1Hex(data), size: stat.size, mtime: stat.mtime };
    }

    /**
     * Everything an upload needs, from one read of the file.
     *
     * The digest and size sent to Drive are computed from the very bytes being
     * sent, not taken from an earlier scan: an attachment still being written
     * by another program, or a note saved again mid-sync, would otherwise go up
     * with a digest that does not match its content, which Drive rejects.
     * Returns the state the upload describes, which is what the sync base must
     * record.
     */
    async openUpload(path: string): Promise<{ source: UploadSource; local: LocalState }> {
        const stat = await this.adapter.stat(path);
        if (!stat || stat.type !== 'file') {
            throw new Error(`"${path}" no longer exists`);
        }
        const mediaType = mediaTypeOf(path);
        const fullPath = this.fullPath(path);

        if (stat.size > LARGE_FILE_BYTES && fullPath) {
            // Hashed in a first pass because the SDK wants the digest up front.
            // If the file changes between the passes, Drive's integrity check
            // fails the upload and the next sync retries it.
            const hash = await hashFile(fullPath);
            return {
                source: {
                    mediaType,
                    size: stat.size,
                    sha1: hash,
                    modificationTime: new Date(stat.mtime),
                    thumbnails: [],
                    stream: () => streamFile(fullPath),
                    replay: false,
                },
                local: { hash, size: stat.size, mtime: stat.mtime },
            };
        }

        const data = await this.adapter.readBinary(path);
        const hash = await sha1Hex(data);
        return {
            source: {
                mediaType,
                size: data.byteLength,
                sha1: hash,
                modificationTime: new Date(stat.mtime),
                // Thumbnails are a convenience for Drive's own apps, which make
                // their own when missing; on a phone, decoding every image to
                // make one costs battery and time for nothing the user sees.
                thumbnails: Platform.isMobile ? [] : await imageThumbnails(data, mediaType),
                stream: () => streamOf(data),
                replay: true,
            },
            local: { hash, size: data.byteLength, mtime: stat.mtime },
        };
    }

    /**
     * A destination for a streamed download.
     *
     * Bytes go to a hidden file beside the target and are renamed into place
     * only once the download has completed and verified, so an interrupted
     * transfer never leaves a truncated video where the real one was. The dot
     * prefix keeps Obsidian from indexing the partial file, and the `.tmp`
     * suffix keeps the sync from picking it up.
     *
     * Returns null on mobile, or when the vault is not on a local filesystem,
     * in which case the caller downloads into memory instead.
     */
    async openDownload(path: string): Promise<FileSink | null> {
        const target = this.fullPath(path);
        const tempPath =
            this.downloadsDir === null
                ? joinPath(parentPath(path), `.${basename(path)}.proton-sync.tmp`)
                : joinPath(this.downloadsDir, `${crypto.randomUUID()}.tmp`);
        const temp = this.fullPath(tempPath);
        if (!target || !temp) {
            return null;
        }

        const { fs, createHash } = nodeModules()!;
        await this.ensureFolder(parentPath(path));
        await this.ensureFolder(parentPath(tempPath));
        const handle = await fs.open(temp, 'w');
        const digest = createHash('sha1');
        let size = 0;
        let closed = false;
        const close = async () => {
            if (!closed) {
                closed = true;
                await handle.close();
            }
        };

        const sink = new WritableStream<Uint8Array>({
            async write(chunk) {
                let offset = 0;
                while (offset < chunk.byteLength) {
                    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
                    offset += bytesWritten;
                }
                digest.update(chunk);
                size += chunk.byteLength;
            },
        });

        return {
            sink,
            commit: async (mtime?: number) => {
                await close();
                this.holdSelfWrite(path);
                try {
                    if (mtime !== undefined) {
                        await fs.utimes(temp, new Date(), new Date(mtime));
                    }
                    await moveFile(fs, temp, target);
                    const stat = await this.adapter.stat(path);
                    return {
                        hash: digest.digest('hex'),
                        size: stat?.size ?? size,
                        mtime: stat?.mtime ?? mtime ?? Date.now(),
                    };
                } finally {
                    this.releaseSelfWrite(path);
                }
            },
            abort: async () => {
                await close().catch(() => undefined);
                await fs.unlink(temp).catch(() => undefined);
            },
        };
    }

    /**
     * Move a file or folder within the vault, to follow a rename made on
     * another device.
     *
     * Goes through the adapter, not `FileManager.renameFile`: the latter would
     * also rewrite every link to the file, but the device that did the rename
     * has already rewritten them, and those edits arrive through the sync.
     * Rewriting them here as well would turn every remote rename into a
     * conflict on each linking note.
     */
    async rename(fromPath: string, toPath: string): Promise<void> {
        this.holdSelfWrite(fromPath);
        this.holdSelfWrite(toPath);
        try {
            await this.ensureFolder(parentPath(toPath));
            // `Vault.rename`, unlike `FileManager.renameFile`, leaves links alone.
            const file = this.indexed(fromPath);
            if (file && !isHidden(toPath)) {
                await this.app.vault.rename(file, toPath);
            } else {
                await this.adapter.rename(fromPath, toPath);
            }
        } finally {
            this.releaseSelfWrite(fromPath);
            this.releaseSelfWrite(toPath);
        }
    }

    async readText(path: string): Promise<string> {
        return this.adapter.read(path);
    }

    /**
     * Write a file, creating any missing folders, and report the state it
     * landed in.
     *
     * The returned stat is read back rather than assumed: Obsidian may not honour
     * the requested mtime exactly, and the engine has to record the mtime the
     * file actually has or its next scan will see a spurious local change.
     */
    async writeBinary(path: string, data: ArrayBuffer, mtime?: number): Promise<LocalState> {
        this.holdSelfWrite(path);
        try {
            await this.ensureFolder(parentPath(path));
            await this.writeThroughVault(path, data, mtime !== undefined ? { mtime } : undefined);

            const stat = await this.adapter.stat(path);
            return {
                hash: await sha1Hex(data),
                size: stat?.size ?? data.byteLength,
                mtime: stat?.mtime ?? mtime ?? Date.now(),
            };
        } finally {
            this.releaseSelfWrite(path);
        }
    }

    /**
     * Write through the Vault API where Obsidian indexes the path, which
     * serialises it with Obsidian's own file operations; through the adapter
     * for paths it does not index. A file on disk that the index has not caught
     * up with yet, which `createBinary` would refuse, also goes through the
     * adapter.
     */
    private async writeThroughVault(path: string, data: ArrayBuffer, options?: { mtime: number }): Promise<void> {
        const file = this.indexed(path);
        if (file instanceof TFile) {
            await this.app.vault.modifyBinary(file, data, options);
            return;
        }
        if (!isHidden(path) && !file && !(await this.adapter.exists(path))) {
            try {
                await this.app.vault.createBinary(path, data, options);
                return;
            } catch (error) {
                this.logger.debug(`Could not create "${path}" through the vault; writing it directly`, error);
            }
        }
        await this.adapter.writeBinary(path, data, options);
    }

    async ensureFolder(path: string): Promise<void> {
        if (path === '') {
            return;
        }
        for (const folder of [...ancestorPaths(path), path]) {
            if (!(await this.adapter.exists(folder))) {
                try {
                    await this.adapter.mkdir(folder);
                } catch (error) {
                    // A concurrent write may have created it first.
                    if (!(await this.adapter.exists(folder))) {
                        throw error;
                    }
                }
            }
        }
    }

    /**
     * Delete a path, as a deletion arriving from another device.
     *
     * A file Obsidian indexes goes where the user chose for deleted files, as
     * if they had deleted it themselves. Anything else, such as a settings file
     * in the config folder, goes to the system trash where the OS can still
     * recover it, falling back to the vault's own trash, and to a hard delete
     * only when neither is available.
     */
    async trash(path: string): Promise<void> {
        this.holdSelfWrite(path);
        try {
            // Where Obsidian indexes it, the way the user chose in Files and
            // links → Deleted files: system trash, the vault's .trash, or gone.
            const file = this.indexed(path);
            if (file) {
                await this.app.fileManager.trashFile(file);
                return;
            }
            await this.adapter.trashSystem(path).then(async (trashed) => {
                if (!trashed) {
                    await this.adapter.trashLocal(path);
                }
            });
        } catch (error) {
            this.logger.warn(`Could not trash "${path}", removing it instead`, error);
            await this.adapter.remove(path);
        } finally {
            this.releaseSelfWrite(path);
        }
    }

    private holdSelfWrite(path: string): void {
        this.selfWrites.set(path, (this.selfWrites.get(path) ?? 0) + 1);
    }

    /**
     * Held a little past the end of the operation, so the vault event for it,
     * which Obsidian dispatches asynchronously, is still recognised as ours.
     */
    private releaseSelfWrite(path: string): void {
        window.setTimeout(() => {
            const count = (this.selfWrites.get(path) ?? 1) - 1;
            if (count <= 0) {
                this.selfWrites.delete(path);
            } else {
                this.selfWrites.set(path, count);
            }
        }, SELF_WRITE_HOLD_MS);
    }

    /** Absolute path on disk, when the vault lives on a local filesystem that Node can reach. */
    private fullPath(path: string): string | null {
        if (!nodeModules()) {
            return null;
        }
        const adapter = this.adapter as DataAdapter & { getFullPath?: (normalizedPath: string) => string };
        return typeof adapter.getFullPath === 'function' ? adapter.getFullPath(path) : null;
    }
}

async function* readChunks(fullPath: string): AsyncGenerator<Uint8Array, void> {
    const handle = await nodeModules()!.fs.open(fullPath, 'r');
    try {
        while (true) {
            const buffer = new Uint8Array(CHUNK_BYTES);
            const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, null);
            if (bytesRead === 0) {
                return;
            }
            yield bytesRead === CHUNK_BYTES ? buffer : buffer.slice(0, bytesRead);
        }
    } finally {
        await handle.close();
    }
}

async function hashFile(fullPath: string): Promise<string> {
    const digest = nodeModules()!.createHash('sha1');
    for await (const chunk of readChunks(fullPath)) {
        digest.update(chunk);
    }
    return digest.digest('hex');
}

/**
 * A file as a web stream, built on the renderer's own `ReadableStream` rather
 * than Node's `Readable.toWeb`: the SDK pipes it through the renderer's stream
 * classes, which do not accept Node's implementation of the same interface.
 */
function streamFile(fullPath: string): ReadableStream<Uint8Array> {
    const chunks = readChunks(fullPath);
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            const { value, done } = await chunks.next();
            if (done) {
                controller.close();
            } else {
                controller.enqueue(value);
            }
        },
        async cancel() {
            await chunks.return(undefined);
        },
    });
}

function streamOf(data: ArrayBuffer): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new Uint8Array(data));
            controller.close();
        },
    });
}

/** Whether Obsidian leaves a path out of its index: anything inside a folder, or named, with a leading dot. */
function isHidden(path: string): boolean {
    return path.split('/').some((segment) => segment.startsWith('.'));
}

/**
 * Move a finished download into place. A rename where it can be, which is
 * atomic; a copy and delete when the temporary file sits on another
 * filesystem than the target, as a vault folder that is a link elsewhere can.
 */
async function moveFile(fs: DesktopModules['fs'], from: string, to: string): Promise<void> {
    try {
        await fs.rename(from, to);
    } catch (error) {
        if ((error as { code?: string }).code !== 'EXDEV') {
            throw error;
        }
        await fs.copyFile(from, to);
        await fs.unlink(from);
    }
}
