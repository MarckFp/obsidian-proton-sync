import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { DriveEventType, type ProtonDriveClient } from '@protontech/drive-sdk';

import { DEFAULT_SETTINGS, type PluginSettings } from '../src/settings';
import { SyncEngine, type ConflictEvent, type EngineEnvironment } from '../src/sync/engine';
import { SyncState } from '../src/sync/state';
import { Logger } from '../src/util/logger';
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

    it('leaves names that differ only in case alone', async () => {
        const drive = new FakeDrive();
        drive.put('Note.md', 'upper');
        drive.put('note.md', 'lower');
        const vault = new MemoryVault();
        await setup({ vault, drive });

        assert.deepEqual(vault.notePaths(), []);
        assert.equal(drive.text('Note.md'), 'upper');
        assert.equal(drive.text('note.md'), 'lower');
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
