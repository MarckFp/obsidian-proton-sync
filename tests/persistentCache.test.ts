import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    cacheKeyBytes,
    EncryptedEntitiesCache,
    newCacheKey,
    type CacheStore,
    type StoredEntry,
} from '../src/proton/persistentCache';
import { Logger } from '../src/util/logger';

const SILENT = new Logger('error');

/** A store in memory, standing in for IndexedDB. */
function memoryStore() {
    const entries = new Map<string, StoredEntry>();
    const store = {
        entries,
        marker: null as string | null,
        async load() {
            return { entries: [...entries.values()], marker: store.marker };
        },
        async write(written: StoredEntry[], removed: string[], marker: string) {
            for (const entry of written) {
                entries.set(entry.key, entry);
            }
            for (const key of removed) {
                entries.delete(key);
            }
            store.marker = marker;
        },
        async clear() {
            entries.clear();
            store.marker = null;
        },
    };
    return store satisfies CacheStore;
}

async function collect<T>(iterator: AsyncGenerator<T>): Promise<T[]> {
    const items: T[] = [];
    for await (const item of iterator) {
        items.push(item);
    }
    return items;
}

describe('EncryptedEntitiesCache', () => {
    it('keeps entries between sessions, and only ciphertext on disk', async () => {
        const store = memoryStore();
        const key = cacheKeyBytes(newCacheKey());
        const first = await EncryptedEntitiesCache.open(store, key, () => 'cursor-1', SILENT);
        await first.setEntity('node-a', '{"name":"Secret plans.md"}', ['nodeParentUid:root']);
        await first.flush();

        assert.equal(store.marker, 'cursor-1');
        assert.ok(![...store.entries.values()].some((entry) => entry.data.includes('Secret')));

        const second = await EncryptedEntitiesCache.open(store, key, () => 'cursor-1', SILENT);
        await second.validate('cursor-1');
        assert.equal(await second.getEntity('node-a'), '{"name":"Secret plans.md"}');
        const byTag = await collect(second.iterateEntitiesByTag('nodeParentUid:root'));
        assert.equal(byTag.length, 1);
    });

    it('starts empty when saved at another point in the event feed', async () => {
        const store = memoryStore();
        const key = cacheKeyBytes(newCacheKey());
        const first = await EncryptedEntitiesCache.open(store, key, () => 'cursor-1', SILENT);
        await first.setEntity('node-a', 'data');
        await first.flush();

        const second = await EncryptedEntitiesCache.open(store, key, () => 'cursor-2', SILENT);
        await second.validate('cursor-2');
        await assert.rejects(second.getEntity('node-a'));
        assert.equal(store.entries.size, 0);
    });

    it('starts empty with another session’s key', async () => {
        const store = memoryStore();
        const first = await EncryptedEntitiesCache.open(store, cacheKeyBytes(newCacheKey()), () => 'c', SILENT);
        await first.setEntity('node-a', 'data');
        await first.flush();

        const second = await EncryptedEntitiesCache.open(store, cacheKeyBytes(newCacheKey()), () => 'c', SILENT);
        await assert.rejects(second.getEntity('node-a'));
        assert.equal(store.entries.size, 0);
    });

    it('saves removals too', async () => {
        const store = memoryStore();
        const key = cacheKeyBytes(newCacheKey());
        const cache = await EncryptedEntitiesCache.open(store, key, () => 'c', SILENT);
        await cache.setEntity('node-a', 'a');
        await cache.setEntity('node-b', 'b');
        await cache.flush();
        await cache.removeEntities(['node-a']);
        await cache.flush();
        assert.deepEqual([...store.entries.keys()], ['node-b']);
    });
});
