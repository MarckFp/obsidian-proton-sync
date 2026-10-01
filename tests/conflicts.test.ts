import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConflictResolver, type ConflictContext, type Resolution } from '../src/sync/conflicts';
import type { DriveIO } from '../src/sync/drive';
import type { ConflictPolicy, LocalState, RemoteState, SyncBase } from '../src/sync/types';
import { Logger } from '../src/util/logger';

const WHEN = new Date(2026, 8, 18, 14, 31);
const SILENT = new Logger('error');

const encode = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

/**
 * Stands in for Drive. `revisions` maps a revision uid to its content and
 * `files` maps a node uid to its current content, which is all the resolver
 * ever asks for.
 */
function stubDrive(options: { revisions?: Record<string, string>; files?: Record<string, string> } = {}) {
    const calls: string[] = [];
    const drive = {
        async downloadRevision(revisionUid: string) {
            calls.push(`revision:${revisionUid}`);
            const content = options.revisions?.[revisionUid];
            if (content === undefined) {
                throw new Error('revision not found');
            }
            return encode(content);
        },
        async downloadFile(nodeUid: string) {
            calls.push(`file:${nodeUid}`);
            const content = options.files?.[nodeUid];
            if (content === undefined) {
                throw new Error('file not found');
            }
            return encode(content);
        },
    } as unknown as DriveIO;
    return { drive, calls };
}

function resolver(
    policy: ConflictPolicy,
    drive: DriveIO,
    overrides: { keepConflictCopies?: boolean; deviceName?: string } = {},
): ConflictResolver {
    return new ConflictResolver(
        drive,
        {
            policy,
            deviceName: overrides.deviceName ?? 'laptop',
            keepConflictCopies: overrides.keepConflictCopies ?? true,
        },
        SILENT,
        () => WHEN,
    );
}

const local = (mtime = 1000): LocalState => ({ hash: 'local-hash', size: 10, mtime });
const remote = (mtime?: number): RemoteState => ({
    nodeUid: 'node-1',
    revisionUid: 'rev-2',
    hash: 'remote-hash',
    ...(mtime !== undefined && { mtime }),
});
const base = (): SyncBase => ({
    hash: 'base-hash',
    size: 10,
    localMtime: 500,
    remoteRevisionUid: 'rev-1',
});

function context(overrides: Partial<ConflictContext> = {}): ConflictContext {
    return {
        path: 'note.md',
        reason: 'both-modified',
        base: base(),
        local: local(),
        remote: remote(),
        readLocalText: async () => 'local text',
        ...overrides,
    };
}

describe('ConflictResolver — a deletion against an edit', () => {
    it('keeps the local edit when the file was deleted elsewhere, whatever the policy', async () => {
        for (const policy of ['keep-both', 'merge', 'prefer-remote', 'manual'] as ConflictPolicy[]) {
            const result = await resolver(policy, stubDrive().drive).resolve(
                context({ reason: 'deleted-remotely-modified-locally', remote: undefined }),
            );
            assert.deepEqual(result, { action: 'take-local' }, `policy ${policy}`);
        }
    });

    it('restores the remote edit when the file was deleted here, whatever the policy', async () => {
        for (const policy of ['keep-both', 'merge', 'prefer-local', 'manual'] as ConflictPolicy[]) {
            const result = await resolver(policy, stubDrive().drive).resolve(
                context({ reason: 'deleted-locally-modified-remotely', local: undefined }),
            );
            assert.deepEqual(result, { action: 'take-remote' }, `policy ${policy}`);
        }
    });
});

describe('ConflictResolver — keep-both', () => {
    it('leaves the local version under the original name', async () => {
        const result = await resolver('keep-both', stubDrive().drive).resolve(context());
        assert.deepEqual(result, {
            action: 'keep-both',
            keepAtPath: 'local',
            copyPath: 'note (conflict 2026-09-18 1431 from laptop).md',
        });
    });

    it('transfers nothing while deciding', async () => {
        const { drive, calls } = stubDrive();
        await resolver('keep-both', drive).resolve(context());
        assert.deepEqual(calls, []);
    });
});

describe('ConflictResolver — prefer-local and prefer-remote', () => {
    it('keeps the loser as a copy by default, with the winner under the original name', async () => {
        const preferLocal = await resolver('prefer-local', stubDrive().drive).resolve(context());
        assert.equal((preferLocal as { keepAtPath: string }).keepAtPath, 'local');

        const preferRemote = await resolver('prefer-remote', stubDrive().drive).resolve(context());
        assert.equal((preferRemote as { keepAtPath: string }).keepAtPath, 'remote');
    });

    it('discards the loser only when copies are explicitly turned off', async () => {
        const options = { keepConflictCopies: false };
        assert.deepEqual(await resolver('prefer-local', stubDrive().drive, options).resolve(context()), {
            action: 'take-local',
        });
        assert.deepEqual(await resolver('prefer-remote', stubDrive().drive, options).resolve(context()), {
            action: 'take-remote',
        });
    });
});

describe('ConflictResolver — prefer-newest', () => {
    it('picks the side with the later modification time', async () => {
        const newerLocally = await resolver('prefer-newest', stubDrive().drive).resolve(
            context({ local: local(2000), remote: remote(1000) }),
        );
        assert.equal((newerLocally as { keepAtPath: string }).keepAtPath, 'local');

        const newerRemotely = await resolver('prefer-newest', stubDrive().drive).resolve(
            context({ local: local(1000), remote: remote(2000) }),
        );
        assert.equal((newerRemotely as { keepAtPath: string }).keepAtPath, 'remote');
    });

    it('keeps both when the remote carries no modification time', async () => {
        const result = await resolver('prefer-newest', stubDrive().drive).resolve(
            context({ local: local(2000), remote: remote(undefined) }),
        );
        assert.equal(result.action, 'keep-both');
    });

    it('keeps both on an exact tie rather than picking arbitrarily', async () => {
        const result = await resolver('prefer-newest', stubDrive().drive).resolve(
            context({ local: local(1500), remote: remote(1500) }),
        );
        assert.equal(result.action, 'keep-both');
    });
});

describe('ConflictResolver — manual', () => {
    it('defers without touching either copy', async () => {
        const { drive, calls } = stubDrive();
        const result = await resolver('manual', drive).resolve(context());
        assert.equal(result.action, 'defer');
        assert.deepEqual(calls, []);
    });
});

describe('ConflictResolver — merge', () => {
    const ancestor = 'line one\nline two\nline three';

    it('combines edits made to different parts of the note', async () => {
        const { drive } = stubDrive({
            revisions: { 'rev-1': ancestor, 'rev-2': 'line one\nline two\nLINE THREE' },
        });

        const result = await resolver('merge', drive).resolve(
            context({ readLocalText: async () => 'LINE ONE\nline two\nline three' }),
        );

        assert.equal(result.action, 'take-merged');
        assert.equal(
            new TextDecoder().decode((result as Extract<Resolution, { action: 'take-merged' }>).content),
            'LINE ONE\nline two\nLINE THREE',
        );
    });

    it('fetches the ancestor by the revision uid the last sync recorded', async () => {
        const { drive, calls } = stubDrive({
            revisions: { 'rev-1': ancestor, 'rev-2': ancestor },
        });
        await resolver('merge', drive).resolve(context({ readLocalText: async () => ancestor }));
        assert.ok(calls.includes('revision:rev-1'), `expected the base revision to be fetched, got ${calls}`);
    });

    it('fetches the Drive side by the revision the conflict was found on, not the active one', async () => {
        const { drive, calls } = stubDrive({
            revisions: { 'rev-1': ancestor, 'rev-2': ancestor },
            files: { 'node-1': 'a newer revision uploaded since' },
        });
        await resolver('merge', drive).resolve(context({ readLocalText: async () => ancestor }));
        assert.ok(calls.includes('revision:rev-2'), `expected the decided revision to be fetched, got ${calls}`);
        assert.ok(!calls.includes('file:node-1'), `expected no download of the active revision, got ${calls}`);
    });

    it('keeps both when the edits overlap', async () => {
        const { drive } = stubDrive({
            revisions: { 'rev-1': ancestor, 'rev-2': 'line one\nREMOTE\nline three' },
        });

        const result = await resolver('merge', drive).resolve(
            context({ readLocalText: async () => 'line one\nLOCAL\nline three' }),
        );
        assert.equal(result.action, 'keep-both');
    });

    it('keeps both when the ancestor revision is no longer on Drive', async () => {
        // Drive prunes revision history depending on the plan, so the merge has
        // to degrade rather than fail.
        const { drive } = stubDrive({ revisions: { 'rev-2': 'remote text' } });

        const result = await resolver('merge', drive).resolve(context());
        assert.equal(result.action, 'keep-both');
    });

    it('does not download anything to merge a binary attachment', async () => {
        const { drive, calls } = stubDrive({ revisions: { 'rev-1': 'x' }, files: { 'node-1': 'y' } });
        const result = await resolver('merge', drive).resolve(context({ path: 'clips/demo.mp4' }));
        assert.equal(result.action, 'keep-both');
        assert.deepEqual(calls, []);
    });

    it('keeps both when there is no recorded ancestor at all', async () => {
        const { drive, calls } = stubDrive();
        const result = await resolver('merge', drive).resolve(
            context({ reason: 'both-created', base: undefined }),
        );
        assert.equal(result.action, 'keep-both');
        assert.deepEqual(calls, []);
    });
});
