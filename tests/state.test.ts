import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DataAdapter } from 'obsidian';

import { SyncState } from '../src/sync/state';
import type { SyncBase } from '../src/sync/types';
import { Logger } from '../src/util/logger';

const SILENT = new Logger('error');
const FILE = 'state.json';

/** In-memory stand-in for Obsidian's vault adapter. */
function memoryAdapter(seed: Record<string, string> = {}) {
    const files = new Map(Object.entries(seed));
    const adapter = {
        async exists(path: string) {
            return files.has(path);
        },
        async read(path: string) {
            const value = files.get(path);
            if (value === undefined) {
                throw new Error(`no such file: ${path}`);
            }
            return value;
        },
        async write(path: string, data: string) {
            files.set(path, data);
        },
        ...renameAndRemove(files),
    } as unknown as DataAdapter;
    return { adapter, files };
}

/**
 * Rename and remove as Obsidian's adapters do them; rename refuses to replace
 * an existing file, which the state must never rely on.
 */
function renameAndRemove(files: Map<string, string>) {
    return {
        async rename(from: string, to: string) {
            if (files.has(to)) {
                throw new Error(`Destination file already exists: ${to}`);
            }
            const value = files.get(from);
            if (value === undefined) {
                throw new Error(`no such file: ${from}`);
            }
            files.delete(from);
            files.set(to, value);
        },
        async remove(path: string) {
            files.delete(path);
        },
    };
}

const base = (hash: string, revisionUid = 'rev-1'): SyncBase => ({
    hash,
    size: 10,
    localMtime: 1000,
    remoteRevisionUid: revisionUid,
});

async function loadedState(seed: Record<string, string> = {}, account = 'a@b.c', folder = 'folder-1') {
    const { adapter, files } = memoryAdapter(seed);
    const state = new SyncState(adapter, FILE, SILENT);
    await state.load(account, folder);
    return { state, files };
}

describe('SyncState — records', () => {
    it('round-trips a record through a flush and reload', async () => {
        const { state, files } = await loadedState();
        state.setSynced('note.md', 'node-1', 'file', base('hash-a'));
        await state.flush();

        const reloaded = new SyncState(memoryAdapterFrom(files), FILE, SILENT);
        await reloaded.load('a@b.c', 'folder-1');

        assert.equal(reloaded.get('note.md')?.nodeUid, 'node-1');
        assert.equal(reloaded.get('note.md')?.base?.hash, 'hash-a');
    });

    it('finds a record by node uid, which is how remote events are mapped back', async () => {
        const { state } = await loadedState();
        state.setSynced('note.md', 'node-1', 'file', base('hash-a'));
        assert.equal(state.getByNodeUid('node-1')?.path, 'note.md');
    });

    it('stops resolving a node uid once its record is replaced', async () => {
        const { state } = await loadedState();
        state.setSynced('note.md', 'node-1', 'file', base('hash-a'));
        state.setSynced('note.md', 'node-2', 'file', base('hash-b'));

        assert.equal(state.getByNodeUid('node-1'), undefined);
        assert.equal(state.getByNodeUid('node-2')?.path, 'note.md');
    });

    it('moves a record with a rename, keeping the node uid', async () => {
        const { state } = await loadedState();
        state.setSynced('old.md', 'node-1', 'file', base('hash-a'));
        state.rename('old.md', 'new.md');

        assert.equal(state.get('old.md'), undefined);
        assert.equal(state.get('new.md')?.nodeUid, 'node-1');
        assert.equal(state.getByNodeUid('node-1')?.path, 'new.md');
    });

    it('moves a folder and everything recorded inside it, and nothing beside it', async () => {
        const { state } = await loadedState();
        state.setSynced('Projects', 'folder-1', 'folder');
        state.setSynced('Projects/a.md', 'node-1', 'file', base('hash-a'));
        state.setSynced('Projects/deep/b.md', 'node-2', 'file', base('hash-b'));
        state.setSynced('Projects old/c.md', 'node-3', 'file', base('hash-c'));
        state.setConflict('Projects/a.md', { detectedAt: 1, reason: 'both-modified' });

        state.renameFolder('Projects', 'Work');

        assert.deepEqual(state.paths().sort(), ['Projects old/c.md', 'Work', 'Work/a.md', 'Work/deep/b.md']);
        assert.equal(state.getByNodeUid('node-2')?.path, 'Work/deep/b.md');
        assert.equal(state.isConflicted('Work/a.md'), true);
        assert.equal(state.isConflicted('Projects/a.md'), false);
    });

    it('forgets a deleted record on both lookups', async () => {
        const { state } = await loadedState();
        state.setSynced('note.md', 'node-1', 'file', base('hash-a'));
        state.delete('note.md');

        assert.equal(state.get('note.md'), undefined);
        assert.equal(state.getByNodeUid('node-1'), undefined);
    });
});

describe('SyncState — conflicts', () => {
    it('records a conflict for a path that has no record yet', async () => {
        // The both-created case: neither side has ever been synced, so there is
        // no record to attach the conflict to.
        const { state } = await loadedState();
        state.setConflict('new.md', { detectedAt: 1, reason: 'both-created' });

        assert.equal(state.isConflicted('new.md'), true);
        assert.deepEqual(state.conflicts(), [
            { path: 'new.md', conflict: { detectedAt: 1, reason: 'both-created' } },
        ]);
    });

    it('survives a reload, so a pending decision is not lost on restart', async () => {
        const { state, files } = await loadedState();
        state.setConflict('note.md', { detectedAt: 1, reason: 'both-modified' });
        await state.flush();

        const reloaded = new SyncState(memoryAdapterFrom(files), FILE, SILENT);
        await reloaded.load('a@b.c', 'folder-1');
        assert.equal(reloaded.isConflicted('note.md'), true);
    });

    it('clears once resolved', async () => {
        const { state } = await loadedState();
        state.setConflict('note.md', { detectedAt: 1, reason: 'both-modified' });
        state.clearConflict('note.md');

        assert.equal(state.isConflicted('note.md'), false);
        assert.deepEqual(state.conflicts(), []);
    });

    it('follows a rename', async () => {
        const { state } = await loadedState();
        state.setSynced('old.md', 'node-1', 'file', base('hash-a'));
        state.setConflict('old.md', { detectedAt: 1, reason: 'both-modified' });
        state.rename('old.md', 'new.md');

        assert.equal(state.isConflicted('old.md'), false);
        assert.equal(state.isConflicted('new.md'), true);
    });
});

describe('SyncState — invalidation', () => {
    it('discards state belonging to a different account', async () => {
        const { state, files } = await loadedState();
        state.setSynced('note.md', 'node-1', 'file', base('hash-a'));
        await state.flush();

        const other = new SyncState(memoryAdapterFrom(files), FILE, SILENT);
        await other.load('someone.else@b.c', 'folder-1');
        assert.deepEqual(other.paths(), []);
    });

    it('discards state belonging to a different Drive folder', async () => {
        // Reconciling a new folder against the old folder's ancestors would
        // read as every file having been deleted on both sides.
        const { state, files } = await loadedState();
        state.setSynced('note.md', 'node-1', 'file', base('hash-a'));
        await state.flush();

        const other = new SyncState(memoryAdapterFrom(files), FILE, SILENT);
        await other.load('a@b.c', 'folder-2');
        assert.deepEqual(other.paths(), []);
    });

    it('starts fresh rather than throwing on a corrupt file', async () => {
        const { state } = await loadedState({ [FILE]: '{ this is not json' });
        assert.deepEqual(state.paths(), []);
    });

    it('starts fresh on state written by a future version', async () => {
        const seed = { [FILE]: JSON.stringify({ version: 99, records: { 'a.md': {} } }) };
        const { state } = await loadedState(seed);
        assert.deepEqual(state.paths(), []);
    });
});

describe('SyncState — event cursors', () => {
    it('remembers the last processed event id per scope', async () => {
        const { state, files } = await loadedState();
        state.setEventCursor('scope-1', 'event-7');
        await state.flush();

        const reloaded = new SyncState(memoryAdapterFrom(files), FILE, SILENT);
        await reloaded.load('a@b.c', 'folder-1');

        assert.equal(reloaded.getEventCursor('scope-1'), 'event-7');
        assert.equal(reloaded.getEventCursor('scope-2'), null);
    });
});

describe('SyncState — reset', () => {
    it('drops records, conflicts and cursors together', async () => {
        const { state } = await loadedState();
        state.setSynced('note.md', 'node-1', 'file', base('hash-a'));
        state.setConflict('note.md', { detectedAt: 1, reason: 'both-modified' });
        state.setEventCursor('scope-1', 'event-7');

        await state.reset();

        assert.deepEqual(state.paths(), []);
        assert.deepEqual(state.conflicts(), []);
        assert.equal(state.getEventCursor('scope-1'), null);
    });
});

function memoryAdapterFrom(files: Map<string, string>): DataAdapter {
    return {
        async exists(path: string) {
            return files.has(path);
        },
        async read(path: string) {
            return files.get(path)!;
        },
        async write(path: string, data: string) {
            files.set(path, data);
        },
        ...renameAndRemove(files),
    } as unknown as DataAdapter;
}

describe('SyncState — surviving a crash mid-write (issue #7)', () => {
    async function savedState() {
        const { adapter, files } = memoryAdapter();
        const state = new SyncState(adapter, FILE, SILENT);
        await state.load('a@b.c', 'folder-1');
        state.setSynced('note.md', 'node-1', 'file', base('h1'));
        await state.flush();
        state.setSynced('other.md', 'node-2', 'file', base('h2'));
        await state.flush();
        return { adapter, files };
    }

    async function reload(adapter: DataAdapter) {
        const state = new SyncState(adapter, FILE, SILENT);
        await state.load('a@b.c', 'folder-1');
        return state;
    }

    it('keeps the previous good copy as a backup, and leaves no temporary file behind', async () => {
        const { files } = await savedState();
        assert.ok(files.has(FILE));
        assert.ok(files.has(`${FILE}.bak`));
        assert.ok(!files.has(`${FILE}.tmp`));
    });

    it('falls back to the backup when the file is torn', async () => {
        const { adapter, files } = await savedState();
        files.set(FILE, files.get(FILE)!.slice(0, 20));

        const state = await reload(adapter);
        assert.equal(state.wasLost(), false);
        assert.equal(state.get('note.md')?.nodeUid, 'node-1');
    });

    it('uses a finished temporary file when the crash came before it was moved into place', async () => {
        const { adapter, files } = await savedState();
        // The moment between moving the old file aside and the new one in.
        files.set(`${FILE}.tmp`, files.get(FILE)!);
        files.delete(FILE);

        const state = await reload(adapter);
        assert.equal(state.get('other.md')?.nodeUid, 'node-2');
    });

    it('prefers the intact file over a temporary one torn by a crash during the write', async () => {
        const { adapter, files } = await savedState();
        files.set(`${FILE}.tmp`, '{"version":1,"rec');

        const state = await reload(adapter);
        assert.equal(state.get('other.md')?.nodeUid, 'node-2');
    });

    it('reports the state lost, instead of starting afresh quietly, when no copy can be read', async () => {
        const { adapter, files } = await savedState();
        files.set(FILE, 'garbage');
        files.set(`${FILE}.bak`, '');

        const state = await reload(adapter);
        assert.equal(state.wasLost(), true);
        assert.deepEqual(state.paths(), []);
    });

    it('treats no file at all as a first sync, not a loss', async () => {
        const state = await reload(memoryAdapter().adapter);
        assert.equal(state.wasLost(), false);
    });

    it('does not bring a deliberately reset state back from the backup', async () => {
        const { adapter, files } = await savedState();
        const state = await reload(adapter);
        await state.reset();
        assert.ok(!files.has(`${FILE}.bak`));
        files.set(FILE, 'garbage');

        const reloaded = await reload(adapter);
        assert.equal(reloaded.get('note.md'), undefined);
    });
});
