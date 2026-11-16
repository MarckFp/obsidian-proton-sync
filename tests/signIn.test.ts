import '../src/polyfills';

import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { AccountApi, AccountApiError } from '../src/proton/account/accountApi';
import { Auth } from '../src/proton/account/auth';
import { TimeoutError } from '../src/proton/account/http';
import type { SessionCredentials } from '../src/proton/account/sessionCredentials';
import type { Srp } from '../src/proton/account/srp';
import { isTransientAccountError } from '../src/proton/account/transient';
import { withAccountRetry } from '../src/proton/accountRetry';
import { Logger } from '../src/util/logger';

const SILENT = new Logger('error');

/** Encrypt a fork payload the way account.proton.me does: AES-256-GCM, AAD "fork", nonce‖ciphertext‖tag. */
function forkPayload(key: Uint8Array, json: object): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from('fork'));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(json), 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64');
}

/** What Android passes on when the app is cut off from the network: no HTTP answer at all. */
const unreachable = () =>
    new AccountApiError('UnknownHostException: Unable to resolve host "drive-api.proton.me"', {
        cause: new Error('UnknownHostException'),
    });
const notYet = () => new AccountApiError('not ready', { httpCode: 422, code: 0, debug: {} });

/** Let timer-driven work run on, a mocked second at a time, until `promise` settles; fails rather than hangs. */
async function settle<T>(promise: Promise<T>): Promise<T> {
    let done = false;
    const watched = promise.finally(() => {
        done = true;
    });
    watched.catch(() => undefined);
    for (let turn = 0; turn < 2_000 && !done; turn++) {
        await new Promise((resolve) => setImmediate(resolve));
        mock.timers.tick(1000);
    }
    assert.ok(done, 'still running after half an hour of mocked time');
    return watched;
}

describe('signing in on a flaky connection (Android)', () => {
    beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 }));
    afterEach(() => mock.timers.reset());

    function auth(statusReplies: (() => unknown)[]) {
        let key: Uint8Array | null = null;
        const saved: Record<string, unknown> = {};
        let checks = 0;
        const api = {
            sessionForksInit: async () => ({ UserCode: 'CODE', Selector: 'selector' }),
            sessionForksStatus: async () => {
                const reply = statusReplies[Math.min(checks++, statusReplies.length - 1)]!();
                if (reply instanceof Error) {
                    throw reply;
                }
                return reply;
            },
            settings: async () => ({ UserSettings: { Telemetry: 0 } }),
        } as unknown as AccountApi;
        const credentials = {
            setUserKeyPassword: async (value: string) => void (saved.keyPassword = value),
            setSessionInfo: async (value: unknown) => void (saved.session = value),
            setTelemetryEnabled: async () => undefined,
        } as unknown as SessionCredentials;
        const signIn = new Auth('external-drive', api, credentials, {} as Srp, SILENT).authViaWeb((url) => {
            const parts = decodeURIComponent(url.split('#payload=')[1]!).split(':');
            key = Buffer.from(parts[2]!, 'base64');
        });
        const approved = () => ({
            UID: 'uid',
            AccessToken: 'access',
            RefreshToken: 'refresh',
            Payload: forkPayload(key!, { type: 'default', keyPassword: 'hunter2' }),
        });
        return { signIn, approved, saved, checks: () => checks };
    }

    it('keeps polling through checks that never reached Proton, and finishes once one does', async () => {
        const replies: (() => unknown)[] = [notYet, unreachable, unreachable, notYet];
        const { signIn, approved, saved, checks } = auth(replies);
        replies.push(() => approved());

        const result = await settle(signIn);
        assert.equal(result.uid, 'uid');
        assert.equal(saved.keyPassword, 'hunter2');
        assert.equal(checks(), 5);
    });

    it('still stops at once when Proton refuses the sign-in', async () => {
        const refused = () => new AccountApiError('Invalid selector', { httpCode: 400, code: 2001, debug: {} });
        const { signIn, checks } = auth([unreachable, refused]);

        await assert.rejects(settle(signIn), /Invalid selector/);
        assert.equal(checks(), 2);
    });

    it('gives up after the usual ten minutes when Proton is never reached', async () => {
        const { signIn } = auth([unreachable]);
        await assert.rejects(settle(signIn), /timed out/);
    });

    describe('finishing after the approval', () => {
        function addressLookup(replies: (() => unknown)[]) {
            let asked = 0;
            const lookup = async () => {
                const reply = replies[Math.min(asked++, replies.length - 1)]!();
                if (reply instanceof Error) {
                    throw reply;
                }
                return reply as { email: string };
            };
            return { lookup, asked: () => asked };
        }
        const PATIENT = [2_000, 4_000, 8_000, 15_000, 30_000];

        it('waits for the connection to come back rather than failing the sign-in', async () => {
            const { lookup } = addressLookup([unreachable, unreachable, () => ({ email: 'me@proton.me' })]);
            assert.deepEqual(await settle(withAccountRetry(lookup, PATIENT, SILENT, 'the address')), {
                email: 'me@proton.me',
            });
        });

        it('gives up without failing, once the waits are used up', async () => {
            const { lookup, asked } = addressLookup([unreachable]);
            assert.equal(await settle(withAccountRetry(lookup, PATIENT, SILENT, 'the address')), undefined);
            assert.equal(asked(), PATIENT.length + 1);
        });

        it('tries once with no waits', async () => {
            const { lookup, asked } = addressLookup([unreachable]);
            assert.equal(await settle(withAccountRetry(lookup, [], SILENT, 'the address')), undefined);
            assert.equal(asked(), 1);
        });

        it('still fails at once on a real error', async () => {
            const forbidden = () => new AccountApiError('Forbidden', { httpCode: 403, code: 0, debug: {} });
            const { lookup, asked } = addressLookup([forbidden]);
            await assert.rejects(settle(withAccountRetry(lookup, PATIENT, SILENT, 'the address')), /Forbidden/);
            assert.equal(asked(), 1);
        });
    });
});

describe('isTransientAccountError', () => {
    it('retries what never got an answer, or a busy one, and nothing else', () => {
        assert.equal(isTransientAccountError(unreachable()), true);
        assert.equal(isTransientAccountError(new TimeoutError({ method: 'GET', url: 'https://x.proton.me' })), true);
        for (const status of [408, 429, 500, 503]) {
            assert.equal(isTransientAccountError(new AccountApiError('busy', { httpCode: status })), true, `${status}`);
        }
        for (const status of [400, 401, 403, 404, 422]) {
            assert.equal(isTransientAccountError(new AccountApiError('no', { httpCode: status })), false, `${status}`);
        }
        assert.equal(isTransientAccountError(new Error('payload could not be decrypted')), false);
    });
});
