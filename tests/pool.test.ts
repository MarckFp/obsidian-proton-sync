import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runPooled } from '../src/util/pool';

describe('runPooled', () => {
    it('never runs more tasks at once than allowed, and runs them all', async () => {
        let active = 0;
        let peak = 0;
        const done: number[] = [];
        const tasks = Array.from({ length: 10 }, (_, i) => async () => {
            active++;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 1));
            active--;
            done.push(i);
        });

        await runPooled(tasks, 3, () => assert.fail('no task fails'));

        assert.equal(peak, 3);
        assert.equal(done.length, 10);
    });

    it('reports a failure by index and carries on with the rest', async () => {
        const failed: number[] = [];
        let ran = 0;
        const tasks = [0, 1, 2].map((i) => async () => {
            ran++;
            if (i === 1) {
                throw new Error('boom');
            }
        });

        await runPooled(tasks, 1, (_error, index) => failed.push(index));

        assert.deepEqual(failed, [1]);
        assert.equal(ran, 3);
    });
});
