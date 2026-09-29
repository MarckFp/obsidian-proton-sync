import '../src/polyfills';

import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';

import { generateSignInUrl, parseUserKeyPassword } from '../src/proton/account/authWeb';

/** Encrypt a fork payload the way account.proton.me does: AES-256-GCM, AAD "fork", nonce‖ciphertext‖tag. */
function forkPayload(key: Uint8Array, json: object): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from('fork'));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(json), 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64');
}

describe('authWeb — sign-in fork', () => {
    it('puts a fresh 256-bit key and the client id in the sign-in link', () => {
        const { encryptionKey, signInUrl } = generateSignInUrl('external-drive', 'CODE', 'account.proton.me');
        assert.equal(encryptionKey.byteLength, 32);
        const payload = decodeURIComponent(signInUrl.split('#payload=')[1]!);
        assert.equal(payload, `0:CODE:${Buffer.from(encryptionKey).toString('base64')}:external-drive`);
        assert.ok(signInUrl.startsWith('https://account.proton.me/desktop/login?'));
        assert.notDeepEqual(generateSignInUrl('external-drive', 'CODE').encryptionKey, encryptionKey);
    });

    it('decrypts the key password Proton returns', async () => {
        const { encryptionKey } = generateSignInUrl('external-drive', 'CODE');
        const payload = forkPayload(encryptionKey, { type: 'default', keyPassword: 'hunter2' });
        assert.equal(await parseUserKeyPassword(encryptionKey, payload), 'hunter2');
    });

    it('rejects a payload that was tampered with or encrypted for another key', async () => {
        const { encryptionKey } = generateSignInUrl('external-drive', 'CODE');
        const other = generateSignInUrl('external-drive', 'CODE').encryptionKey;
        await assert.rejects(parseUserKeyPassword(encryptionKey, forkPayload(other, { keyPassword: 'x' })));

        const bytes = Buffer.from(forkPayload(encryptionKey, { keyPassword: 'x' }), 'base64');
        bytes[20]! ^= 1;
        await assert.rejects(parseUserKeyPassword(encryptionKey, bytes.toString('base64')));
    });

    it('rejects a payload without a key password, or too short to hold one', async () => {
        const { encryptionKey } = generateSignInUrl('external-drive', 'CODE');
        await assert.rejects(parseUserKeyPassword(encryptionKey, forkPayload(encryptionKey, { type: 'x' })));
        await assert.rejects(parseUserKeyPassword(encryptionKey, 'AAAA'), /blob length/);
    });
});
