import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Limiter, runPooled } from '../src/util/pool';

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

describe('Limiter', () => {
    it('lets no more than the limit through, and serves waiters in order', async () => {
        const limiter = new Limiter(2);
        let active = 0;
        let peak = 0;
        const started: number[] = [];
        await Promise.all(
            Array.from({ length: 6 }, (_, i) =>
                limiter.run(async () => {
                    started.push(i);
                    active++;
                    peak = Math.max(peak, active);
                    await new Promise((resolve) => setTimeout(resolve, 2));
                    active--;
                }),
            ),
        );
        assert.equal(peak, 2);
        assert.deepEqual(started, [0, 1, 2, 3, 4, 5]);
    });

    it('frees the slot when a task fails', async () => {
        const limiter = new Limiter(1);
        await assert.rejects(limiter.run(async () => Promise.reject(new Error('boom'))));
        assert.equal(await limiter.run(async () => 'next'), 'next');
    });
});

describe('Limiter with a changing limit', () => {
    it('lets more through when the limit rises, without breaking the queue order', async () => {
        let limit = 1;
        const limiter = new Limiter(() => limit);
        let active = 0;
        let peak = 0;
        const started: number[] = [];
        const tasks = Array.from({ length: 6 }, (_, i) =>
            limiter.run(async () => {
                started.push(i);
                active++;
                peak = Math.max(peak, active);
                if (i === 0) {
                    limit = 3;
                }
                await new Promise((resolve) => setTimeout(resolve, 3));
                active--;
            }),
        );
        await Promise.all(tasks);
        assert.deepEqual(started, [0, 1, 2, 3, 4, 5]);
        assert.equal(peak, 3);
    });
});
