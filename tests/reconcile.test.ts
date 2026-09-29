import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { reconcile } from '../src/sync/reconcile';
import type { LocalState, ReconcileInput, RemoteState, SyncBase } from '../src/sync/types';

const HASH_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH_C = 'cccccccccccccccccccccccccccccccccccccccc';

const local = (hash: string, mtime = 1000): LocalState => ({ hash, size: hash.length, mtime });

const remote = (hash: string | undefined, revisionUid = 'rev-1'): RemoteState => ({
    nodeUid: 'node-1',
    revisionUid,
    ...(hash !== undefined && { hash }),
});

const base = (hash: string, revisionUid = 'rev-1'): SyncBase => ({
    hash,
    size: hash.length,
    localMtime: 1000,
    remoteRevisionUid: revisionUid,
});

const run = (input: Omit<ReconcileInput, 'path'>) => reconcile({ path: 'note.md', ...input });

describe('reconcile — no common ancestor', () => {
    it('does nothing when the path exists nowhere', () => {
        assert.deepEqual(run({}), { type: 'noop' });
    });

    it('uploads a file that only exists locally', () => {
        assert.deepEqual(run({ local: local(HASH_A) }), { type: 'upload', reason: 'created' });
    });

    it('downloads a file that only exists remotely', () => {
        assert.deepEqual(run({ remote: remote(HASH_A) }), {
            type: 'download',
            reason: 'created',
            nodeUid: 'node-1',
            revisionUid: 'rev-1',
        });
    });

    it('adopts rather than transfers when both sides already hold the same bytes', () => {
        assert.deepEqual(run({ local: local(HASH_A), remote: remote(HASH_A) }), {
            type: 'adopt',
            nodeUid: 'node-1',
            revisionUid: 'rev-1',
        });
    });

    it('reports a conflict when both sides created the path with different bytes', () => {
        assert.deepEqual(run({ local: local(HASH_A), remote: remote(HASH_B) }), {
            type: 'conflict',
            reason: 'both-created',
        });
    });

    it('treats a digest-less remote as different, rather than assuming equality', () => {
        assert.deepEqual(run({ local: local(HASH_A), remote: remote(undefined) }), {
            type: 'conflict',
            reason: 'both-created',
        });
    });
});

describe('reconcile — one side moved', () => {
    it('does nothing when neither side moved', () => {
        assert.deepEqual(run({ base: base(HASH_A), local: local(HASH_A), remote: remote(HASH_A) }), {
            type: 'noop',
        });
    });

    it('uploads a local-only edit', () => {
        assert.deepEqual(run({ base: base(HASH_A), local: local(HASH_B), remote: remote(HASH_A) }), {
            type: 'upload',
            reason: 'modified',
        });
    });

    it('downloads a remote-only edit', () => {
        assert.deepEqual(
            run({ base: base(HASH_A), local: local(HASH_A), remote: remote(HASH_B, 'rev-2') }),
            { type: 'download', reason: 'modified', nodeUid: 'node-1', revisionUid: 'rev-2' },
        );
    });

    it('only refreshes bookkeeping when a new revision carries the bytes we already have', () => {
        assert.deepEqual(
            run({ base: base(HASH_A), local: local(HASH_A), remote: remote(HASH_A, 'rev-2') }),
            { type: 'adopt', nodeUid: 'node-1', revisionUid: 'rev-2' },
        );
    });

    it('downloads when a digest-less remote gained a revision', () => {
        assert.deepEqual(
            run({ base: base(HASH_A), local: local(HASH_A), remote: remote(undefined, 'rev-2') }),
            { type: 'download', reason: 'modified', nodeUid: 'node-1', revisionUid: 'rev-2' },
        );
    });
});

describe('reconcile — deletions', () => {
    it('forgets a path both sides deleted', () => {
        assert.deepEqual(run({ base: base(HASH_A) }), { type: 'forget' });
    });

    it('propagates a remote deletion when the local copy is untouched', () => {
        assert.deepEqual(run({ base: base(HASH_A), local: local(HASH_A) }), { type: 'delete-local' });
    });

    it('propagates a local deletion when the remote copy is untouched', () => {
        assert.deepEqual(run({ base: base(HASH_A), remote: remote(HASH_A) }), {
            type: 'delete-remote',
            nodeUid: 'node-1',
        });
    });

    it('refuses to delete local edits that the deleting device never saw', () => {
        assert.deepEqual(run({ base: base(HASH_A), local: local(HASH_B) }), {
            type: 'conflict',
            reason: 'deleted-remotely-modified-locally',
        });
    });

    it('refuses to delete remote edits that the deleting device never saw', () => {
        assert.deepEqual(run({ base: base(HASH_A), remote: remote(HASH_B, 'rev-2') }), {
            type: 'conflict',
            reason: 'deleted-locally-modified-remotely',
        });
    });
});

describe('reconcile — both sides moved', () => {
    it('reports a conflict when both sides edited to different bytes', () => {
        assert.deepEqual(
            run({ base: base(HASH_A), local: local(HASH_B), remote: remote(HASH_C, 'rev-2') }),
            { type: 'conflict', reason: 'both-modified' },
        );
    });

    it('accepts an independent convergence on identical bytes', () => {
        assert.deepEqual(
            run({ base: base(HASH_A), local: local(HASH_B), remote: remote(HASH_B, 'rev-2') }),
            { type: 'adopt', nodeUid: 'node-1', revisionUid: 'rev-2' },
        );
    });

    it('conflicts a week of offline edits against a remote that also moved', () => {
        // The case the base exists for: without it, this is indistinguishable
        // from a one-sided edit and one side's work would be silently dropped.
        assert.deepEqual(
            run({
                base: base(HASH_A, 'rev-1'),
                local: local(HASH_B, Date.now()),
                remote: remote(HASH_C, 'rev-9'),
            }),
            { type: 'conflict', reason: 'both-modified' },
        );
    });
});
