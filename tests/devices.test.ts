import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import type { ProtonDriveClient } from '@protontech/drive-sdk';

import { DEVICES_FOLDER } from '../src/settings';
import {
    DeviceList,
    DeviceRegistry,
    nextRequestAt,
    RECORD_EVERY_MS,
    recordDue,
    standingOf,
    type DeviceRecord,
    type DeviceRequest,
} from '../src/sync/devices';
import { DriveIO } from '../src/sync/drive';
import type { SyncSummary } from '../src/sync/engine';
import { Logger } from '../src/util/logger';
import { FakeDrive, SYNC_ROOT } from './support/fakes';

const SILENT = new Logger('error');

function registryOn(drive: FakeDrive): DeviceRegistry {
    return new DeviceRegistry(new DriveIO(drive.client() as unknown as ProtonDriveClient, SILENT), SYNC_ROOT, SILENT);
}

function record(id: string, overrides: Partial<DeviceRecord> = {}): DeviceRecord {
    return {
        id,
        name: `Device ${id}`,
        platform: 'Linux',
        pluginVersion: '1.0.0',
        account: 'me@proton.me',
        since: 1,
        seen: 1,
        lastSyncedAt: 1,
        status: 'idle',
        handled: 0,
        ...overrides,
    };
}

function request(state: DeviceRequest['state'], at: number): DeviceRequest {
    return { state, at, by: 'other', byName: 'Laptop' };
}

/** A file of the list as written to Drive. */
function written(drive: FakeDrive, name: string): Record<string, unknown> {
    return JSON.parse(drive.text(`${DEVICES_FOLDER}/${name}`)!) as Record<string, unknown>;
}

describe('DeviceRegistry', () => {
    it('reads nothing, and makes nothing, before any device has written', async () => {
        const drive = new FakeDrive();
        const registry = registryOn(drive);
        assert.equal(await registry.request('me'), null);
        assert.deepEqual(await registry.list(), []);
        assert.equal(drive.at(DEVICES_FOLDER), undefined);
    });

    it('makes its folder on the first write, and writes later records as new revisions', async () => {
        const drive = new FakeDrive();
        const registry = registryOn(drive);
        await registry.publish(record('me'));
        const node = drive.at(`${DEVICES_FOLDER}/device-me.json`)!;
        assert.equal(written(drive, 'device-me.json').format, 1);
        assert.equal(written(drive, 'device-me.json').name, 'Device me');

        await registry.publish(record('me', { name: 'Renamed' }));
        assert.equal(drive.at(`${DEVICES_FOLDER}/device-me.json`)!.uid, node.uid);
        assert.equal(node.history.length, 2);
        assert.deepEqual(await registry.record('me'), record('me', { name: 'Renamed' }));
    });

    it('lists each device with its record and the last request left for it', async () => {
        const drive = new FakeDrive();
        const mine = registryOn(drive);
        const theirs = registryOn(drive);
        await mine.publish(record('me'));
        await theirs.publish(record('laptop'));
        await theirs.ask('me', request('paused', 100));

        const entries = (await mine.list()).sort((a, b) => a.id.localeCompare(b.id));
        assert.deepEqual(
            entries.map((entry) => [entry.id, entry.record?.name, entry.request?.state ?? null]),
            [
                ['laptop', 'Device laptop', null],
                ['me', 'Device me', 'paused'],
            ],
        );
        assert.deepEqual(await mine.request('me'), request('paused', 100));
    });

    it('writes over a request another device made since it last looked', async () => {
        const drive = new FakeDrive();
        const mine = registryOn(drive);
        const theirs = registryOn(drive);
        await mine.publish(record('me'));
        await theirs.ask('tablet', request('paused', 100));

        await mine.ask('tablet', request('active', 101));
        assert.equal(written(drive, 'request-tablet.json').state, 'active');
        assert.equal(drive.at(`${DEVICES_FOLDER}/request-tablet.json`)!.history.length, 2);
    });

    it('takes over a name held by an upload another device never finished', async () => {
        const drive = new FakeDrive();
        drive.leaveDraft(`${DEVICES_FOLDER}/device-me.json`);
        await registryOn(drive).publish(record('me'));
        assert.equal(written(drive, 'device-me.json').id, 'me');
    });

    it('ignores a file it cannot read', async () => {
        const drive = new FakeDrive();
        drive.put(`${DEVICES_FOLDER}/request-me.json`, 'not a request');
        assert.equal(await registryOn(drive).request('me'), null);
    });

    it('forgets a device by sending its files to the trash', async () => {
        const drive = new FakeDrive();
        const registry = registryOn(drive);
        await registry.publish(record('old'));
        await registry.ask('old', request('removed', 5));

        await registry.forget('old');
        assert.deepEqual(await registry.list(), []);
        assert.equal(drive.trashedAt(`${DEVICES_FOLDER}/device-old.json`)?.trashed, true);
    });

    it('tells changes to the list apart from changes to the vault', () => {
        const registry = registryOn(new FakeDrive());
        assert.equal(registry.takeChange({ nodeUid: 'file-1', parentNodeUid: 'list' }), false);
        registry.knowFolder('list');
        assert.equal(registry.takeChange({ nodeUid: 'file-1', parentNodeUid: 'list' }), true);
        assert.equal(registry.takeChange({ nodeUid: 'list', parentNodeUid: SYNC_ROOT }), true);
        assert.equal(registry.takeChange({ nodeUid: 'note', parentNodeUid: SYNC_ROOT }), false);
    });
});

describe('the device list’s rules', () => {
    it('writes a record for any change the list shows, and otherwise hourly', () => {
        const last = record('me', { seen: 0, lastSyncedAt: 0 });
        assert.equal(recordDue(null, last, 0), true);
        assert.equal(recordDue(last, { ...last, seen: 60_000 }, 60_000), false);
        assert.equal(recordDue(last, { ...last, name: 'Renamed' }, 60_000), true);
        assert.equal(recordDue(last, { ...last, status: 'paused' }, 60_000), true);
        assert.equal(recordDue(last, { ...last, handled: 7 }, 60_000), true);
        assert.equal(recordDue(last, { ...last, lastSyncedAt: 60_000 }, 60_000), false);
        assert.equal(recordDue(last, { ...last, lastSyncedAt: RECORD_EVERY_MS }, RECORD_EVERY_MS), true);
        assert.equal(recordDue(null, { ...last, status: 'syncing' }, 0), false, 'not while a sync is under way');
    });

    it('dates a request after any before it, whatever the clocks say', () => {
        assert.equal(nextRequestAt({ record: null, request: null }, 500), 500);
        assert.equal(nextRequestAt({ record: null, request: request('paused', 900) }, 500), 901);
        assert.equal(nextRequestAt({ record: record('x', { handled: 950 }), request: null }, 500), 951);
    });

    it('shows a request until the device acts on it, then what it recorded', () => {
        assert.deepEqual(standingOf({ record: record('x', { handled: 5 }), request: request('paused', 6) }), {
            kind: 'asked',
            state: 'paused',
        });
        assert.deepEqual(
            standingOf({ record: record('x', { handled: 6, status: 'paused' }), request: request('paused', 6) }),
            { kind: 'recorded', status: 'paused' },
        );
        assert.deepEqual(standingOf({ record: null, request: null }), { kind: 'unknown' });
    });
});

describe('DeviceList', () => {
    beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 }));
    afterEach(() => mock.timers.reset());

    const RECORD = `${DEVICES_FOLDER}/device-me.json`;

    function summary(overrides: Partial<SyncSummary> = {}): SyncSummary {
        return {
            status: 'idle',
            lastSyncedAt: 1_000_000,
            lastError: null,
            conflicts: 0,
            pending: 0,
            progressFraction: null,
            progress: null,
            transfer: null,
            ...overrides,
        };
    }

    function deviceList(drive: FakeDrive) {
        let handled = 0;
        const list = new DeviceList(
            {
                self: () => ({ id: 'me', name: 'Laptop', platform: 'Linux', pluginVersion: '1.0.0', account: 'me@proton.me' }),
                handled: () => handled,
                setHandled: (at) => {
                    handled = at;
                },
            },
            SILENT,
        );
        list.open(registryOn(drive));
        return { list, handled: () => handled };
    }

    /** Let work started by a timer run on, until `done` or for a while; the hashing behind a write is truly asynchronous. */
    async function runUntil(done: () => boolean = () => false): Promise<void> {
        for (let turn = 0; turn < 2000 && !done(); turn++) {
            await new Promise((resolve) => setImmediate(resolve));
        }
    }

    it('acts on each request once', async () => {
        const drive = new FakeDrive();
        await registryOn(drive).ask('me', request('paused', 100));
        const { list, handled } = deviceList(drive);

        assert.deepEqual(await list.pendingRequest(), request('paused', 100));
        assert.equal(handled(), 100);
        assert.equal(await list.pendingRequest(), null);
    });

    it('syncs on as usual when the list cannot be read', async () => {
        const drive = new FakeDrive();
        await registryOn(drive).ask('me', request('removed', 100));
        const { list, handled } = deviceList(drive);
        drive.failLookups = true;

        assert.equal(await list.pendingRequest(), null);
        assert.equal(handled(), 0);
    });

    it('lists itself after a sync, then writes again only for a change or once an hour', async () => {
        const drive = new FakeDrive();
        const { list } = deviceList(drive);

        list.noteStatus(summary({ status: 'syncing' }));
        mock.timers.tick(60_000);
        await runUntil();
        assert.equal(drive.at(RECORD), undefined, 'not while a sync is under way');

        list.noteStatus(summary());
        mock.timers.tick(10_000);
        await runUntil(() => drive.at(RECORD) !== undefined);
        assert.equal(written(drive, 'device-me.json').status, 'idle');

        list.noteStatus(summary({ lastSyncedAt: Date.now() }));
        mock.timers.tick(30 * 60_000);
        await runUntil();
        assert.equal(drive.at(RECORD)!.history.length, 1, 'a newer sync alone waits for the hour');

        mock.timers.tick(31 * 60_000);
        list.noteStatus(summary({ lastSyncedAt: Date.now() }));
        mock.timers.tick(10_000);
        await runUntil(() => drive.at(RECORD)!.history.length === 2);
        assert.equal(drive.at(RECORD)!.history.length, 2);
    });

    it('records its removal straight away, keeping the date it first listed itself', async () => {
        const drive = new FakeDrive();
        await registryOn(drive).publish(record('me', { since: 5 }));
        const { list } = deviceList(drive);

        await list.recordRemoved();
        assert.equal(written(drive, 'device-me.json').status, 'removed');
        assert.equal(written(drive, 'device-me.json').since, 5);
    });
});
