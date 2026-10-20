import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { ListingSchedule } from '../src/ui/listingSchedule';

/** Let a listing that has been started finish. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

function schedule(options: { intervalSeconds?: () => number; allowed?: () => boolean; list?: () => Promise<void> } = {}) {
    const listed: number[] = [];
    const listing = new ListingSchedule({
        list:
            options.list ??
            (async () => {
                listed.push(Date.now());
            }),
        intervalSeconds: options.intervalSeconds ?? (() => 30),
        allowed: options.allowed ?? (() => true),
    });
    return { listing, listed };
}

describe('ListingSchedule', () => {
    beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 }));
    afterEach(() => mock.timers.reset());

    it('lists at once, then again each time it is due', async () => {
        const { listing, listed } = schedule();
        listing.check();
        await settle();
        assert.deepEqual(listed, [1_000_000]);

        mock.timers.tick(29_000);
        await settle();
        assert.equal(listed.length, 1);
        mock.timers.tick(1_000);
        await settle();
        assert.deepEqual(listed, [1_000_000, 1_030_000]);
    });

    it('holds off while not allowed, and lists as soon as it is again', async () => {
        let allowed = false;
        const { listing, listed } = schedule({ allowed: () => allowed });
        listing.check();
        mock.timers.tick(60_000);
        await settle();
        assert.equal(listed.length, 0);

        allowed = true;
        listing.check();
        await settle();
        assert.equal(listed.length, 1);

        allowed = false;
        listing.check();
        mock.timers.tick(120_000);
        await settle();
        assert.equal(listed.length, 1, 'the listing that was due is called off');
    });

    it('brings the next listing forward when the pace quickens', async () => {
        let interval = 600;
        const { listing, listed } = schedule({ intervalSeconds: () => interval });
        listing.check();
        await settle();

        mock.timers.tick(60_000);
        interval = 30;
        listing.check();
        await settle();
        assert.equal(listed.length, 2, 'overdue at the quicker pace, so listed at once');
    });

    it('lists when asked, and waits a full interval from then', async () => {
        const { listing, listed } = schedule();
        listing.check();
        await settle();
        mock.timers.tick(20_000);
        await listing.listNow();
        assert.equal(listed.length, 2);

        mock.timers.tick(20_000);
        await settle();
        assert.equal(listed.length, 2);
        mock.timers.tick(10_000);
        await settle();
        assert.equal(listed.length, 3);
    });

    it('never starts a listing while one is under way', async () => {
        let finish!: () => void;
        let started = 0;
        const { listing } = schedule({
            list: () => {
                started++;
                return new Promise<void>((resolve) => (finish = resolve));
            },
        });
        listing.check();
        mock.timers.tick(120_000);
        listing.check();
        assert.equal(started, 1);

        finish();
        await settle();
        assert.equal(started, 1, 'the next one waits its interval from the end of this one');
    });

    it('lists at once after being reset', async () => {
        const { listing, listed } = schedule();
        listing.check();
        await settle();
        listing.reset();
        listing.check();
        await settle();
        assert.equal(listed.length, 2);
    });
});
