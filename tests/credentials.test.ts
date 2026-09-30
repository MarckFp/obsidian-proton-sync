import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DataAdapter, SecretStorage } from 'obsidian';

import { Credentials } from '../src/proton/credentials';
import { ObsidianSecretSlot, type SecretSlot } from '../src/proton/secretStore';
import { Logger } from '../src/util/logger';

const SILENT = new Logger('error');
const LEGACY = '.obsidian/plugins/proton-drive-sync/session.json';

function memorySlot(initial: string | null = null) {
    const slot = {
        value: initial,
        read: async () => slot.value,
        write: async (value: string | null) => void (slot.value = value),
    };
    return slot satisfies SecretSlot;
}

function memoryAdapter(files: Record<string, string> = {}) {
    const store = new Map(Object.entries(files));
    const adapter = {
        exists: async (path: string) => store.has(path),
        read: async (path: string) => store.get(path)!,
        remove: async (path: string) => void store.delete(path),
    } as unknown as DataAdapter;
    return { adapter, store };
}

const SESSION = JSON.stringify({
    version: 1,
    uid: 'uid-1',
    accessToken: 'access',
    refreshToken: 'refresh',
    userKeyPassword: 'key-password',
    telemetryEnabled: false,
    accountEmail: 'me@proton.me',
});

describe('Credentials', () => {
    it('keeps the session in the secret slot, never in the vault', async () => {
        const slot = memorySlot();
        const { adapter, store } = memoryAdapter();
        const credentials = new Credentials(slot, { adapter, path: LEGACY, decrypt: () => null }, SILENT);

        await credentials.setUserKeyPassword('key-password');
        await credentials.setSessionInfo({ uid: 'uid-1', accessToken: 'access' });

        assert.equal(store.size, 0);
        const reloaded = new Credentials(slot, { adapter, path: LEGACY, decrypt: () => null }, SILENT);
        await reloaded.load();
        assert.equal(reloaded.isLoggedIn(), true);
        assert.equal(reloaded.getUserKeyPassword(), 'key-password');
    });

    it('moves a session saved by 0.1.0 into the slot and deletes the old file', async () => {
        const slot = memorySlot();
        const { adapter, store } = memoryAdapter({ [LEGACY]: JSON.stringify({ encrypted: true, payload: 'cipher' }) });
        const credentials = new Credentials(
            slot,
            { adapter, path: LEGACY, decrypt: (payload) => (payload === 'cipher' ? SESSION : null) },
            SILENT,
        );

        await credentials.load();

        assert.equal(credentials.isLoggedIn(), true);
        assert.equal(credentials.accountEmail, 'me@proton.me');
        assert.equal(slot.value, SESSION);
        assert.equal(store.has(LEGACY), false);
    });

    it('keeps an old session file it cannot decrypt yet, for the next launch', async () => {
        // On Linux the keyring may simply still be locked at startup.
        const slot = memorySlot();
        const { adapter, store } = memoryAdapter({ [LEGACY]: JSON.stringify({ encrypted: true, payload: 'x' }) });
        const credentials = new Credentials(slot, { adapter, path: LEGACY, decrypt: () => null }, SILENT);

        await credentials.load();

        assert.equal(credentials.isLoggedIn(), false);
        assert.equal(store.has(LEGACY), true);
    });

    it('drops the old session file once a new sign-in is saved', async () => {
        const slot = memorySlot();
        const { adapter, store } = memoryAdapter({ [LEGACY]: JSON.stringify({ encrypted: true, payload: 'x' }) });
        const credentials = new Credentials(slot, { adapter, path: LEGACY, decrypt: () => null }, SILENT);
        await credentials.load();

        await credentials.setSessionInfo({ uid: 'uid-2', accessToken: 'new' });

        assert.equal(store.has(LEGACY), false);
    });

    it('never adopts a plaintext session file', async () => {
        const slot = memorySlot();
        const { adapter, store } = memoryAdapter({
            [LEGACY]: JSON.stringify({ encrypted: false, payload: JSON.parse(SESSION) }),
        });
        const credentials = new Credentials(slot, { adapter, path: LEGACY, decrypt: () => SESSION }, SILENT);

        await credentials.load();
        assert.equal(credentials.isLoggedIn(), false);
        assert.equal(store.has(LEGACY), false);
    });

    it('forgets everything on sign-out', async () => {
        const slot = memorySlot(SESSION);
        const { adapter } = memoryAdapter();
        const credentials = new Credentials(slot, { adapter, path: LEGACY, decrypt: () => null }, SILENT);
        await credentials.load();

        let notified = false;
        credentials.on('sessionInfoChanged', () => (notified = true));
        await credentials.signOut();

        assert.equal(credentials.isLoggedIn(), false);
        assert.equal(slot.value, null);
        assert.equal(notified, true);
    });
});

describe('ObsidianSecretSlot', () => {
    it('reads a cleared secret as absent', async () => {
        const secrets = new Map<string, string>();
        const storage = {
            getSecret: (id: string) => secrets.get(id) ?? null,
            setSecret: (id: string, value: string) => void secrets.set(id, value),
        } as unknown as SecretStorage;
        const slot = new ObsidianSecretSlot(storage, 'proton-drive-sync-session-x');

        assert.equal(await slot.read(), null);
        await slot.write('secret');
        assert.equal(await slot.read(), 'secret');
        await slot.write(null);
        assert.equal(await slot.read(), null);
    });
});
