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
    } as unknown as DataAdapter;
    return { adapter, files };
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
    } as unknown as DataAdapter;
}
