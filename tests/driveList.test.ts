import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DriveList } from '../src/ui/driveList';

/** A promise, and the means to settle it from outside. */
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
    });
    return { promise, resolve, reject };
}

describe('DriveList', () => {
    it('keeps the last listing in place while listing again, and when that fails', async () => {
        const list = new DriveList<string[]>();
        await list.load(async () => ['a.md']);

        const again = deferred<string[]>();
        const listing = list.load(() => again.promise);
        assert.deepEqual(list.items, ['a.md']);
        assert.equal(list.loading, true);

        again.reject(new Error('offline'));
        await listing;
        assert.deepEqual(list.items, ['a.md']);
        assert.equal(list.error?.message, 'offline');
        assert.equal(list.loading, false);

        await list.load(async () => ['a.md', 'b.md']);
        assert.deepEqual(list.items, ['a.md', 'b.md']);
        assert.equal(list.error, null);
    });

    it('shows the latest listing asked for, whichever answers first', async () => {
        const list = new DriveList<string>();
        const slow = deferred<string>();
        const first = list.load(() => slow.promise);
        await list.load(async () => 'second');

        slow.resolve('first');
        await first;
        assert.equal(list.items, 'second');
        assert.equal(list.loading, false);
    });

    it('drops a listing under way that a change made here has overtaken', async () => {
        const list = new DriveList<string[]>();
        await list.load(async () => ['restored.md', 'other.md']);
        const stale = deferred<string[]>();
        const listing = list.load(() => stale.promise);

        list.set(['other.md']);
        stale.resolve(['restored.md', 'other.md']);
        await listing;
        assert.deepEqual(list.items, ['other.md']);
        assert.equal(list.loading, false);
    });

    it('forgets the listing when cleared, dropping one on its way', async () => {
        const list = new DriveList<string[]>();
        await list.load(async () => ['a.md']);
        const late = deferred<string[]>();
        const listing = list.load(() => late.promise);

        list.clear();
        late.resolve(['a.md']);
        await listing;
        assert.equal(list.items, undefined);
        assert.equal(list.loading, false);
    });

    it('tells its listeners of every change until they stop listening', async () => {
        const list = new DriveList<number>();
        let changes = 0;
        const stop = list.onChange(() => changes++);

        await list.load(async () => 1);
        assert.equal(changes, 2, 'once when listing starts, once with the answer');
        list.set(2);
        assert.equal(changes, 3);

        stop();
        list.clear();
        assert.equal(changes, 3);
    });
});
