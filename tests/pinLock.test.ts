import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LockedError, PinProtectedSlot, RememberedUnlock } from '../src/proton/pinLock';
import type { SecretSlot } from '../src/proton/secretStore';

const SESSION = '{"uid":"u","accessToken":"a","refreshToken":"r","userKeyPassword":"k"}';

function memory(initial: string | null = null) {
    const slot = {
        value: initial,
        read: async () => slot.value,
        write: async (value: string | null) => void (slot.value = value),
    };
    return slot satisfies SecretSlot;
}

/** Few iterations, so the tests do not spend seconds deriving keys. */
const protect = (inner: SecretSlot) => new PinProtectedSlot(inner, 1000);

describe('PinProtectedSlot', () => {
    it('passes a session through untouched while no PIN is set', async () => {
        const inner = memory();
        const slot = protect(inner);
        await slot.write(SESSION);
        assert.equal(inner.value, SESSION);
        assert.equal(await slot.read(), SESSION);
        assert.equal(await slot.protection(), 'plain');
    });

    it('stores only ciphertext once a PIN is set, and never the PIN', async () => {
        const inner = memory(SESSION);
        const slot = protect(inner);
        await slot.setPin('482915');

        assert.equal(await slot.protection(), 'pin');
        assert.ok(!inner.value!.includes('accessToken'));
        assert.ok(!inner.value!.includes('482915'));
        assert.equal(await slot.read(), SESSION);
    });

    it('stays locked after a restart until the right PIN is entered', async () => {
        const inner = memory(SESSION);
        await protect(inner).setPin('482915');

        const restarted = protect(inner);
        assert.equal(await restarted.isLocked(), true);
        await assert.rejects(restarted.read(), LockedError);
        assert.equal(await restarted.unlock('000000'), false);
        assert.equal(await restarted.isLocked(), true);
        assert.equal(await restarted.unlock('482915'), true);
        assert.equal(await restarted.read(), SESSION);
    });

    it('keeps refreshed tokens encrypted with the same PIN', async () => {
        const inner = memory(SESSION);
        const slot = protect(inner);
        await slot.setPin('482915');
        await slot.write('{"refreshed":true}');
        assert.ok(!inner.value!.includes('refreshed'));

        const restarted = protect(inner);
        await restarted.unlock('482915');
        assert.equal(await restarted.read(), '{"refreshed":true}');
    });

    it('changes and removes the PIN', async () => {
        const inner = memory(SESSION);
        const slot = protect(inner);
        await slot.setPin('482915');
        assert.equal(await slot.verify('482915'), true);

        await slot.setPin('new-pin-123');
        assert.equal(await slot.verify('482915'), false);
        assert.equal(await slot.verify('new-pin-123'), true);

        await slot.removePin();
        assert.equal(inner.value, SESSION);
        assert.equal(await slot.protection(), 'plain');
    });

    it('refuses a PIN that is too short, and a PIN with nothing to protect', async () => {
        await assert.rejects(protect(memory(SESSION)).setPin('123'), /at least 6/);
        await assert.rejects(protect(memory()).setPin('482915'), /Sign in/);
    });

    it('forgets a locked session without the PIN, for when it is lost', async () => {
        const inner = memory(SESSION);
        await protect(inner).setPin('482915');
        const restarted = protect(inner);
        await restarted.forget();
        assert.equal(inner.value, null);
        assert.equal(await restarted.protection(), 'none');
    });

    it('drops the PIN along with the session on sign-out', async () => {
        const inner = memory(SESSION);
        const slot = protect(inner);
        await slot.setPin('482915');
        await slot.write(null);
        await slot.write(SESSION);
        assert.equal(inner.value, SESSION);
    });

    it('rejects a tampered envelope as a wrong PIN', async () => {
        const inner = memory(SESSION);
        await protect(inner).setPin('482915');
        const envelope = JSON.parse(inner.value!) as { data: string };
        // Always a different character, so the data really changes.
        envelope.data = `${envelope.data.startsWith('A') ? 'B' : 'A'}${envelope.data.slice(1)}`;
        inner.value = JSON.stringify(envelope);
        assert.equal(await protect(inner).unlock('482915'), false);
    });
});

describe('remembering an unlock across restarts', () => {
    it('reopens the session with the exported key, without the PIN', async () => {
        const inner = memory(SESSION);
        const slot = protect(inner);
        await slot.setPin('482915');
        const exported = slot.exportKey()!;
        assert.ok(!exported.includes('482915'));

        const restarted = protect(inner);
        assert.equal(await restarted.unlockWithKey(exported), true);
        assert.equal(await restarted.read(), SESSION);
    });

    it('refuses a key from before the PIN was changed', async () => {
        const inner = memory(SESSION);
        const slot = protect(inner);
        await slot.setPin('482915');
        const old = slot.exportKey()!;
        await slot.setPin('another-pin');
        assert.equal(await protect(inner).unlockWithKey(old), false);
    });

    it('locks again in memory without touching what is stored', async () => {
        const inner = memory(SESSION);
        const slot = protect(inner);
        await slot.setPin('482915');
        const stored = inner.value;
        slot.lock();
        await assert.rejects(slot.read(), LockedError);
        assert.equal(slot.exportKey(), null);
        assert.equal(inner.value, stored);
    });

    it('hands back a remembered key until it expires, then deletes it', async () => {
        const clock = { now: 1000 };
        const store = memory();
        const remembered = new RememberedUnlock(store, () => clock.now);
        await remembered.save('key', 2000);

        assert.equal(await remembered.load(), 'key');
        clock.now = 2001;
        assert.equal(await remembered.load(), null);
        assert.equal(store.value, null);
    });
});
