import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { setRequestUrlHandler, type RequestUrlParam } from './stubs/obsidian';
import { obsidianFetch } from '../src/proton/obsidianFetch';

function capture(response: Partial<{ status: number; headers: Record<string, string>; body: string }> = {}) {
    const seen: RequestUrlParam[] = [];
    setRequestUrlHandler(async (param) => {
        seen.push(param);
        const text = response.body ?? '';
        return {
            status: response.status ?? 200,
            headers: response.headers ?? { 'content-type': 'application/json' },
            arrayBuffer: new TextEncoder().encode(text).buffer as ArrayBuffer,
            json: text ? JSON.parse(text) : null,
            text,
        };
    });
    return seen;
}

describe('obsidianFetch', () => {
    it('passes method, url and headers through to requestUrl', async () => {
        const seen = capture();

        await obsidianFetch('https://drive-api.proton.me/drive/v2/volumes', {
            method: 'POST',
            headers: { 'x-pm-appversion': 'external-drive-obsidian_sync@0.1.0-alpha' },
            body: '{"a":1}',
        });

        assert.equal(seen.length, 1);
        assert.equal(seen[0]!.url, 'https://drive-api.proton.me/drive/v2/volumes');
        assert.equal(seen[0]!.method, 'POST');
        assert.equal(seen[0]!.headers?.['x-pm-appversion'], 'external-drive-obsidian_sync@0.1.0-alpha');
    });

    it('forwards the request body as bytes', async () => {
        const seen = capture();
        await obsidianFetch('https://example.invalid/', { method: 'POST', body: '{"hello":"world"}' });

        const body = seen[0]!.body as ArrayBuffer;
        assert.equal(new TextDecoder().decode(body), '{"hello":"world"}');
    });

    it('sends no body on GET', async () => {
        const seen = capture();
        await obsidianFetch('https://example.invalid/');
        assert.equal(seen[0]!.body, undefined);
    });

    it('returns a real Response the SDK can read', async () => {
        capture({ status: 200, body: '{"Code":1000}' });
        const response = await obsidianFetch('https://example.invalid/');

        assert.equal(response.ok, true);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), 'application/json');
        assert.deepEqual(await response.json(), { Code: 1000 });
    });

    it('surfaces error statuses rather than throwing, so callers can read the code', async () => {
        // The SDK and the account module both branch on the status; a transport
        // that threw would turn a 422 "not yet approved" into a failed sign-in.
        capture({ status: 422, body: '{"Code":9001}' });
        const response = await obsidianFetch('https://example.invalid/');

        assert.equal(response.ok, false);
        assert.equal(response.status, 422);
        assert.deepEqual(await response.json(), { Code: 9001 });
    });

    it('asks requestUrl not to throw on error statuses', async () => {
        const seen = capture();
        await obsidianFetch('https://example.invalid/');
        assert.equal(seen[0]!.throw, false);
    });

    it('builds a bodyless Response for 204, which would otherwise throw', async () => {
        capture({ status: 204, body: '' });
        const response = await obsidianFetch('https://example.invalid/', { method: 'DELETE' });

        assert.equal(response.status, 204);
        assert.equal(response.body, null);
    });
});
