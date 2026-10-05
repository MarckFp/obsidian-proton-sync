import { MemoryCache, type EntityResult, type ProtonDriveCache } from '@protontech/drive-sdk';

import type { Logger } from '../util/logger';

/**
 * The SDK's metadata cache, kept between sessions, encrypted.
 *
 * The SDK caches every file and folder it has loaded, decrypted: names,
 * sizes, revisions. Held in memory only, a restart throws that away and the
 * start-up catch-up asks Drive for it all again. Kept on disk, it saves those
 * requests, but it holds the names of the files in plain text, including ones
 * outside the vault seen while choosing a folder. So every entry is encrypted
 * (AES-256-GCM) with a key that lives inside the stored Proton session, which
 * the PIN protects when there is one, and which is gone after sign-out.
 *
 * The SDK keeps its cache current by reading Drive's event feed, so a saved
 * cache is only trustworthy together with the event position it was saved
 * at. Each save records that position (`marker`), and {@link validate}
 * discards the cache when the sync state stands somewhere else: a crash
 * between the two saves, a rebuilt sync state, a new folder. A cache thrown
 * away costs a few requests; a stale one trusted could hide a change.
 *
 * Reads and writes go to an in-memory copy; changes reach the store in the
 * background, a few seconds later or on {@link flush}. The crypto cache, which
 * holds decrypted keys, is never stored this way; see `ProtonSession`.
 */

/** One cache entry as stored: encrypted, with its tags in the clear (uids, no names). */
export type StoredEntry = { key: string; iv: string; data: string; tags: string[] };

/** Where entries are kept. IndexedDB in the app; a map in tests. */
export interface CacheStore {
    load(): Promise<{ entries: StoredEntry[]; marker: string | null }>;
    write(entries: StoredEntry[], removed: string[], marker: string): Promise<void>;
    clear(): Promise<void>;
}

/** Changes are written this long after the last one, so a busy sync writes in batches. */
const FLUSH_DELAY_MS = 3_000;

export class EncryptedEntitiesCache implements ProtonDriveCache<string> {
    private readonly memory = new MemoryCache<string>();
    private readonly tags = new Map<string, string[]>();
    private readonly dirty = new Set<string>();
    private readonly removed = new Set<string>();
    private flushTimer: number | null = null;
    private writing: Promise<void> = Promise.resolve();

    private constructor(
        private readonly store: CacheStore,
        private readonly key: CryptoKey,
        /** The event position the cache matches right now; recorded with every save. */
        private readonly marker: () => string,
        private readonly logger: Logger,
        private loadedMarker: string | null,
    ) {}

    /**
     * Open the stored cache. Entries that cannot be decrypted (a different
     * key, after signing in again) mean the whole store is discarded.
     */
    static async open(
        store: CacheStore,
        rawKey: Uint8Array<ArrayBuffer>,
        marker: () => string,
        logger: Logger,
    ): Promise<EncryptedEntitiesCache> {
        const key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
        let loaded: { entries: StoredEntry[]; marker: string | null } = { entries: [], marker: null };
        try {
            loaded = await store.load();
        } catch (error) {
            logger.warn('Could not read the saved Drive cache; starting without it', error);
        }
        const cache = new EncryptedEntitiesCache(store, key, marker, logger, loaded.marker);
        try {
            for (const entry of loaded.entries) {
                const value = await decrypt(key, entry);
                await cache.memory.setEntity(entry.key, value, entry.tags);
                cache.tags.set(entry.key, entry.tags);
            }
            if (loaded.entries.length > 0) {
                logger.debug(`Loaded ${loaded.entries.length} cached Drive entries`);
            }
        } catch (error) {
            logger.info('The saved Drive cache does not match this session; starting without it', error);
            await cache.clear();
        }
        return cache;
    }

    /**
     * Keep the loaded entries only if they were saved at the event position
     * the sync state now stands at; otherwise they may describe Drive as it
     * was before changes nobody has told the cache about.
     */
    async validate(currentMarker: string): Promise<void> {
        if (this.loadedMarker !== null && this.loadedMarker !== currentMarker) {
            this.logger.info('The saved Drive cache is from another point in the event feed; starting without it');
            await this.clear();
        }
        this.loadedMarker = null;
    }

    async clear(): Promise<void> {
        await this.memory.clear();
        this.tags.clear();
        this.dirty.clear();
        this.removed.clear();
        if (this.flushTimer !== null) {
            window.clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        await this.writing.catch(() => undefined);
        try {
            await this.store.clear();
        } catch (error) {
            this.logger.warn('Could not clear the saved Drive cache', error);
        }
    }

    async setEntity(key: string, value: string, tags: string[] = []): Promise<void> {
        await this.memory.setEntity(key, value, tags);
        this.tags.set(key, tags);
        this.removed.delete(key);
        this.dirty.add(key);
        this.scheduleFlush();
    }

    getEntity(key: string): Promise<string> {
        return this.memory.getEntity(key);
    }

    iterateEntities(keys: string[]): AsyncGenerator<EntityResult<string>> {
        return this.memory.iterateEntities(keys);
    }

    iterateEntitiesByTag(tag: string): AsyncGenerator<EntityResult<string>> {
        return this.memory.iterateEntitiesByTag(tag);
    }

    async removeEntities(keys: string[]): Promise<void> {
        await this.memory.removeEntities(keys);
        for (const key of keys) {
            this.tags.delete(key);
            this.dirty.delete(key);
            this.removed.add(key);
        }
        this.scheduleFlush();
    }

    /** Write pending changes now, with the current event position. */
    flush(): Promise<void> {
        if (this.flushTimer !== null) {
            window.clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        this.writing = this.writing.catch(() => undefined).then(() => this.write());
        return this.writing;
    }

    private scheduleFlush(): void {
        if (this.flushTimer !== null) {
            return;
        }
        this.flushTimer = window.setTimeout(() => {
            this.flushTimer = null;
            void this.flush();
        }, FLUSH_DELAY_MS);
    }

    private async write(): Promise<void> {
        const keys = [...this.dirty];
        const removed = [...this.removed];
        this.dirty.clear();
        this.removed.clear();
        const entries: StoredEntry[] = [];
        for (const key of keys) {
            let value: string;
            try {
                value = await this.memory.getEntity(key);
            } catch {
                continue;
            }
            entries.push(await encrypt(this.key, key, value, this.tags.get(key) ?? []));
        }
        try {
            await this.store.write(entries, removed, this.marker());
        } catch (error) {
            this.logger.warn('Could not save the Drive cache', error);
            for (const key of keys) {
                this.dirty.add(key);
            }
            for (const key of removed) {
                this.removed.add(key);
            }
        }
    }
}

/** A key for a new session's cache. */
export function newCacheKey(): string {
    return toBase64(crypto.getRandomValues(new Uint8Array(32)));
}

export function cacheKeyBytes(key: string): Uint8Array<ArrayBuffer> {
    return fromBase64(key);
}

async function encrypt(key: CryptoKey, entryKey: string, value: string, tags: string[]): Promise<StoredEntry> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt(
        // The entry's key is bound in, so an entry cannot be swapped for another.
        { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(entryKey) },
        key,
        new TextEncoder().encode(value),
    );
    return { key: entryKey, iv: toBase64(iv), data: toBase64(new Uint8Array(data)), tags };
}

async function decrypt(key: CryptoKey, entry: StoredEntry): Promise<string> {
    const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64(entry.iv), additionalData: new TextEncoder().encode(entry.key) },
        key,
        fromBase64(entry.data),
    );
    return new TextDecoder().decode(plaintext);
}

/** The store in Obsidian: an IndexedDB database of its own per installation. */
export class IndexedDbCacheStore implements CacheStore {
    private db: Promise<IDBDatabase> | null = null;

    constructor(private readonly name: string) {}

    static available(): boolean {
        return typeof indexedDB !== 'undefined';
    }

    async load(): Promise<{ entries: StoredEntry[]; marker: string | null }> {
        const db = await this.open();
        const [entries, meta] = await Promise.all([
            request<StoredEntry[]>(db.transaction('entities').objectStore('entities').getAll()),
            request<{ id: string; marker: string } | undefined>(db.transaction('meta').objectStore('meta').get('marker')),
        ]);
        return { entries, marker: meta?.marker ?? null };
    }

    async write(entries: StoredEntry[], removed: string[], marker: string): Promise<void> {
        const db = await this.open();
        const transaction = db.transaction(['entities', 'meta'], 'readwrite');
        const entities = transaction.objectStore('entities');
        for (const entry of entries) {
            entities.put(entry);
        }
        for (const key of removed) {
            entities.delete(key);
        }
        transaction.objectStore('meta').put({ id: 'marker', marker });
        await done(transaction);
    }

    async clear(): Promise<void> {
        const db = await this.open();
        const transaction = db.transaction(['entities', 'meta'], 'readwrite');
        transaction.objectStore('entities').clear();
        transaction.objectStore('meta').clear();
        await done(transaction);
    }

    private open(): Promise<IDBDatabase> {
        this.db ??= new Promise((resolve, reject) => {
            const opening = indexedDB.open(this.name, 1);
            opening.onupgradeneeded = () => {
                opening.result.createObjectStore('entities', { keyPath: 'key' });
                opening.result.createObjectStore('meta', { keyPath: 'id' });
            };
            opening.onsuccess = () => resolve(opening.result);
            opening.onerror = () => reject(opening.error ?? new Error('Could not open the cache database'));
        });
        return this.db;
    }
}

function request<T>(req: IDBRequest): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error ?? new Error('Cache database request failed'));
    });
}

function done(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error('Cache database write failed'));
        transaction.onabort = () => reject(transaction.error ?? new Error('Cache database write aborted'));
    });
}

function toBase64(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}
