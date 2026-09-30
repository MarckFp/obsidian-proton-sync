import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ApiClient } from '../src/proton/account/apiClient';
import { createHttpClient, HTTPError } from '../src/proton/account/http';
import { revokeSession } from '../src/proton/revoke';
import type { SessionCredentials, SessionInfo } from '../src/proton/account/sessionCredentials';
import { Logger } from '../src/util/logger';

type Sent = { url: string; method: string; headers: Headers; body: string | null };
type Reply = Response | Error | 'hang';

/** A `fetch` that records what it was sent and answers from a script. */
function scriptedFetch(replies: Reply[] | ((sent: Sent) => Reply)) {
    const sent: Sent[] = [];
    const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const request: Sent = {
            url: String(input),
            method: init?.method ?? 'GET',
            headers: new Headers(init?.headers),
            body: typeof init?.body === 'string' ? init.body : null,
        };
        sent.push(request);
        const reply = typeof replies === 'function' ? replies(request) : replies.shift();
        if (reply === undefined) {
            throw new Error('no scripted reply left');
        }
        if (reply === 'hang') {
            return new Promise(() => undefined);
        }
        if (reply instanceof Error) {
            throw reply;
        }
        return reply;
    };
    return { fetch: fetch as typeof globalThis.fetch, sent };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function client(replies: Reply[] | ((sent: Sent) => Reply)) {
    const transport = scriptedFetch(replies);
    return {
        http: createHttpClient({ fetch: transport.fetch, timeout: 1000, headers: () => ({ 'x-pm-appversion': 'test' }) }),
        sent: transport.sent,
    };
}

describe('createHttpClient', () => {
    it('sends JSON, query parameters and default headers, and parses the reply', async () => {
        const { http, sent } = client([json({ Code: 1000 })]);
        const result = await http
            .post<{ Code: number }>('https://api.test/core/v4/auth', { json: { a: 1 }, searchParams: { Page: 0 } })
            .json();

        assert.deepEqual(result, { Code: 1000 });
        assert.equal(sent[0].url, 'https://api.test/core/v4/auth?Page=0');
        assert.equal(sent[0].method, 'POST');
        assert.equal(sent[0].body, '{"a":1}');
        assert.equal(sent[0].headers.get('content-type'), 'application/json');
        assert.equal(sent[0].headers.get('accept'), 'application/json');
        assert.equal(sent[0].headers.get('x-pm-appversion'), 'test');
    });

    it('throws HTTPError for a failed request, unless told not to', async () => {
        const { http } = client([json({ Code: 2501 }, 404), json({ Code: 2501 }, 404)]);
        await assert.rejects(http.get('https://api.test/x').json(), (error: unknown) => {
            assert.ok(error instanceof HTTPError);
            assert.equal(error.response.status, 404);
            return true;
        });
        const response = await http('https://api.test/x', { throwHttpErrors: false });
        assert.equal(response.status, 404);
    });

    it('retries a GET that hit a rate limit, waiting as long as Retry-After says', async () => {
        const { http, sent } = client([json({}, 429, { 'retry-after': '0' }), json({ ok: true })]);
        assert.deepEqual(await http.get('https://api.test/x').json(), { ok: true });
        assert.equal(sent.length, 2);
    });

    it('does not retry a POST, which may not be safe to repeat', async () => {
        const { http, sent } = client([json({}, 503, { 'retry-after': '0' })]);
        await assert.rejects(http.post('https://api.test/x').json(), HTTPError);
        assert.equal(sent.length, 1);
    });

    it('does not retry a 413 that gives no Retry-After', async () => {
        const { http, sent } = client([json({}, 413)]);
        await assert.rejects(http.get('https://api.test/x').json(), HTTPError);
        assert.equal(sent.length, 1);
    });

    it('retries a GET after a network error, but not when retries are off', async () => {
        const retried = client([new TypeError('Failed to fetch'), json({ ok: true })]);
        assert.deepEqual(await retried.http.get('https://api.test/x').json(), { ok: true });
        assert.equal(retried.sent.length, 2);

        const single = client([new TypeError('Failed to fetch')]);
        await assert.rejects(single.http('https://api.test/x', { retry: false }), /Failed to fetch/);
        assert.equal(single.sent.length, 1);
    });

    it('fails with a TimeoutError, the name the Drive SDK retries on', async () => {
        const { http } = client(['hang']);
        await assert.rejects(http('https://api.test/x', { timeout: 20 }), { name: 'TimeoutError' });
    });

    it('fails with an AbortError when the signal fires', async () => {
        const { http } = client(['hang']);
        const controller = new AbortController();
        const pending = http('https://api.test/x', { signal: controller.signal });
        controller.abort();
        await assert.rejects(pending, { name: 'AbortError' });
    });
});

class FakeCredentials implements SessionCredentials {
    uid: string | undefined = 'uid-1';
    accessToken: string | undefined = 'old';
    refreshToken: string | undefined = 'refresh-1';
    signedOut = false;

    on(): void {}
    isLoggedIn(): boolean {
        return true;
    }
    isTelemetryEnabled(): boolean {
        return false;
    }
    getUserKeyPassword(): string | undefined {
        return undefined;
    }
    async load(): Promise<void> {}
    async setUserKeyPassword(): Promise<void> {}
    async setSessionInfo(info: SessionInfo): Promise<void> {
        this.uid = info.uid;
        this.accessToken = info.accessToken;
        this.refreshToken = info.refreshToken ?? this.refreshToken;
    }
    async setTelemetryEnabled(): Promise<void> {}
    async signOut(): Promise<void> {
        this.signedOut = true;
    }
}

describe('ApiClient session refresh', () => {
    const refreshReply = () => json({ UID: 'uid-1', AccessToken: 'new', RefreshToken: 'refresh-2' });

    it('refreshes an expired session and repeats the request with the new token', async () => {
        const credentials = new FakeCredentials();
        const transport = scriptedFetch((request) => {
            if (request.url.endsWith('/auth/v4/refresh')) {
                return refreshReply();
            }
            return request.headers.get('authorization') === 'Bearer new' ? json({ User: 'me' }) : json({}, 401);
        });
        const api = new ApiClient({
            baseUrl: 'api.test',
            appVersion: 'test',
            credentials,
            logger: new Logger('error'),
            fetch: transport.fetch,
        });

        const result = await api.authenticatedRequest.get(`${api.baseUrlWithProtocol}/core/v4/users`).json();
        assert.deepEqual(result, { User: 'me' });
        assert.equal(credentials.accessToken, 'new');
        assert.equal(credentials.refreshToken, 'refresh-2');
        assert.deepEqual(
            transport.sent.map((request) => request.url.replace('https://api.test', '')),
            ['/core/v4/users', '/auth/v4/refresh', '/core/v4/users'],
        );
    });

    it('repeats a request at most once, even if it keeps being rejected', async () => {
        const credentials = new FakeCredentials();
        const transport = scriptedFetch((request) =>
            request.url.endsWith('/auth/v4/refresh') ? refreshReply() : json({}, 401),
        );
        const api = new ApiClient({
            baseUrl: 'api.test',
            appVersion: 'test',
            credentials,
            logger: new Logger('error'),
            fetch: transport.fetch,
        });

        const response = await api.authenticatedRequest(`${api.baseUrlWithProtocol}/core/v4/users`, {
            throwHttpErrors: false,
        });
        assert.equal(response.status, 401);
        assert.equal(transport.sent.filter((request) => request.url.endsWith('/core/v4/users')).length, 2);
    });

    it('signs out when the refresh token is refused', async () => {
        const credentials = new FakeCredentials();
        const transport = scriptedFetch((request) =>
            request.url.endsWith('/auth/v4/refresh') ? json({ Code: 10013 }, 400) : json({}, 401),
        );
        const api = new ApiClient({
            baseUrl: 'api.test',
            appVersion: 'test',
            credentials,
            logger: new Logger('error'),
            fetch: transport.fetch,
        });

        await assert.rejects(api.authenticatedRequest.get(`${api.baseUrlWithProtocol}/core/v4/users`).json(), HTTPError);
        assert.equal(credentials.signedOut, true);
    });
});

describe('revokeSession', () => {
    function api(reply: (request: Sent) => Reply) {
        const transport = scriptedFetch(reply);
        const client = new ApiClient({
            baseUrl: 'api.test',
            appVersion: 'test',
            credentials: new FakeCredentials(),
            logger: new Logger('error'),
            fetch: transport.fetch,
        });
        return { client, sent: transport.sent };
    }

    it('ends the session on Proton with DELETE /auth/v4, sending the session headers', async () => {
        const { client, sent } = api(() => json({ Code: 1000 }));
        assert.equal(await revokeSession(client, new Logger('error')), true);
        assert.equal(sent[0].method, 'DELETE');
        assert.equal(sent[0].url, 'https://api.test/auth/v4');
        assert.equal(sent[0].headers.get('authorization'), 'Bearer old');
        assert.equal(sent[0].headers.get('x-pm-uid'), 'uid-1');
    });

    it('reports failure without throwing, so sign-out can still finish locally', async () => {
        assert.equal(await revokeSession(api(() => json({}, 500)).client, new Logger('error')), false);
        assert.equal(
            await revokeSession(api(() => new TypeError('Failed to fetch')).client, new Logger('error')),
            false,
        );
    });
});
