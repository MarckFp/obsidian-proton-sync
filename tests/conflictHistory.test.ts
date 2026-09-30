import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConflictHistory } from '../src/sync/conflictHistory';
import { Logger } from '../src/util/logger';
import { MemoryVault } from './support/fakes';

const PATH = '.obsidian/plugins/proton-drive-sync/conflict-history.json';

function history(vault: MemoryVault, clock = { now: 1000 }) {
    return new ConflictHistory(vault.adapter(), PATH, new Logger('error'), () => clock.now++);
}

describe('ConflictHistory', () => {
    it('keeps conflicts newest first, and across a restart', async () => {
        const vault = new MemoryVault();
        const first = history(vault);
        await first.load();
        await first.add({ path: 'a.md', reason: 'both-modified', outcome: 'kept-both', copyPath: 'a (conflict).md' });
        await first.add({ path: 'b.md', reason: 'both-created', outcome: 'merged' });

        const reloaded = history(vault);
        await reloaded.load();
        assert.deepEqual(
            reloaded.entries().map((record) => [record.path, record.outcome, record.time]),
            [
                ['b.md', 'merged', 1001],
                ['a.md', 'kept-both', 1000],
            ],
        );
        assert.equal(reloaded.entries()[1].copyPath, 'a (conflict).md');
    });

    it('keeps only the most recent 200', async () => {
        const vault = new MemoryVault();
        const log = history(vault);
        for (let i = 0; i < 205; i++) {
            await log.add({ path: `${i}.md`, reason: 'both-modified', outcome: 'kept-local' });
        }
        assert.equal(log.entries().length, 200);
        assert.equal(log.entries()[0].path, '204.md');
        assert.equal(log.entries().at(-1)?.path, '5.md');
    });

    it('removes one entry, or all of them', async () => {
        const vault = new MemoryVault();
        const log = history(vault);
        await log.add({ path: 'a.md', reason: 'both-modified', outcome: 'kept-local' });
        await log.add({ path: 'b.md', reason: 'both-modified', outcome: 'kept-remote' });

        await log.remove(log.entries()[0]);
        assert.deepEqual(log.entries().map((record) => record.path), ['a.md']);

        await log.clear();
        const reloaded = history(vault);
        await reloaded.load();
        assert.deepEqual(reloaded.entries(), []);
    });

    it('starts afresh from a damaged file instead of failing', async () => {
        const vault = new MemoryVault();
        vault.write(PATH, '{not json');
        const log = history(vault);
        await log.load();
        assert.deepEqual(log.entries(), []);
    });
});
