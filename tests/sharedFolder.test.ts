import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { MemberRole, type ProtonDriveClient } from '@protontech/drive-sdk';

import { DEFAULT_SETTINGS, type PluginSettings } from '../src/settings';
import { accessRole, canWrite, sharedWithOthers } from '../src/sync/drive';
import { SyncEngine } from '../src/sync/engine';
import { SyncState } from '../src/sync/state';
import { Logger } from '../src/util/logger';
import { FakeDrive, MemoryVault, SYNC_ROOT, VOLUME_ROOT } from './support/fakes';

const SILENT = new Logger('error');
const PLUGIN_DIR = '.obsidian/plugins/proton-drive-sync';

function hierarchy(...roles: MemberRole[]) {
    return { getNodeHierarchy: async () => roles.map((directRole) => ({ directRole })) } as unknown as Pick<ProtonDriveClient, 'getNodeHierarchy'>;
}

describe('accessRole', () => {
    it('is Admin anywhere in the user’s own Drive', async () => {
        assert.equal(await accessRole(hierarchy(MemberRole.Admin, MemberRole.Inherited, MemberRole.Inherited), 'x'), MemberRole.Admin);
    });

    it('is the role of the shared folder for a folder inside it', async () => {
        assert.equal(await accessRole(hierarchy(MemberRole.Editor, MemberRole.Inherited), 'x'), MemberRole.Editor);
    });

    it('takes the highest role when a subfolder was shared again with more access', async () => {
        assert.equal(await accessRole(hierarchy(MemberRole.Viewer, MemberRole.Editor), 'x'), MemberRole.Editor);
    });

    it('reads a hierarchy with no role on it as Viewer', async () => {
        assert.equal(await accessRole(hierarchy(MemberRole.Inherited), 'x'), MemberRole.Viewer);
    });

    it('lets only Editor and Admin write', () => {
        assert.equal(canWrite(MemberRole.Viewer), false);
        assert.equal(canWrite(MemberRole.Editor), true);
        assert.equal(canWrite(MemberRole.Admin), true);
    });
});

describe('sharedWithOthers', () => {
    const client = (drive: FakeDrive) => drive.client() as unknown as ProtonDriveClient;

    it('is false for a folder of the user’s own that nobody else has', async () => {
        assert.equal(await sharedWithOthers(client(new FakeDrive()), SYNC_ROOT), false);
    });

    it('is false for a folder with only a public link, which lets people read', async () => {
        const drive = new FakeDrive();
        drive.nodes.get(SYNC_ROOT)!.link = { url: 'https://drive.proton.me/urls/x' };
        assert.equal(await sharedWithOthers(client(drive), SYNC_ROOT), false);
    });

    it('is true for a folder shared with another account', async () => {
        const drive = new FakeDrive();
        drive.nodes.get(SYNC_ROOT)!.members = ['friend@proton.me'];
        assert.equal(await sharedWithOthers(client(drive), SYNC_ROOT), true);
    });

    it('is true when a folder above it is shared', async () => {
        const drive = new FakeDrive();
        drive.nodes.get(VOLUME_ROOT)!.members = ['friend@proton.me'];
        assert.equal(await sharedWithOthers(client(drive), SYNC_ROOT), true);
    });

    it('is true for a folder in someone else’s Drive', async () => {
        const drive = new FakeDrive();
        drive.myFilesScope = 'my-own-volume';
        assert.equal(await sharedWithOthers(client(drive), SYNC_ROOT), true);
    });
});

const running: SyncEngine[] = [];
afterEach(async () => {
    await Promise.all(running.splice(0).map((engine) => engine.stop()));
});

async function startEngine(vault: MemoryVault, drive: FakeDrive, settings: Partial<PluginSettings> = {}) {
    const state = new SyncState(vault.adapter(), `${PLUGIN_DIR}/sync-state.json`, SILENT);
    await state.load('me@proton.me', SYNC_ROOT);
    const engine = new SyncEngine(
        vault.app(),
        state,
        { ...DEFAULT_SETTINGS, uploadDebounceMs: 0, deviceName: 'laptop', ...settings },
        SILENT,
        { onChange: () => undefined, onConflict: () => undefined, onSettingsAdopted: () => undefined },
        { configDir: '.obsidian', pluginDir: PLUGIN_DIR, pluginId: 'proton-drive-sync' },
    );
    running.push(engine);
    await engine.start(drive.client() as unknown as ProtonDriveClient, SYNC_ROOT);
    return engine;
}

describe('SyncEngine — config that runs code, in a shared vault', () => {
    /** A Drive folder where a collaborator put a plugin and enabled it. */
    function driveWithPlugin(): FakeDrive {
        const drive = new FakeDrive();
        drive.put('.obsidian/app.json', '{"vimMode":true}');
        drive.put('.obsidian/community-plugins.json', '["proton-drive-sync","evil"]');
        drive.put('.obsidian/plugins/evil/main.js', 'steal()');
        drive.put('Note.md', 'hello');
        return drive;
    }

    it('never downloads plugins or the enabled-plugins list, even with config sync on', async () => {
        const vault = new MemoryVault();
        const drive = driveWithPlugin();
        drive.nodes.get(SYNC_ROOT)!.members = ['collaborator@proton.me'];

        await startEngine(vault, drive, { syncObsidianConfig: true });

        assert.equal(vault.read('Note.md'), 'hello');
        assert.equal(vault.read('.obsidian/app.json'), '{"vimMode":true}');
        assert.equal(vault.read('.obsidian/plugins/evil/main.js'), undefined);
        assert.equal(vault.read('.obsidian/community-plugins.json'), undefined);
    });

    it('never uploads them either', async () => {
        const vault = new MemoryVault();
        vault.write('.obsidian/plugins/mine/main.js', 'my plugin');
        vault.write('.obsidian/community-plugins.json', '["mine"]');
        const drive = new FakeDrive();
        drive.myFilesScope = 'my-own-volume';

        await startEngine(vault, drive, { syncObsidianConfig: true });

        assert.equal(drive.text('.obsidian/plugins/mine/main.js'), undefined);
        assert.equal(drive.text('.obsidian/community-plugins.json'), undefined);
    });

    it('still syncs them for a folder nobody else has', async () => {
        const vault = new MemoryVault();
        const drive = driveWithPlugin();

        await startEngine(vault, drive, { syncObsidianConfig: true });

        assert.equal(vault.read('.obsidian/plugins/evil/main.js'), 'steal()');
    });
});

describe('SyncEngine — access to a shared folder ends', () => {
    it('keeps every local note when the folder and everything in it can no longer be seen', async () => {
        const vault = new MemoryVault();
        vault.write('note.md', 'mine');
        vault.write('Sub/other.md', 'also mine');
        const drive = new FakeDrive();
        const engine = await startEngine(vault, drive);
        assert.equal(drive.text('note.md'), 'mine');

        // The owner stopped sharing: to this account, the folder and all of
        // its contents no longer exist.
        const gone = [...drive.nodes.values()].filter((node) => node.uid !== VOLUME_ROOT).map((node) => node.uid);
        for (const uid of gone) {
            drive.nodes.delete(uid);
        }
        await engine.syncNow().catch(() => undefined);

        assert.equal(vault.read('note.md'), 'mine');
        assert.equal(vault.read('Sub/other.md'), 'also mine');
    });
});
