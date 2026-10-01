/**
 * Several devices syncing one vault through one Drive, driven by a random but
 * reproducible sequence of what users do: edit, create, delete and rename
 * notes, stop watching for a while (paused, closed, events missed), restart,
 * sync now. After a final round of syncing, every device must hold the same
 * notes as Drive, and no text anyone typed may be lost, except text the user
 * deleted themselves.
 *
 * Every edit writes a unique token, so "nothing lost" can be checked line by
 * line. A token counts as deleted only when the device that deleted a note had
 * that token in its copy; an edit made elsewhere that the deleting device had
 * not seen must survive.
 *
 * A failure prints the seed and the steps, so it can be replayed: set
 * `SIM_SEED` to run that seed alone, and `SIM_SEEDS`/`SIM_STEPS` to run more.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ProtonDriveClient } from '@protontech/drive-sdk';

import { DEFAULT_SETTINGS, type PluginSettings } from '../src/settings';
import { SyncEngine } from '../src/sync/engine';
import { SyncState } from '../src/sync/state';
import type { ConflictPolicy } from '../src/sync/types';
import { Logger } from '../src/util/logger';
import { FakeDrive, MemoryVault, SYNC_ROOT } from './support/fakes';

const SILENT = new Logger('error');
const PLUGIN_DIR = '.obsidian/plugins/proton-drive-sync';
const NAMES = ['a.md', 'b.md', 'c.md', 'Folder/d.md', 'Folder/e.md', 'Other/f.md'];

/** Small, seedable PRNG (mulberry32), so a failing run can be replayed. */
function random(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

class Device {
    engine!: SyncEngine;
    /** False while it is not told about local changes: paused, closed, or missing events. */
    watching = true;
    readonly vault = new MemoryVault();

    constructor(
        readonly name: string,
        private readonly drive: FakeDrive,
        private readonly policy: ConflictPolicy,
    ) {
        // As in a real vault, the plugin's folder exists from the start.
        this.vault.mkdir(PLUGIN_DIR);
    }

    async start(): Promise<void> {
        const state = new SyncState(this.vault.adapter(), `${PLUGIN_DIR}/sync-state.json`, SILENT);
        await state.load('me@proton.me', SYNC_ROOT);
        const settings: PluginSettings = {
            ...DEFAULT_SETTINGS,
            uploadDebounceMs: 0,
            deviceName: this.name,
            conflictPolicy: this.policy,
            transferConcurrency: 2,
        };
        this.engine = new SyncEngine(
            this.vault.app(),
            state,
            settings,
            SILENT,
            { onChange: () => undefined, onConflict: () => undefined },
            { configDir: '.obsidian', pluginDir: PLUGIN_DIR, pluginId: 'proton-drive-sync' },
        );
        await this.engine.start(this.drive.client() as unknown as ProtonDriveClient, SYNC_ROOT);
        await this.settle();
    }

    async stop(): Promise<void> {
        await this.engine.stop();
    }

    /** Let batched events and queued passes finish. */
    async settle(): Promise<void> {
        for (let i = 0; i < 3; i++) {
            await new Promise((resolve) => setTimeout(resolve, 2));
            await (this.engine as unknown as { queue: Promise<void> }).queue;
        }
    }

    notes(): Map<string, string> {
        return new Map(this.vault.notePaths().map((path) => [path, this.vault.read(path)!]));
    }
}

type Outcome = { log: string[] };

async function simulate(seed: number, steps: number, policy: ConflictPolicy): Promise<Outcome> {
    const rand = random(seed);
    const pick = <T>(items: T[]): T => items[Math.floor(rand() * items.length)];
    const drive = new FakeDrive();
    drive.autoEvents = true;
    const devices = [new Device('laptop', drive, policy), new Device('phone', drive, policy), new Device('tablet', drive, policy)];
    for (const device of devices) {
        await device.start();
    }

    const log: string[] = [];
    const typed = new Set<string>();
    const deleted = new Set<string>();
    let counter = 0;
    const token = () => `tok-${seed}-${counter++}`;

    for (let step = 0; step < steps; step++) {
        const device = pick(devices);
        const notes = device.vault.notePaths();
        const roll = rand();

        if (roll < 0.3 && notes.length > 0) {
            const path = pick(notes);
            const added = token();
            typed.add(added);
            device.vault.write(path, `${device.vault.read(path)}\n${added}`);
            log.push(`${device.name}: edit ${path} +${added}`);
            if (device.watching) {
                device.engine.onVaultChange(path);
            }
        } else if (roll < 0.45) {
            const path = pick(NAMES);
            const added = token();
            typed.add(added);
            const existing = device.vault.read(path);
            device.vault.write(path, existing === undefined ? added : `${existing}\n${added}`);
            log.push(`${device.name}: write ${path} +${added}`);
            if (device.watching) {
                device.engine.onVaultChange(path);
            }
        } else if (roll < 0.55 && notes.length > 0) {
            const path = pick(notes);
            for (const line of device.vault.read(path)!.split('\n')) {
                deleted.add(line);
            }
            device.vault.remove(path);
            log.push(`${device.name}: delete ${path}`);
            if (device.watching) {
                device.engine.onVaultChange(path);
            }
        } else if (roll < 0.65 && notes.length > 0) {
            const from = pick(notes);
            const to = pick(NAMES.filter((name) => !notes.includes(name)).concat([`renamed-${counter++}.md`]));
            device.vault.rename(from, to);
            log.push(`${device.name}: rename ${from} -> ${to}`);
            if (device.watching) {
                device.engine.onVaultRename(from, to, false);
            }
        } else if (roll < 0.72) {
            device.watching = !device.watching;
            log.push(`${device.name}: ${device.watching ? 'watching again' : 'stops watching'}`);
            if (device.watching) {
                await device.engine.syncNow();
            }
        } else if (roll < 0.78) {
            log.push(`${device.name}: restart`);
            await device.stop();
            await device.start();
            device.watching = true;
        } else if (roll < 0.88) {
            log.push(`${device.name}: poll`);
            if (device.watching) {
                device.engine.pollNow();
            }
        } else {
            log.push(`${device.name}: sync now`);
            await device.engine.syncNow();
        }
        await device.settle();
    }

    // Everyone back, and syncing until nothing moves.
    for (let round = 0; round < 4; round++) {
        for (const device of devices) {
            device.watching = true;
            await device.engine.syncNow();
            await device.settle();
            device.engine.pollNow();
            await device.settle();
        }
    }

    const where = () => `seed ${seed}, policy ${policy}\n${log.join('\n')}`;
    const onDrive = new Map(drive.notePaths().map((path) => [path, drive.text(path)!]));
    for (const device of devices) {
        assert.deepEqual(device.notes(), onDrive, `${device.name} differs from Drive after syncing (${where()})`);
    }
    const everything = [...onDrive.values()].join('\n');
    for (const added of typed) {
        if (!deleted.has(added)) {
            assert.ok(everything.includes(added), `"${added}" was lost (${where()})`);
        }
    }

    for (const device of devices) {
        await device.stop();
    }
    return { log };
}

const fixedSeed = process.env.SIM_SEED === undefined ? null : Number(process.env.SIM_SEED);
const seeds = fixedSeed === null ? Array.from({ length: Number(process.env.SIM_SEEDS ?? 8) }, (_, i) => i + 1) : [fixedSeed];
const steps = Number(process.env.SIM_STEPS ?? 40);

describe('Simulation — three devices, one vault', () => {
    for (const policy of ['keep-both', 'merge'] as ConflictPolicy[]) {
        for (const seed of seeds) {
            it(`converges without losing text (policy ${policy}, seed ${seed})`, async () => {
                await simulate(seed, steps, policy);
            });
        }
    }
});
