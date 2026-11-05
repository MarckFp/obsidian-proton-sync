import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assertProtonUrl, isProtonUrl } from '../src/proton/endpoints';
import { createHttpClient } from '../src/proton/account/http';

describe('requests go to Proton and nowhere else', () => {
    it('allows the hosts the plugin actually uses', () => {
        for (const url of [
            'https://drive-api.proton.me/drive/v2/shares/my-files',
            'https://drive.proton.me/api/',
            'https://account.proton.me/auth/v4',
            'https://zrh-storage.proton.me/storage/blocks',
            'https://pass.proton.me/',
        ]) {
            assert.doesNotThrow(() => assertProtonUrl(url), url);
            assert.equal(isProtonUrl(url), true, url);
        }
    });

    it('refuses anything else, so a token cannot be sent elsewhere', () => {
        for (const url of [
            'https://api.test/auth/v4',
            'https://proton.me.evil.example/collect',
            'http://drive-api.proton.me/drive',
            'https://notproton.me/x',
            'file:///etc/passwd',
        ]) {
            assert.throws(() => assertProtonUrl(url), /only talks to Proton/, url);
        }
    });

    it('is wired into the transport, not just available', async () => {
        const http = createHttpClient({
            fetch: () => Promise.reject(new Error('must not be reached')),
            headers: () => ({}),
            timeout: 1000,
        });
        await assert.rejects(http.get('https://example.invalid/collect').json(), /only talks to Proton/);
    });
});
