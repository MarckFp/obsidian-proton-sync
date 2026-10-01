import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { DriveEventType, type ProtonDriveClient } from '@protontech/drive-sdk';

import { DEFAULT_SETTINGS, type PluginSettings } from '../src/settings';
import { SyncEngine, type ConflictEvent, type EngineEnvironment } from '../src/sync/engine';
import { SyncState } from '../src/sync/state';
import { Logger } from '../src/util/logger';
import { requestStats } from '../src/util/requestStats';
import { FakeDrive, MemoryVault, SYNC_ROOT, VOLUME_ROOT } from './support/fakes';

const SILENT = new Logger('error');
const PLUGIN_DIR = '.obsidian/plugins/proton-drive-sync';

const running: SyncEngine[] = [];
afterEach(async () => {
    await Promise.all(running.splice(0).map((engine) => engine.stop()));
});

async function setup(
    options: {
        vault?: MemoryVault;
        drive?: FakeDrive;
        settings?: Partial<PluginSettings>;
        environment?: EngineEnvironment;
        start?: boolean;
        onSettingsAdopted?: (paths: string[]) => void;
    } = {},
) {
    const vault = options.vault ?? new MemoryVault();
    const drive = options.drive ?? new FakeDrive();
    const state = new SyncState(vault.adapter(), `${PLUGIN_DIR}/sync-state.json`, SILENT);
    await state.load('me@proton.me', SYNC_ROOT);

    const conflicts: ConflictEvent[] = [];
    const adopted: string[] = [];
    const settings: PluginSettings = {
        ...DEFAULT_SETTINGS,
        uploadDebounceMs: 0,
        deviceName: 'laptop',
        ...options.settings,
    };
    const engine = new SyncEngine(
        vault.app(),
        state,
        settings,
        SILENT,
        {
            onChange: () => undefined,
            onConflict: (event) => conflicts.push(event),
            onSettingsAdopted: (paths) => {
                adopted.push(...paths);
                options.onSettingsAdopted?.(paths);
            },
        },
        { configDir: '.obsidian', pluginDir: PLUGIN_DIR, pluginId: 'proton-drive-sync' },
        options.environment,
    );
    running.push(engine);
    if (options.start ?? true) {
        await engine.start(drive.client() as unknown as ProtonDriveClient, SYNC_ROOT);
    }

    /** Wait for batched vault events to be delivered and processed. */
    const settled = async () => {
        for (let i = 0; i < 3; i++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            await (engine as unknown as { queue: Promise<void> }).queue;
        }
    };
    return { vault, drive, state, engine, conflicts, adopted, settled, settings };
}

describe('SyncEngine — renaming a new note', () => {
    it('renames the node on Drive when the note was already uploaded', async () => {
        const { vault, drive, engine, settled } = await setup();

        vault.write('Untitled.md', '');
        engine.onVaultChange('Untitled.md');
        await settled();
        const uploaded = drive.at('Untitled.md');
        assert.ok(uploaded, 'the new note reached Drive');

        vault.rename('Untitled.md', 'Idea.md');
        engine.onVaultRename('Untitled.md', 'Idea.md', false);
        await settled();

        assert.deepEqual(drive.notePaths(), ['Idea.md']);
        assert.equal(drive.at('Idea.md')?.uid, uploaded.uid, 'same node, so its history is kept');
        assert.deepEqual(vault.notePaths(), ['Idea.md']);

        // The original bug: the next full sync brought "Untitled" back.
        await engine.syncNow();
        assert.deepEqual(vault.notePaths(), ['Idea.md']);
        assert.deepEqual(drive.notePaths(), ['Idea.md']);
    });

    it('uploads under the new name when the rename beats the first upload', async () => {
        const { vault, drive, engine, settled } = await setup({ settings: { uploadDebounceMs: 50 } });

        vault.write('Untitled.md', '');
        engine.onVaultChange('Untitled.md');
        vault.rename('Untitled.md', 'Idea.md');
        engine.onVaultRename('Untitled.md', 'Idea.md', false);
        await new Promise((resolve) => setTimeout(resolve, 80));
        await settled();

        assert.deepEqual(drive.notePaths(), ['Idea.md']);
        assert.deepEqual(vault.notePaths(), ['Idea.md']);
    });

    it('moves a renamed folder as one node, keeping every file inside it', async () => {
        const vault = new MemoryVault();
        vault.write('Projects/a.md', 'a');
        vault.write('Projects/b.md', 'b');
        const { drive, engine, settled } = await setup({ vault });
        const folder = drive.at('Projects')!;
        const file = drive.at('Projects/a.md')!;

        vault.rename('Projects', 'Work');
        engine.onVaultRename('Projects', 'Work', true);
        engine.onVaultRename('Projects/a.md', 'Work/a.md', false);
        engine.onVaultRename('Projects/b.md', 'Work/b.md', false);
        await settled();

        assert.equal(drive.at('Work')?.uid, folder.uid);
        assert.equal(drive.at('Work/a.md')?.uid, file.uid);
        assert.equal(drive.at('Projects'), undefined);
        assert.deepEqual(drive.notePaths(), ['Work/a.md', 'Work/b.md']);

        await engine.syncNow();
        assert.deepEqual(vault.notePaths(), ['Work/a.md', 'Work/b.md']);
    });
});

describe('SyncEngine — files missing from Drive', () => {
    it('uploads a local file Drive has never seen, instead of deleting it', async () => {
        const vault = new MemoryVault();
        vault.write('Local only.md', 'mine');
        const { drive } = await setup({ vault });

        assert.equal(vault.read('Local only.md'), 'mine');
        assert.equal(drive.text('Local only.md'), 'mine');
    });

    it('keeps a synced file whose node moved out of the vault folder, and uploads it again', async () => {
        const vault = new MemoryVault();
        vault.write('note.md', 'keep me');
        const { drive, engine } = await setup({ vault });
        const node = drive.at('note.md')!;

        node.parentUid = VOLUME_ROOT;
        await engine.syncNow();

        assert.equal(vault.read('note.md'), 'keep me');
        assert.equal(drive.text('note.md'), 'keep me');
    });

    it('never deletes a local file because a lookup failed', async () => {
        const vault = new MemoryVault();
        vault.write('note.md', 'keep me');
        const { drive, engine } = await setup({ vault });

        // Gone from the listing, and Drive cannot be asked where it went.
        drive.at('note.md')!.parentUid = VOLUME_ROOT;
        drive.failLookups = true;
        await engine.syncNow();

        assert.equal(vault.read('note.md'), 'keep me');
    });

    it('still removes a file that was deleted on another device', async () => {
        const vault = new MemoryVault();
        vault.write('note.md', 'old');
        const { drive, engine } = await setup({ vault });

        drive.at('note.md')!.trashed = true;
        await engine.syncNow();

        assert.equal(vault.read('note.md'), undefined);
    });

    it('keeps a local edit to a file deleted on another device, and reports it', async () => {
        const vault = new MemoryVault();
        vault.write('note.md', 'old');
        const { drive, engine, conflicts } = await setup({ vault });

        drive.at('note.md')!.trashed = true;
        vault.write('note.md', 'edited offline');
        await engine.syncNow();

        assert.equal(vault.read('note.md'), 'edited offline');
        assert.equal(drive.text('note.md'), 'edited offline');
        assert.deepEqual(
            conflicts.map((event) => [event.path, event.reason, event.outcome]),
            [['note.md', 'deleted-remotely-modified-locally', 'kept-local']],
        );
    });

    it('removes the local folder along with its files when the folder is trashed on Drive', async () => {
        const vault = new MemoryVault();
        vault.write('Old/a.md', 'a');
        vault.write('Old/b.md', 'b');
        const { drive, engine } = await setup({ vault });

        drive.at('Old')!.trashed = true;
        await engine.syncNow();

        assert.deepEqual(vault.notePaths(), []);
        assert.equal(vault.folders.has('Old'), false);
        assert.equal(drive.at('Old'), undefined, 'not recreated on Drive');
    });
});

describe('SyncEngine — renames made on another device', () => {
    it('renames the local file on a full sync, rather than deleting and downloading', async () => {
        const vault = new MemoryVault();
        vault.write('draft.md', 'text');
        const { drive, engine } = await setup({ vault });

        drive.at('draft.md')!.name = 'final.md';
        await engine.syncNow();

        assert.deepEqual(vault.notePaths(), ['final.md']);
        assert.equal(vault.read('final.md'), 'text');
        assert.deepEqual(drive.notePaths(), ['final.md']);
    });

    it('follows a rename on an incremental pass', async () => {
        const vault = new MemoryVault();
        vault.write('draft.md', 'text');
        const { drive, engine } = await setup({ vault });

        drive.at('draft.md')!.name = 'final.md';
        await engine.syncPath('draft.md');

        assert.deepEqual(vault.notePaths(), ['final.md']);
        assert.deepEqual(drive.notePaths(), ['final.md']);
    });

    it('keeps local edits to a file renamed elsewhere', async () => {
        const vault = new MemoryVault();
        vault.write('draft.md', 'text');
        const { drive, engine } = await setup({ vault });

        drive.at('draft.md')!.name = 'final.md';
        vault.write('draft.md', 'text, edited here');
        await engine.syncNow();

        assert.deepEqual(vault.notePaths(), ['final.md']);
        assert.equal(drive.text('final.md'), 'text, edited here');
    });
});

describe('SyncEngine — conflicts', () => {
    it('reports a conflict with where the other version went', async () => {
        const vault = new MemoryVault();
        vault.write('note.md', 'base');
        const { drive, engine, conflicts } = await setup({ vault });

        vault.write('note.md', 'local edit');
        drive.put('note.md', 'remote edit');
        await engine.syncNow();

        assert.equal(conflicts.length, 1);
        assert.equal(conflicts[0]!.outcome, 'kept-both');
        assert.equal(vault.read('note.md'), 'local edit');
        assert.equal(vault.read(conflicts[0]!.copyPath!), 'remote edit');
        assert.equal(drive.text(conflicts[0]!.copyPath!), 'remote edit');
    });
});

describe('SyncEngine — attachments', () => {
    it('round-trips binary content byte for byte', async () => {
        const vault = new MemoryVault();
        const bytes = new Uint8Array(4096).map((_, i) => (i * 31) % 256);
        await vault.adapter().writeBinary('assets/photo.png', bytes.buffer);
        const { drive } = await setup({ vault });

        assert.deepEqual(drive.at('assets/photo.png')?.revision?.data, bytes);

        const other = new MemoryVault();
        await setup({ vault: other, drive });
        assert.deepEqual(other.files.get('assets/photo.png')?.data, bytes);
    });
});

describe('SyncEngine — the config folder', () => {
    it('syncs settings but never this plugin’s own folder', async () => {
        const vault = new MemoryVault();
        vault.write('.obsidian/app.json', '{"theme":"dark"}');
        vault.write(`${PLUGIN_DIR}/data.json`, '{"deviceName":"laptop"}');
        vault.write(`${PLUGIN_DIR}/session.json`, '{"secret":true}');
        vault.write(`${PLUGIN_DIR}/main.js`, 'code');
        vault.write('.obsidian/workspace.json', '{}');
        const { drive } = await setup({ vault });

        assert.deepEqual(drive.filePaths(), ['.obsidian/app.json']);
    });

    it('lets Drive’s settings win when a new device joins, without conflict copies', async () => {
        const drive = new FakeDrive();
        drive.put('.obsidian/app.json', '{"theme":"dark"}');
        const vault = new MemoryVault();
        vault.write('.obsidian/app.json', '{}');
        const { conflicts } = await setup({ vault, drive });

        assert.equal(vault.read('.obsidian/app.json'), '{"theme":"dark"}');
        assert.deepEqual(
            [...vault.files.keys()].filter((path) => path.includes('conflict')),
            [],
        );
        // Settled by rule, not a conflict the user needs telling about.
        assert.deepEqual(conflicts, []);
    });
});

describe('SyncEngine — two devices saving at once', () => {
    it('keeps an edit another device uploaded while this one was uploading', async () => {
        const vault = new MemoryVault();
        vault.write('note.md', 'base');
        const { drive, engine, conflicts, settled } = await setup({ vault });

        drive.duringRevisionUpload = () => {
            drive.duringRevisionUpload = null;
            drive.put('note.md', 'saved on the phone');
        };
        vault.write('note.md', 'saved on the laptop');
        engine.onVaultChange('note.md');
        await settled();

        assert.equal(drive.text('note.md'), 'saved on the laptop');
        assert.equal(conflicts.length, 1);
        assert.equal(conflicts[0]!.outcome, 'kept-both');
        const copyPath = conflicts[0]!.copyPath!;
        assert.equal(vault.read(copyPath), 'saved on the phone');
        assert.equal(drive.text(copyPath), 'saved on the phone');
    });

    it('reports nothing for an ordinary upload', async () => {
        const vault = new MemoryVault();
        vault.write('note.md', 'base');
        const { drive, engine, conflicts, settled } = await setup({ vault });

        vault.write('note.md', 'edited');
        engine.onVaultChange('note.md');
        await settled();

        assert.equal(drive.text('note.md'), 'edited');
        assert.deepEqual(conflicts, []);
        assert.deepEqual(vault.notePaths(), ['note.md']);
    });

    it('treats a name taken on Drive mid-upload as a conflict, keeping both', async () => {
        const { vault, drive, engine, conflicts, settled } = await setup();

        drive.duringNewFileUpload = () => {
            drive.duringNewFileUpload = null;
            drive.put('Idea.md', 'from the phone');
        };
        vault.write('Idea.md', 'from the laptop');
        engine.onVaultChange('Idea.md');
        await settled();

        assert.equal(conflicts[0]?.reason, 'both-created');
        assert.equal(vault.read('Idea.md'), 'from the laptop');
        assert.equal(vault.read(conflicts[0]!.copyPath!), 'from the phone');
        assert.equal(drive.notePaths().length, 2);
    });
});

describe('SyncEngine — folders', () => {
    it('removes a folder deleted locally from Drive, once its files are gone', async () => {
        const vault = new MemoryVault();
        vault.write('Old/a.md', 'a');
        const { drive, engine, settled } = await setup({ vault });

        vault.remove('Old');
        engine.onVaultChange('Old/a.md');
        engine.onVaultFolderDelete('Old');
        await settled();

        assert.equal(drive.at('Old'), undefined);
        await engine.syncNow();
        assert.equal(vault.folders.has('Old'), false, 'not brought back');
    });

    it('keeps a folder on Drive that holds files this device has not synced yet', async () => {
        const vault = new MemoryVault();
        vault.write('Shared/a.md', 'a');
        const { drive, engine, settled } = await setup({ vault });

        drive.put('Shared/from-phone.md', 'new');
        vault.remove('Shared');
        engine.onVaultChange('Shared/a.md');
        engine.onVaultFolderDelete('Shared');
        await settled();

        assert.equal(drive.text('Shared/from-phone.md'), 'new');
    });

    it('carries a folder deletion made while the plugin was not running', async () => {
        const vault = new MemoryVault();
        vault.write('Old/a.md', 'a');
        const { drive, engine } = await setup({ vault });
        await engine.stop();

        vault.remove('Old');
        const restarted = await setup({ vault, drive });
        await restarted.engine.syncNow();

        assert.equal(drive.at('Old'), undefined);
        assert.deepEqual(vault.notePaths(), []);
    });

    it('follows a folder renamed on another device', async () => {
        const vault = new MemoryVault();
        vault.write('Projects/a.md', 'a');
        const { drive, engine } = await setup({ vault });

        drive.at('Projects')!.name = 'Work';
        await engine.syncNow();

        assert.deepEqual(vault.notePaths(), ['Work/a.md']);
        assert.equal(vault.folders.has('Projects'), false);
        assert.deepEqual(drive.notePaths(), ['Work/a.md']);
    });
});

describe('SyncEngine — scope', () => {
    it('treats moving a note into an excluded folder as removing it from Drive', async () => {
        const vault = new MemoryVault();
        vault.write('note.md', 'secret now');
        const { drive, engine, settled } = await setup({ vault, settings: { excludePatterns: ['Private/'] } });

        vault.rename('note.md', 'Private/note.md');
        engine.onVaultRename('note.md', 'Private/note.md', false);
        await settled();

        assert.deepEqual(drive.notePaths(), []);
        assert.equal(vault.read('Private/note.md'), 'secret now');
    });

    it('skips files over the size limit', async () => {
        const vault = new MemoryVault();
        vault.write('big.bin', 'x'.repeat(2 * 1024 * 1024));
        vault.write('small.md', 'ok');
        const { drive } = await setup({ vault, settings: { maxFileSizeMb: 1 } });

        assert.deepEqual(drive.notePaths(), ['small.md']);
    });

    it('picks up config changes on the next Drive check', async () => {
        const vault = new MemoryVault();
        vault.write('.obsidian/app.json', '{}');
        const { drive, engine, settled } = await setup({ vault });

        vault.write('.obsidian/app.json', '{"theme":"dark"}');
        engine.pollNow();
        await settled();

        assert.equal(drive.text('.obsidian/app.json'), '{"theme":"dark"}');
    });
});

describe('SyncEngine — manual conflict policy', () => {
    it('touches nothing, records the conflict and reports it as waiting', async () => {
        const vault = new MemoryVault();
        vault.write('note.md', 'base');
        const { drive, engine, state, conflicts } = await setup({ vault, settings: { conflictPolicy: 'manual' } });

        vault.write('note.md', 'local');
        drive.put('note.md', 'remote');
        await engine.syncNow();

        assert.equal(vault.read('note.md'), 'local');
        assert.equal(drive.text('note.md'), 'remote');
        assert.equal(state.isConflicted('note.md'), true);
        assert.equal(conflicts[0]?.outcome, 'deferred');
    });
});

describe('SyncEngine — incremental passes', () => {
    it('removes a file deleted elsewhere, and only when Drive confirms it', async () => {
        const vault = new MemoryVault();
        vault.write('note.md', 'text');
        const { drive, engine } = await setup({ vault });

        drive.at('note.md')!.trashed = true;
        drive.failLookups = true;
        await engine.syncPath('note.md');
        assert.equal(vault.read('note.md'), 'text', 'kept while Drive cannot be asked');

        drive.failLookups = false;
        await engine.syncPath('note.md');
        assert.equal(vault.read('note.md'), undefined);
    });
});

describe('SyncEngine — the Drive event feed', () => {
    /** Count full syncs from here on. */
    function countFullSyncs(engine: SyncEngine): { count: number } {
        const counter = { count: 0 };
        const target = engine as unknown as { fullSync: () => Promise<void> };
        const original = target.fullSync.bind(engine);
        target.fullSync = async () => {
            counter.count++;
            await original();
        };
        return counter;
    }

    it('does not walk the whole tree again just because the feed fast-forwarded', async () => {
        // No startup sync, so the first poll has no cursor and is answered
        // with a fast-forward, as it is after an upgrade.
        const { engine, settled } = await setup({ settings: { syncOnStartup: false } });
        const fullSyncs = countFullSyncs(engine);

        engine.pollNow();
        await settled();
        engine.pollNow();
        await settled();

        assert.equal(fullSyncs.count, 0);
    });

    it('brings in a file created on another device inside a new folder', async () => {
        const { vault, drive, engine, settled } = await setup();

        drive.put('Trips/Rome.md', 'ciao');
        const folder = drive.at('Trips')!;
        drive.emit(folder, DriveEventType.NodeCreated);
        drive.emit(drive.at('Trips/Rome.md')!, DriveEventType.NodeCreated);
        engine.pollNow();
        await settled();

        assert.equal(vault.read('Trips/Rome.md'), 'ciao');

        // Recorded, so a rename of that folder on Drive is followed too.
        folder.name = 'Travel';
        drive.emit(folder);
        engine.pollNow();
        await settled();
        assert.deepEqual(vault.notePaths(), ['Travel/Rome.md']);
    });

    it('ignores activity elsewhere in Drive without looking anything up', async () => {
        const { drive, engine, settled } = await setup();
        const elsewhere = { uid: 'photo-1', parentUid: 'photos-folder' } as Parameters<FakeDrive['emit']>[0];
        for (let i = 0; i < 20; i++) {
            drive.emit(elsewhere, DriveEventType.NodeCreated);
        }
        const before = drive.lookups;

        engine.pollNow();
        await settled();

        assert.equal(drive.lookups, before);
    });

    it('handles the events it read before the feed failed, and resumes after them', async () => {
        const { vault, drive, engine, settled } = await setup();
        drive.emit(drive.put('one.md', '1'), DriveEventType.NodeCreated);
        drive.emit(drive.put('two.md', '2'), DriveEventType.NodeCreated);
        drive.failEventsAfter = 1;

        engine.pollNow();
        await settled();
        assert.equal(vault.read('one.md'), '1');

        engine.pollNow();
        await settled();
        assert.equal(vault.read('two.md'), '2');
    });

    it('retries a change it could not look up, on the next poll', async () => {
        const vault = new MemoryVault();
        vault.write('note.md', 'old');
        const { drive, engine, settled } = await setup({ vault });

        const node = drive.put('note.md', 'new');
        drive.emit(node);
        drive.failLookups = true;
        engine.pollNow();
        await settled();
        assert.equal(vault.read('note.md'), 'old');

        drive.failLookups = false;
        engine.pollNow();
        await settled();
        assert.equal(vault.read('note.md'), 'new');
    });

    it('re-uploads a folder moved out of the synced one, instead of writing into it', async () => {
        const vault = new MemoryVault();
        vault.write('Projects/a.md', 'a');
        const { drive, engine, settled } = await setup({ vault });
        const archived = drive.at('Projects')!;

        archived.parentUid = VOLUME_ROOT;
        drive.emit(archived);
        engine.pollNow();
        await settled();

        const fresh = drive.at('Projects');
        assert.ok(fresh && fresh.uid !== archived.uid, 'a new folder in the vault folder');
        assert.equal(drive.text('Projects/a.md'), 'a');

        vault.write('Projects/a.md', 'edited');
        engine.onVaultChange('Projects/a.md');
        await settled();
        assert.equal(drive.text('Projects/a.md'), 'edited');
        const archivedFile = [...drive.nodes.values()].find((node) => node.parentUid === archived.uid);
        assert.equal(archivedFile?.revision && new TextDecoder().decode(archivedFile.revision.data), 'a');
    });
});

describe('SyncEngine — review fixes', () => {
    it('resolves one conflict as chosen, leaving the others waiting', async () => {
        const vault = new MemoryVault();
        vault.write('a.md', 'base a');
        vault.write('b.md', 'base b');
        const { drive, engine, state } = await setup({
            vault,
            settings: { conflictPolicy: 'manual', keepConflictCopies: false },
        });
        vault.write('a.md', 'local a');
        vault.write('b.md', 'local b');
        drive.put('a.md', 'remote a');
        drive.put('b.md', 'remote b');
        await engine.syncNow();

        await engine.resolveConflict('a.md', 'prefer-remote');
        await engine.syncNow();

        assert.equal(vault.read('a.md'), 'remote a');
        assert.equal(vault.read('b.md'), 'local b', 'untouched');
        assert.equal(state.isConflicted('b.md'), true);
    });

    it('pairs up a file created with the same bytes on two devices at once', async () => {
        const { vault, drive, engine, conflicts, settled } = await setup();
        drive.duringNewFileUpload = () => {
            drive.duringNewFileUpload = null;
            drive.put('Same.md', 'identical');
        };
        vault.write('Same.md', 'identical');
        engine.onVaultChange('Same.md');
        await settled();

        assert.deepEqual(conflicts, []);
        assert.deepEqual(drive.notePaths(), ['Same.md']);
    });

    it('waits for a deleted folder’s files before removing it from Drive', async () => {
        const vault = new MemoryVault();
        vault.write('Old/a.md', 'a');
        const { drive, engine, settled } = await setup({ vault });

        vault.remove('Old');
        engine.onVaultFolderDelete('Old');
        await settled();
        assert.ok(drive.at('Old'), 'kept while its file is still recorded');

        engine.onVaultChange('Old/a.md');
        engine.onVaultFolderDelete('Old');
        await settled();
        assert.equal(drive.at('Old'), undefined);
    });

    it('applies a new debounce without a restart', async () => {
        const { vault, drive, engine, settled } = await setup();
        engine.updateSettings({ ...DEFAULT_SETTINGS, uploadDebounceMs: 60_000, deviceName: 'laptop' });

        vault.write('late.md', 'x');
        engine.onVaultChange('late.md');
        await settled();
        assert.equal(drive.text('late.md'), undefined, 'still waiting out the new debounce');
    });
});

describe('SyncEngine — pausing', () => {
    it('ignores changes while paused and catches up on resume', async () => {
        const { vault, drive, engine, settled } = await setup();
        engine.pause();
        assert.equal(engine.getSummary().status, 'paused');

        vault.write('Paused.md', 'written while paused');
        engine.onVaultChange('Paused.md');
        drive.put('Remote.md', 'from another device');
        await settled();
        assert.equal(drive.text('Paused.md'), undefined);
        assert.equal(vault.read('Remote.md'), undefined);

        await engine.resume();
        await settled();
        assert.equal(drive.text('Paused.md'), 'written while paused');
        assert.equal(vault.read('Remote.md'), 'from another device');
        assert.equal(engine.getSummary().status, 'idle');
    });

    it('stays paused across a restart, doing nothing until resumed', async () => {
        const drive = new FakeDrive();
        drive.put('Remote.md', 'waiting');
        const { vault, engine, settled } = await setup({ drive, settings: { paused: true } });
        await settled();
        assert.equal(vault.read('Remote.md'), undefined);
        assert.equal(engine.getSummary().status, 'paused');

        await engine.resume();
        await settled();
        assert.equal(vault.read('Remote.md'), 'waiting');
    });
});

describe('SyncEngine — Wi-Fi only', () => {
    it('holds the sync on mobile data and runs it once back on Wi-Fi', async () => {
        let metered = true;
        const drive = new FakeDrive();
        drive.put('Remote.md', 'hello');
        const { vault, engine, settled } = await setup({
            drive,
            settings: { wifiOnly: true },
            environment: { isMobile: true, isMetered: () => metered },
        });
        await settled();
        assert.equal(vault.read('Remote.md'), undefined);
        assert.equal(engine.getSummary().status, 'waiting-for-wifi');

        metered = false;
        engine.pollNow();
        await settled();
        assert.equal(vault.read('Remote.md'), 'hello');
    });

    it('has no effect on desktop', async () => {
        const drive = new FakeDrive();
        drive.put('Remote.md', 'hello');
        const { vault, settled } = await setup({
            drive,
            settings: { wifiOnly: true },
            environment: { isMobile: false, isMetered: () => true },
        });
        await settled();
        assert.equal(vault.read('Remote.md'), 'hello');
    });
});

describe('SyncEngine — size limits', () => {
    const big = 'x'.repeat(2 * 1024 * 1024);

    it('leaves files over the limit on Drive instead of downloading them', async () => {
        const drive = new FakeDrive();
        drive.put('big.bin', big);
        drive.put('small.md', 'small');
        const { vault, settled } = await setup({ drive, settings: { maxFileSizeMb: 1 } });
        await settled();
        assert.equal(vault.read('big.bin'), undefined);
        assert.equal(vault.read('small.md'), 'small');
    });

    it('applies the mobile limit on mobile only', async () => {
        for (const isMobile of [false, true]) {
            const drive = new FakeDrive();
            drive.put('big.bin', big);
            const { vault, settled } = await setup({
                drive,
                settings: { mobileMaxFileSizeMb: 1 },
                environment: { isMobile, isMetered: () => false },
            });
            await settled();
            assert.equal(vault.read('big.bin') !== undefined, !isMobile, `isMobile: ${isMobile}`);
        }
    });
});

describe('SyncEngine — ordering and scope', () => {
    it('uploads notes before attachments', async () => {
        const vault = new MemoryVault();
        vault.write('a-picture.png', 'not really a picture');
        vault.write('z-note.md', 'a note');
        const { drive, settled } = await setup({ vault, settings: { transferConcurrency: 1 } });
        await settled();
        assert.deepEqual(drive.uploadLog, ['z-note.md', 'a-picture.png']);
    });

    it('syncs newly included files when the exclusions change on the same settings object', async () => {
        const vault = new MemoryVault();
        vault.write('Private/secret.md', 'now shared');
        const { drive, engine, settings, settled } = await setup({ vault, settings: { excludePatterns: ['Private/'] } });
        await settled();
        assert.equal(drive.text('Private/secret.md'), undefined);

        settings.excludePatterns = [];
        engine.updateSettings(settings);
        await settled();
        assert.equal(drive.text('Private/secret.md'), 'now shared');
    });
});

describe('SyncEngine — first-sync plan', () => {
    it('predicts the first sync without changing either side', async () => {
        const vault = new MemoryVault();
        const drive = new FakeDrive();
        vault.write('local.md', 'only here');
        drive.put('remote.md', 'only there');
        vault.write('same.md', 'identical');
        drive.put('same.md', 'identical');
        vault.write('both.md', 'this version');
        drive.put('both.md', 'that version');

        const { engine } = await setup({ vault, drive, start: false });
        const plan = await engine.plan(drive.client() as unknown as ProtonDriveClient, SYNC_ROOT);

        assert.equal(plan.localFiles, 3);
        assert.equal(plan.remoteFiles, 3);
        assert.deepEqual(plan.uploads, ['local.md']);
        assert.deepEqual(plan.downloads, ['remote.md']);
        assert.deepEqual(plan.conflicts, ['both.md']);
        assert.equal(plan.unchanged, 1);
        assert.deepEqual(plan.removals, []);

        assert.equal(vault.read('remote.md'), undefined);
        assert.equal(drive.text('local.md'), undefined);
    });
});

describe('SyncEngine — a new vault joining an existing one', () => {
    /** What Obsidian creates in a brand-new vault once this plugin is installed. */
    function newVault(): MemoryVault {
        const vault = new MemoryVault();
        vault.write('.obsidian/app.json', '{}');
        vault.write('.obsidian/appearance.json', '{}');
        vault.write('.obsidian/community-plugins.json', '["proton-drive-sync"]');
        vault.write(`${PLUGIN_DIR}/main.js`, 'plugin v0.3.0');
        return vault;
    }

    function syncedDrive(): FakeDrive {
        const drive = new FakeDrive();
        drive.put('.obsidian/app.json', '{"vimMode":true}');
        drive.put('.obsidian/appearance.json', '{"theme":"obsidian"}');
        drive.put('.obsidian/community-plugins.json', '["proton-drive-sync","dataview"]');
        drive.put(`${PLUGIN_DIR}/main.js`, 'plugin v0.2.1');
        drive.put('Note.md', 'hello');
        return drive;
    }

    it('takes the settings from Drive without reporting conflicts, and asks for a reload', async () => {
        const { vault, conflicts, adopted, settled } = await setup({ vault: newVault(), drive: syncedDrive() });
        await settled();

        assert.equal(vault.read('.obsidian/app.json'), '{"vimMode":true}');
        assert.equal(vault.read('Note.md'), 'hello');
        assert.deepEqual(conflicts, []);
        assert.deepEqual(adopted, [
            '.obsidian/app.json',
            '.obsidian/appearance.json',
            '.obsidian/community-plugins.json',
        ]);
    });

    it('settles the settings and asks for the reload before any note arrives', async () => {
        const vault = newVault();
        const drive = syncedDrive();
        drive.put('Later.md', 'another note');
        let notesWhenAsked: string[] | null = null;
        let savedStateWhenAsked = '';
        const { settled } = await setup({
            vault,
            drive,
            onSettingsAdopted: () => {
                notesWhenAsked = vault.notePaths();
                savedStateWhenAsked = vault.read(`${PLUGIN_DIR}/sync-state.json`) ?? '';
            },
        });
        await settled();

        assert.deepEqual(notesWhenAsked, []);
        // Saved before asking, so reloading straight away loses nothing.
        assert.match(savedStateWhenAsked, /\.obsidian\/app\.json/);
        assert.deepEqual(vault.notePaths(), ['Later.md', 'Note.md']);
    });

    it('never replaces the running plugin with the copy on Drive', async () => {
        const { vault, drive, settled } = await setup({ vault: newVault(), drive: syncedDrive() });
        await settled();

        assert.equal(vault.read(`${PLUGIN_DIR}/main.js`), 'plugin v0.3.0');
        assert.equal(drive.text(`${PLUGIN_DIR}/main.js`), 'plugin v0.2.1');
    });

    it('keeps local settings changes off Drive until Obsidian reloads, but still takes Drive’s', async () => {
        const drive = syncedDrive();
        const { vault, engine, settled } = await setup({ vault: newVault(), drive });
        await settled();

        // Obsidian, still running on the new vault's defaults, saves them.
        vault.write('.obsidian/app.json', '{}');
        const appearance = drive.put('.obsidian/appearance.json', '{"theme":"moonstone"}');
        drive.emit(appearance);
        engine.pollNow();
        await settled();

        assert.equal(drive.text('.obsidian/app.json'), '{"vimMode":true}');
        assert.equal(vault.read('.obsidian/appearance.json'), '{"theme":"moonstone"}');
    });

    it('stays enabled when Drive’s list of enabled plugins does not include it', async () => {
        const drive = syncedDrive();
        drive.put('.obsidian/community-plugins.json', '["dataview"]');
        const { vault, settled } = await setup({ vault: newVault(), drive });
        await settled();

        assert.deepEqual(JSON.parse(vault.read('.obsidian/community-plugins.json')!), ['dataview', 'proton-drive-sync']);
        // Held with the other settings until Obsidian reloads.
        assert.equal(drive.text('.obsidian/community-plugins.json'), '["dataview"]');
    });

    it('leaves a list that already includes it exactly as Drive has it', async () => {
        const { vault, settled } = await setup({ vault: newVault(), drive: syncedDrive() });
        await settled();
        assert.equal(vault.read('.obsidian/community-plugins.json'), '["proton-drive-sync","dataview"]');
    });

    it('counts a vault with only settings as having no notes, and lists the settings apart', async () => {
        const vault = newVault();
        const drive = syncedDrive();
        const { engine } = await setup({ vault, drive, start: false });
        const plan = await engine.plan(drive.client() as unknown as ProtonDriveClient, SYNC_ROOT);

        assert.equal(plan.localNotes, 0);
        assert.deepEqual(plan.conflicts, []);
        assert.deepEqual(plan.settings, [
            '.obsidian/app.json',
            '.obsidian/appearance.json',
            '.obsidian/community-plugins.json',
        ]);
        assert.deepEqual(plan.downloads, ['Note.md']);
    });
});

describe('SyncEngine — changes made while a transfer is in flight (issues #3 and #4)', () => {
    /** Two notes, synced. `b.md` is the longer, so `a.md` is transferred first. */
    async function syncedPair(settings: Partial<PluginSettings> = {}) {
        const vault = new MemoryVault();
        vault.write('a.md', 'a');
        vault.write('b.md', 'the second, longer note');
        const result = await setup({ vault, settings: { transferConcurrency: 1, ...settings } });
        await result.settled();
        return result;
    }

    it('keeps an edit saved while a download of the same note was in flight', async () => {
        const { vault, drive, engine, conflicts, settled } = await syncedPair();
        drive.emit(drive.put('b.md', 'edited on the phone'));
        drive.duringDownload = () => {
            drive.duringDownload = null;
            vault.write('b.md', 'typed here during the download');
        };
        engine.pollNow();
        await settled();

        // Nothing lost: this device's text keeps the name, Drive's sits beside it.
        assert.equal(vault.read('b.md'), 'typed here during the download');
        assert.equal(drive.text('b.md'), 'typed here during the download');
        assert.equal(conflicts.length, 1);
        assert.equal(vault.read(conflicts[0].copyPath!), 'edited on the phone');
    });

    it('does not trash a note that another device edited after the decision to delete it', async () => {
        const { vault, drive, engine, settled } = await syncedPair();
        vault.remove('b.md');
        vault.write('a.md', 'A');
        // While a.md uploads, b.md, already decided as a deletion, is edited on another device.
        drive.duringRevisionUpload = () => {
            drive.duringRevisionUpload = null;
            drive.put('b.md', 'edited elsewhere in the meantime');
        };
        await engine.syncNow();
        await settled();
        assert.equal(drive.text('b.md'), 'edited elsewhere in the meantime');

        // The next pass sees an edit against a local deletion, and the edit wins.
        await engine.syncNow();
        await settled();
        assert.equal(vault.read('b.md'), 'edited elsewhere in the meantime');
    });

    it('keeps a note edited here after the decision to delete it, deleted elsewhere', async () => {
        const { vault, drive, engine, settled } = await syncedPair();
        drive.trash('b.md');
        vault.write('a.md', 'A');
        drive.duringRevisionUpload = () => {
            drive.duringRevisionUpload = null;
            vault.write('b.md', 'saved here in the meantime');
        };
        await engine.syncNow();
        await settled();

        assert.equal(vault.read('b.md'), 'saved here in the meantime');
        assert.equal(drive.text('b.md'), 'saved here in the meantime');
    });

    it('downloads the revision it decided on, and records exactly that one', async () => {
        const { vault, drive, engine, state, settled } = await syncedPair();
        drive.put('b.md', 'revision one, long enough to go second');
        vault.write('a.md', 'A');
        drive.duringRevisionUpload = () => {
            drive.duringRevisionUpload = null;
            drive.put('b.md', 'revision two, uploaded after the decision');
        };
        await engine.syncNow();
        await settled();

        const node = drive.at('b.md')!;
        const decided = node.history.at(-2)!;
        assert.equal(vault.read('b.md'), 'revision one, long enough to go second');
        assert.equal(state.get('b.md')?.base?.remoteRevisionUid, decided.uid);

        // The newer revision is an ordinary remote change for the next pass.
        await engine.syncNow();
        await settled();
        assert.equal(vault.read('b.md'), 'revision two, uploaded after the decision');
    });
});

describe('SyncEngine — renames that never produced a rename event (issue #2)', () => {
    async function synced(files: Record<string, string>) {
        const vault = new MemoryVault();
        for (const [path, text] of Object.entries(files)) {
            vault.write(path, text);
        }
        const result = await setup({ vault });
        await result.settled();
        return { ...result, uploadsBefore: result.drive.uploadLog.length };
    }

    it('carries a rename made while paused over as a rename, keeping the Drive node', async () => {
        const { vault, drive, engine, settled, uploadsBefore } = await synced({ 'Untitled.md': 'my plan' });
        const uid = drive.at('Untitled.md')!.uid;

        engine.pause();
        vault.rename('Untitled.md', 'Plan.md');
        engine.onVaultRename('Untitled.md', 'Plan.md', false); // ignored while paused
        await engine.resume();
        await settled();

        assert.equal(drive.at('Plan.md')?.uid, uid);
        assert.equal(drive.at('Untitled.md'), undefined);
        assert.equal(drive.at('Plan.md')?.history.length, 1);
        assert.equal(drive.uploadLog.length, uploadsBefore);
    });

    it('follows a move made outside Obsidian, where there is no event at all', async () => {
        const { vault, drive, engine, settled, uploadsBefore } = await synced({ 'inbox/idea.md': 'an idea' });
        const uid = drive.at('inbox/idea.md')!.uid;

        vault.rename('inbox/idea.md', 'projects/idea.md');
        await engine.syncNow();
        await settled();

        assert.equal(drive.at('projects/idea.md')?.uid, uid);
        assert.equal(drive.at('inbox/idea.md'), undefined);
        assert.equal(drive.uploadLog.length, uploadsBefore);
    });

    it('moves every file of a folder renamed unseen, and removes the old folder', async () => {
        const { vault, drive, engine, settled, uploadsBefore } = await synced({
            'Photos 2025/a.png': 'image a',
            'Photos 2025/b.png': 'image b',
        });
        const uids = [drive.at('Photos 2025/a.png')!.uid, drive.at('Photos 2025/b.png')!.uid];

        vault.rename('Photos 2025', 'Photos');
        await engine.syncNow();
        await settled();

        assert.deepEqual([drive.at('Photos/a.png')?.uid, drive.at('Photos/b.png')?.uid], uids);
        assert.equal(drive.at('Photos 2025'), undefined);
        assert.equal(drive.uploadLog.length, uploadsBefore);
    });

    it('falls back to delete and upload when the content does not say which file went where', async () => {
        const { vault, drive, engine, settled } = await synced({ 'one.md': 'same', 'two.md': 'same' });

        vault.rename('one.md', 'uno.md');
        vault.rename('two.md', 'dos.md');
        await engine.syncNow();
        await settled();

        assert.deepEqual(drive.notePaths(), ['dos.md', 'uno.md']);
        assert.equal(drive.text('uno.md'), 'same');
    });

    it('does not pair a rename over an edit another device made to the old note', async () => {
        const { vault, drive, engine, settled } = await synced({ 'draft.md': 'version one' });

        vault.rename('draft.md', 'final.md');
        drive.put('draft.md', 'edited on the phone');
        await engine.syncNow();
        await settled();

        // Neither version is lost: the edit comes back under the old name.
        assert.equal(vault.read('final.md'), 'version one');
        assert.equal(vault.read('draft.md'), 'edited on the phone');
        assert.equal(drive.text('final.md'), 'version one');
    });
});

describe('SyncEngine — what survives a restart (issue #1)', () => {
    it('retries a remote change that failed to apply, even after Obsidian restarts', async () => {
        const vault = new MemoryVault();
        vault.write('note.md', 'old');
        const drive = new FakeDrive();
        const first = await setup({ vault, drive });

        drive.emit(drive.put('note.md', 'new'));
        drive.failLookups = true;
        first.engine.pollNow();
        await first.settled();
        assert.equal(vault.read('note.md'), 'old');
        // Closed before the in-memory retry used to run; the cursor has moved on.
        await first.engine.stop();

        drive.failLookups = false;
        const second = await setup({ vault, drive, settings: { syncOnStartup: false } });
        second.engine.pollNow();
        await second.settled();
        assert.equal(vault.read('note.md'), 'new');
    });

    it('catches up on start-up from the saved event position, without walking the Drive folder', async () => {
        const vault = new MemoryVault();
        // As in a real vault, the plugin's folder exists before the first sync.
        vault.mkdir(PLUGIN_DIR);
        vault.write('mine.md', 'v1');
        vault.write('theirs.md', 'v1');
        const drive = new FakeDrive();
        const first = await setup({ vault, drive });
        await first.engine.stop();

        // While Obsidian is closed: an edit here, and one on another device.
        vault.write('mine.md', 'edited here while closed');
        drive.emit(drive.put('theirs.md', 'edited elsewhere while closed'));

        const listingsBefore = drive.listings;
        const second = await setup({ vault, drive });
        await second.settled();

        assert.equal(drive.text('mine.md'), 'edited here while closed');
        assert.equal(vault.read('theirs.md'), 'edited elsewhere while closed');
        assert.equal(drive.listings, listingsBefore, 'no folder was listed');
        assert.equal(second.engine.getSummary().status, 'idle');
    });

    it('still walks the folder on start-up when a file went missing while closed, and keeps a rename a rename', async () => {
        const vault = new MemoryVault();
        vault.write('Untitled.md', 'my plan');
        const drive = new FakeDrive();
        const first = await setup({ vault, drive });
        const uid = drive.at('Untitled.md')!.uid;
        await first.engine.stop();

        vault.rename('Untitled.md', 'Plan.md');
        const listingsBefore = drive.listings;
        const second = await setup({ vault, drive });
        await second.settled();

        assert.ok(drive.listings > listingsBefore, 'the folder was walked');
        assert.equal(drive.at('Plan.md')?.uid, uid);
    });
});

describe('SyncEngine — names that differ only in letter case (issue #5)', () => {
    const insensitive: EngineEnvironment = { isMobile: false, isMetered: () => false, caseInsensitive: true };

    it('syncs both where the filesystem can keep them apart', async () => {
        const drive = new FakeDrive();
        drive.put('Note.md', 'upper');
        drive.put('note.md', 'lower');
        const { vault, settled } = await setup({ drive, environment: { ...insensitive, caseInsensitive: false } });
        await settled();

        assert.deepEqual(vault.notePaths(), ['Note.md', 'note.md']);
    });

    it('renames one of them on Drive where it cannot, so both still sync, and says so', async () => {
        const drive = new FakeDrive();
        drive.put('Note.md', 'upper');
        drive.put('note.md', 'lower');
        const { vault, conflicts, settled } = await setup({ drive, environment: insensitive });
        await settled();

        const paths = vault.notePaths();
        assert.equal(paths.length, 2);
        assert.ok(paths.some((path) => path.includes('(case conflict)')), `got ${paths}`);
        assert.deepEqual(new Set(paths.map((path) => vault.read(path))), new Set(['upper', 'lower']));
        assert.deepEqual(drive.notePaths(), [...paths].sort());
        assert.equal(conflicts[0]?.reason, 'case-collision');
        assert.equal(conflicts[0]?.outcome, 'renamed');
    });

    it('keeps the synced note’s name when a clashing one arrives through Drive’s events', async () => {
        const vault = new MemoryVault();
        vault.write('Note.md', 'mine');
        const { drive, engine, conflicts, settled } = await setup({ vault, environment: insensitive });

        drive.emit(drive.put('note.md', 'from a Linux machine'), DriveEventType.NodeCreated);
        engine.pollNow();
        await settled();

        assert.equal(vault.read('Note.md'), 'mine');
        assert.equal(vault.read('note (case conflict).md'), 'from a Linux machine');
        assert.equal(drive.text('Note.md'), 'mine');
        assert.equal(conflicts.at(-1)?.copyPath, 'note (case conflict).md');
    });

    it('settles folders that clash, with the files inside them', async () => {
        const vault = new MemoryVault();
        vault.write('Notes/a.md', 'a');
        const { drive, engine, settled } = await setup({ vault, environment: insensitive });

        drive.put('notes/b.md', 'b');
        await engine.syncNow();
        await settled();

        assert.deepEqual(vault.notePaths(), ['Notes/a.md', 'notes (case conflict)/b.md']);
        assert.equal(vault.read('notes (case conflict)/b.md'), 'b');
    });

    it('settles a clash with a new file in the vault in favour of the vault', async () => {
        const vault = new MemoryVault();
        vault.write('Ideas.md', 'written here');
        const drive = new FakeDrive();
        drive.put('ideas.md', 'written elsewhere');
        await setup({ vault, drive, environment: insensitive });

        assert.equal(drive.text('Ideas.md'), 'written here');
        assert.equal(drive.text('ideas (case conflict).md'), 'written elsewhere');
        assert.equal(vault.read('ideas (case conflict).md'), 'written elsewhere');
    });
});

describe('SyncEngine — going through Obsidian’s Vault API (issue #6)', () => {
    it('deletes a note the way the user chose for deleted files, and writes notes through the Vault API', async () => {
        const vault = new MemoryVault();
        vault.write('gone.md', 'bye');
        const { drive, engine, settled } = await setup({ vault });

        drive.trash('gone.md');
        drive.put('new.md', 'hello');
        await engine.syncNow();
        await settled();

        assert.equal(vault.read('gone.md'), undefined);
        assert.ok(vault.viaVaultApi.some(([op, path]) => op === 'trash' && path === 'gone.md'));
        assert.ok(vault.viaVaultApi.some(([op, path]) => op === 'create' && path === 'new.md'));
    });

    it('keeps using the adapter for the config folder, which Obsidian does not index', async () => {
        const vault = new MemoryVault();
        vault.write('.obsidian/app.json', '{}');
        const { drive, engine, settled } = await setup({ vault });

        drive.put('.obsidian/app.json', '{"vimMode":true}');
        drive.trash('.obsidian/app.json');
        drive.put('.obsidian/hotkeys.json', '{}');
        await engine.syncNow();
        await settled();

        assert.equal(vault.read('.obsidian/hotkeys.json'), '{}');
        assert.deepEqual(
            vault.viaVaultApi.filter(([, path]) => path.startsWith('.obsidian/')),
            [],
        );
    });
});

describe('SyncEngine — checking Drive just before uploading', () => {
    it('merges an edit another device uploaded after the decision, instead of uploading over it', async () => {
        const vault = new MemoryVault();
        vault.write('a.md', 'a');
        vault.write('b.md', 'line one\nline two\nline three, the longest');
        const { drive, engine, settled } = await setup({
            vault,
            settings: { transferConcurrency: 1, conflictPolicy: 'merge' },
        });
        await settled();

        vault.write('a.md', 'A');
        vault.write('b.md', 'LINE ONE\nline two\nline three, the longest');
        // While a.md uploads, after b.md's upload was decided, another device saves b.md.
        drive.duringRevisionUpload = () => {
            drive.duringRevisionUpload = null;
            drive.put('b.md', 'line one\nline two\nLINE THREE, the longest');
        };
        await engine.syncNow();
        await settled();
        engine.pollNow();
        await settled();

        assert.equal(drive.text('b.md'), 'LINE ONE\nline two\nLINE THREE, the longest');
        assert.equal(vault.read('b.md'), 'LINE ONE\nline two\nLINE THREE, the longest');
        assert.deepEqual(vault.notePaths().filter((path) => path.includes('conflict')), []);
    });
});

describe('SyncEngine — adapting how often Drive is checked', () => {
    it('checks more often right after a change, less after a quiet spell, and least while hidden', async () => {
        let hidden = false;
        const { vault, engine } = await setup({
            settings: { remotePollSeconds: 30 },
            environment: { isMobile: false, isMetered: () => false, isHidden: () => hidden },
        });
        const now = Date.now();

        // Nothing has happened yet: the quiet pace.
        assert.equal(engine.pollIntervalSeconds(now), 120);

        vault.write('note.md', 'typed');
        engine.onVaultChange('note.md');
        assert.equal(engine.pollIntervalSeconds(Date.now()), 15);
        assert.equal(engine.pollIntervalSeconds(Date.now() + 5 * 60_000), 30);
        assert.equal(engine.pollIntervalSeconds(Date.now() + 11 * 60_000), 120);

        hidden = true;
        assert.equal(engine.pollIntervalSeconds(Date.now()), 120);
    });

    it('never goes below the minimum, nor above five minutes', async () => {
        const fast = await setup({ settings: { remotePollSeconds: 15 } });
        fast.vault.write('note.md', 'x');
        fast.engine.onVaultChange('note.md');
        assert.equal(fast.engine.pollIntervalSeconds(), 15);

        const slow = await setup({ settings: { remotePollSeconds: 200 } });
        assert.equal(slow.engine.pollIntervalSeconds(), 300);
    });
});

describe('SyncEngine — finding the transfer pace', () => {
    afterEach(() => requestStats.reset());

    it('starts at two, climbs to the setting while Proton keeps up, and halves when it asks to slow down', async () => {
        const vault = new MemoryVault();
        for (let i = 0; i < 12; i++) {
            vault.write(`note-${i}.md`, `note ${i}`);
        }
        const { engine, settled } = await setup({ vault, start: false, settings: { transferConcurrency: 4 } });
        assert.equal(engine.currentTransferLimit(), 2);

        const drive = new FakeDrive();
        await engine.start(drive.client() as unknown as ProtonDriveClient, SYNC_ROOT);
        await settled();
        assert.equal(engine.currentTransferLimit(), 4);

        requestStats.record(429);
        vault.write('note-0.md', 'edited');
        engine.onVaultChange('note-0.md');
        await settled();
        assert.equal(engine.currentTransferLimit(), 2);
    });
});

describe('SyncEngine — what is not synced yet, and why', () => {
    const stat = (vault: MemoryVault, path: string) => {
        const file = vault.files.get(path)!;
        return { size: file.data.byteLength, mtime: file.mtime };
    };

    it('lists an edit held back on mobile data, and one too large for this device', async () => {
        let metered = false;
        const vault = new MemoryVault();
        vault.write('note.md', 'v1');
        vault.write('video.mp4', 'x'.repeat(2 * 1024 * 1024));
        const { engine, settled } = await setup({
            vault,
            settings: { wifiOnly: true, maxFileSizeMb: 1 },
            environment: { isMobile: true, isMetered: () => metered },
        });

        metered = true;
        vault.write('note.md', 'v2');
        engine.onVaultChange('note.md');
        await settled();

        assert.deepEqual(engine.pendingChanges(), [
            { path: 'note.md', reason: 'wifi' },
            { path: 'video.mp4', reason: 'too-large', detail: '2 MB' },
        ]);
        assert.equal(engine.getSummary().pending, 2);
    });

    it('lists a change that failed, with how often and when it is tried next', async () => {
        const vault = new MemoryVault();
        vault.write('note.md', 'old');
        const { drive, engine, settled } = await setup({ vault });
        drive.emit(drive.put('note.md', 'new'));
        drive.failLookups = true;
        engine.pollNow();
        await settled();

        const [change] = engine.pendingChanges();
        assert.equal(change.path, 'note.md');
        assert.equal(change.reason, 'retrying');
        assert.match(change.detail!, /failed 1 time; next try with the next check/);
    });

    it('tells whether one note is in sync, including edits nothing has queued yet', async () => {
        const vault = new MemoryVault();
        vault.write('note.md', 'v1');
        vault.write('.obsidian/workspace.json', '{}');
        const { engine } = await setup({ vault });

        assert.equal(engine.noteSyncState('note.md', stat(vault, 'note.md')), 'synced');
        engine.pause();
        vault.write('note.md', 'edited while paused');
        assert.equal(engine.noteSyncState('note.md', stat(vault, 'note.md')), 'pending');
        assert.equal(engine.noteSyncState('.obsidian/workspace.json', null), 'excluded');
        assert.equal(engine.noteSyncState('brand-new.md', null), 'pending');
    });
});

describe('SyncEngine — bringing remote changes in through an open editor', () => {
    /** A note open in an editor, which may hold typing the vault file does not have yet. */
    function fakeEditor(vault: MemoryVault, path: string) {
        const editor = {
            content: vault.read(path) ?? '',
            replaced: 0,
            text: () => editor.content,
            replace: (next: string) => {
                editor.content = next;
                editor.replaced++;
            },
            /** What Obsidian does a moment later: write the editor's text to the file. */
            save: () => vault.write(path, editor.content),
        };
        return editor;
    }

    async function open(text: string) {
        const vault = new MemoryVault();
        vault.write('note.md', text);
        let editor: ReturnType<typeof fakeEditor> | null = null;
        const result = await setup({
            vault,
            environment: {
                isMobile: false,
                isMetered: () => false,
                openEditor: (path) => (path === 'note.md' ? editor : null),
            },
        });
        editor = fakeEditor(vault, 'note.md');
        return { ...result, editor };
    }

    it('shows a new version in the editor, keeping the cursor, when nothing is unsaved', async () => {
        const { vault, drive, engine, editor, settled } = await open('line one\nline two');
        drive.emit(drive.put('note.md', 'line one\nline two\nline three'));
        engine.pollNow();
        await settled();

        assert.equal(editor.replaced, 1);
        assert.equal(editor.content, 'line one\nline two\nline three');
        assert.equal(vault.read('note.md'), 'line one\nline two\nline three');
    });

    it('merges a new version into unsaved typing, writes nothing under it, and uploads the merge once saved', async () => {
        const { vault, drive, engine, editor, conflicts, settled } = await open('line one\nline two\nline three');
        editor.content = 'LINE ONE\nline two\nline three'; // typed, not saved yet
        drive.emit(drive.put('note.md', 'line one\nline two\nLINE THREE'));
        engine.pollNow();
        await settled();

        assert.equal(editor.content, 'LINE ONE\nline two\nLINE THREE');
        assert.equal(vault.read('note.md'), 'line one\nline two\nline three', 'nothing written under the editor');

        editor.save();
        engine.onVaultChange('note.md');
        await settled();

        assert.equal(drive.text('note.md'), 'LINE ONE\nline two\nLINE THREE');
        assert.deepEqual(conflicts, []);
        assert.deepEqual(vault.notePaths(), ['note.md']);
    });

    it('leaves overlapping unsaved typing alone, and keeps both versions once it is saved', async () => {
        const { vault, drive, engine, editor, settled } = await open('meet on Monday');
        editor.content = 'meet on Tuesday';
        drive.emit(drive.put('note.md', 'meet on Friday'));
        engine.pollNow();
        await settled();

        assert.equal(editor.content, 'meet on Tuesday');
        assert.equal(vault.read('note.md'), 'meet on Monday');

        editor.save();
        engine.onVaultChange('note.md');
        await settled();

        assert.equal(vault.read('note.md'), 'meet on Tuesday');
        const copy = vault.notePaths().find((path) => path.includes('conflict'));
        assert.equal(copy && vault.read(copy), 'meet on Friday');
    });
});
