import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';

import { Platform } from 'obsidian';

import { LARGE_FILE_BYTES, VaultIO } from '../src/sync/vault';
import { Logger } from '../src/util/logger';
import { diskVault, exposeNodeRequire } from './support/diskAdapter';

describe('VaultIO on mobile', () => {
    const disk = diskVault();
    let vault: VaultIO;

    before(() => {
        // Even with a `require` in reach, mobile must not touch Node.
        exposeNodeRequire();
        (Platform as { isDesktopApp: boolean }).isDesktopApp = false;
        vault = new VaultIO(disk.app, new Logger('error'));
    });
    after(() => disk.cleanup());

    it('downloads into memory instead of streaming to disk', async () => {
        assert.equal(await vault.openDownload('clip.mp4'), null);
    });

    it('reads large files whole through the adapter', async () => {
        writeFileSync(disk.full('clip.mp4'), Buffer.alloc(LARGE_FILE_BYTES + 1, 1));
        const { source } = await vault.openUpload('clip.mp4');
        assert.equal(source.replay, true);
        assert.equal(source.size, LARGE_FILE_BYTES + 1);
    });
});
