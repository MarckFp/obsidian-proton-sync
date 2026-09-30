import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SyncSummary } from '../src/sync/engine';
import { statusIcon, statusLabel, timeAgo } from '../src/ui/syncStatus';

const base: SyncSummary = {
    status: 'idle',
    lastSyncedAt: null,
    lastError: null,
    conflicts: 0,
    uploaded: 0,
    downloaded: 0,
    progress: null,
    transfer: null,
};

describe('statusLabel', () => {
    it('says how long ago an idle sync finished', () => {
        assert.equal(statusLabel({ ...base, lastSyncedAt: Date.now() - 5 * 60_000 }), 'Synced 5m ago');
    });

    it('shows pass progress, and a large transfer in preference to it', () => {
        const syncing = { ...base, status: 'syncing' as const, progress: { done: 12, total: 340 } };
        assert.equal(statusLabel(syncing), 'Syncing 12/340');
        assert.equal(
            statusLabel({
                ...syncing,
                transfer: { path: 'media/lecture.mp4', direction: 'upload', bytes: 45, total: 100 },
            }),
            '↑ lecture.mp4 45%',
        );
    });

    it('puts conflicts above everything else, in words and icon', () => {
        const summary = { ...base, status: 'syncing' as const, conflicts: 2 };
        assert.equal(statusLabel(summary), '2 conflicts');
        assert.equal(statusIcon(summary), 'alert-circle');
    });

    it('names the paused and Wi-Fi states', () => {
        assert.equal(statusLabel({ ...base, status: 'paused' }), 'Paused');
        assert.equal(statusLabel({ ...base, status: 'waiting-for-wifi' }), 'Waiting for Wi-Fi');
    });
});

describe('timeAgo', () => {
    it('rounds to the largest sensible unit', () => {
        const now = 1_000_000_000;
        assert.equal(timeAgo(now - 30_000, now), 'just now');
        assert.equal(timeAgo(now - 3 * 3_600_000, now), '3h ago');
        assert.equal(timeAgo(now - 2 * 86_400_000, now), '2d ago');
    });
});
