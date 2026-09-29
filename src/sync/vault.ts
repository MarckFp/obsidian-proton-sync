import type { App, DataAdapter } from 'obsidian';

import { sha1Hex } from '../util/hash';
import type { Logger } from '../util/logger';
import { ancestorPaths, parentPath } from './paths';
import type { LocalState, SyncBase } from './types';

/**
 * The vault side of the sync: listing, reading and writing files through
 * Obsidian's adapter.
 *
 * Everything goes through `vault.adapter` rather than the higher-level
 * `Vault`/`TFile` API for two reasons: the adapter can see `.obsidian`, which
 * the file cache deliberately hides and which the user may want synced; and it
 * exposes mtime on both read and write, which the engine needs to write a
 * downloaded file with the modification time it had on the other device.
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
     */
    private readonly selfWrites = new Set<string>();

    constructor(
        app: App,
        private readonly logger: Logger,
    ) {
        this.adapter = app.vault.adapter;
    }

    isSelfWrite(path: string): boolean {
        return this.selfWrites.has(path);
    }

    /**
     * Every file and folder in the vault, as vault-relative paths.
     *
     * Folders are returned as well as files so that an empty folder the user
     * created still reaches the other devices — it has no file to carry it.
     */
    async list(shouldDescend: (folderPath: string) => boolean): Promise<{ files: string[]; folders: string[] }> {
        const files: string[] = [];
        const folders: string[] = [];
        const queue = [''];

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
     * Current local state of a path, or undefined if it is gone.
     *
     * `knownBase` is an optimisation, not a shortcut: when size and mtime still
     * match what the last sync recorded, the file cannot have changed in a way
     * that matters and the digest is reused instead of re-reading the bytes.
     * A full vault scan on a large vault is otherwise dominated by hashing.
     */
    async getState(path: string, knownBase?: SyncBase): Promise<LocalState | undefined> {
        const stat = await this.adapter.stat(path);
        if (!stat || stat.type !== 'file') {
            return undefined;
        }

        if (knownBase && knownBase.size === stat.size && knownBase.localMtime === stat.mtime) {
            return { hash: knownBase.hash, size: stat.size, mtime: stat.mtime };
        }

        const data = await this.adapter.readBinary(path);
        return { hash: await sha1Hex(data), size: stat.size, mtime: stat.mtime };
    }

    async readBinary(path: string): Promise<ArrayBuffer> {
        return this.adapter.readBinary(path);
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
        this.selfWrites.add(path);
        try {
            await this.ensureFolder(parentPath(path));
            await this.adapter.writeBinary(path, data, mtime !== undefined ? { mtime } : undefined);

            const stat = await this.adapter.stat(path);
            return {
                hash: await sha1Hex(data),
                size: stat?.size ?? data.byteLength,
                mtime: stat?.mtime ?? mtime ?? Date.now(),
            };
        } finally {
            // Held until the end of the current task queue so the vault event
            // for this write, which Obsidian dispatches asynchronously, is still
            // recognised as ours.
            setTimeout(() => this.selfWrites.delete(path), 2000);
        }
    }

    async writeText(path: string, text: string, mtime?: number): Promise<LocalState> {
        return this.writeBinary(path, new TextEncoder().encode(text).buffer as ArrayBuffer, mtime);
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
     * Delete a path, preferring the system trash.
     *
     * A deletion arriving from another device is the one operation here the
     * user cannot undo from within Obsidian, so it goes to the trash where the
     * OS can still recover it. Falling back to a hard delete only when the
     * vault has no trash available.
     */
    async trash(path: string): Promise<void> {
        this.selfWrites.add(path);
        try {
            await this.adapter.trashSystem(path).then(async (trashed) => {
                if (!trashed) {
                    await this.adapter.trashLocal(path);
                }
            });
        } catch (error) {
            this.logger.warn(`Could not trash "${path}", removing it instead`, error);
            await this.adapter.remove(path);
        } finally {
            setTimeout(() => this.selfWrites.delete(path), 2000);
        }
    }
}
