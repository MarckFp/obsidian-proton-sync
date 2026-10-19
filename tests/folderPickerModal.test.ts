import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { App } from 'obsidian';
import { MemberRole, type ProtonDriveClient } from '@protontech/drive-sdk';

import { FolderPickerModal, type ChosenFolder } from '../src/ui/folderPickerModal';
import { Logger } from '../src/util/logger';
import { FakeDrive, SYNC_ROOT, VOLUME_ROOT } from './support/fakes';

const DECRYPTION_ERROR = 'Error decrypting session keys: No decryption key packets found';

function picker(role = MemberRole.Admin, sharingFails = true, rootOnly = false) {
    const drive = new FakeDrive();
    if (sharingFails && !rootOnly) {
        drive.nodes.get(SYNC_ROOT)!.members = ['friend@proton.me'];
    }
    const client = drive.client() as unknown as ProtonDriveClient;
    const getHierarchy = client.getNodeHierarchy.bind(client);
    client.getNodeHierarchy = async (uid) => (await getHierarchy(uid)).map((node) => ({
        ...node, directRole: role, isShared: node.uid === VOLUME_ROOT || node.isShared,
    }));
    if (sharingFails) {
        client.getSharingInfo = async () => { throw new Error(DECRYPTION_ERROR); };
    }
    const chosen: ChosenFolder[] = [];
    const logger = new Logger('warn');
    const modal = new FolderPickerModal({} as App, client, (folder) => chosen.push(folder), logger);
    let closed = false;
    modal.close = () => { closed = true; };
    return { modal, client, chosen, logger, closed: () => closed };
}

describe('FolderPickerModal — unreadable sharing metadata (#13)', () => {
    it('accepts a private folder without marking it shared because of the internal root', async () => {
        const { modal, chosen, closed, logger } = picker(MemberRole.Admin, true, true);
        await modal['choose'](SYNC_ROOT, 'My files / Vault');
        assert.deepEqual(chosen, [{ uid: SYNC_ROOT, path: 'My files / Vault', shared: false, sharedBy: null }]);
        assert.equal(closed(), true);
        assert.equal(logger.getEntries().length, 0);
    });

    it('accepts a newly created private folder without marking it shared', async () => {
        const { modal, chosen } = picker(MemberRole.Admin, true, true);
        modal['stack'] = [{ kind: 'folder', uid: SYNC_ROOT, name: 'Vault' }];
        await modal['createAndChoose']('New vault');
        assert.equal(chosen.length, 1);
        assert.equal(chosen[0]!.shared, false);
    });

    it('accepts a writable folder and conservatively marks it shared', async () => {
        const { modal, chosen, closed, logger } = picker();
        await modal['choose'](SYNC_ROOT, 'My files / Vault');
        assert.deepEqual(chosen, [{ uid: SYNC_ROOT, path: 'My files / Vault', shared: true, sharedBy: null }]);
        assert.equal(closed(), true);
        assert.ok(logger.getEntries().some((entry) => entry.level === 'warn' && entry.message.includes(DECRYPTION_ERROR)));
    });

    it('also accepts a folder just created from the picker', async () => {
        const { modal, chosen, closed } = picker();
        modal['stack'] = [{ kind: 'folder', uid: SYNC_ROOT, name: 'Vault' }];
        await modal['createAndChoose']('New vault');
        assert.equal(chosen.length, 1);
        assert.equal(chosen[0]!.path, 'Vault / New vault');
        assert.equal(chosen[0]!.shared, true);
        assert.equal(closed(), true);
    });

    it('still refuses view-only access', async () => {
        const { modal, chosen, closed } = picker(MemberRole.Viewer);
        await modal['choose'](SYNC_ROOT, 'Vault');
        assert.equal(chosen.length, 0);
        assert.equal(closed(), false);
    });

    it('still refuses a folder whose node cannot be read', async () => {
        const { modal, client, chosen, closed } = picker();
        client.getNode = async () => { throw new Error('Cannot read folder'); };
        await modal['choose'](SYNC_ROOT, 'Vault');
        assert.equal(chosen.length, 0);
        assert.equal(closed(), false);
    });

    it('still refuses a folder whose access cannot be checked', async () => {
        const { modal, client, chosen, closed, logger } = picker();
        client.getNodeHierarchy = async () => { throw new Error('Cannot check access'); };
        await modal['choose'](SYNC_ROOT, 'Vault');
        assert.equal(chosen.length, 0);
        assert.equal(closed(), false);
        assert.ok(logger.getEntries().some((entry) => entry.message.includes('node or access: Cannot check access')));
    });

    it('keeps an unshared folder unshared when the check succeeds', async () => {
        const { modal, client, chosen } = picker(MemberRole.Admin, false);
        client.getSharingInfo = async () => undefined;
        await modal['choose'](SYNC_ROOT, 'Vault');
        assert.equal(chosen[0]!.shared, false);
    });
});
