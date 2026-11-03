import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CapabilityError, requireUi, uiProof } from '../src/security/capability';
import { checkPermissions } from '../src/security/permissions';
import { checkSelf } from '../src/security/selfIntegrity';
import { Logger } from '../src/util/logger';

const SILENT = new Logger('error');

function memoryAdapter(files: Map<string, Uint8Array | string>) {
    return {
        exists: async (path: string) => files.has(path),
        read: async (path: string) => String(files.get(path) ?? ''),
        readBinary: async (path: string) => {
            const value = files.get(path);
            if (value === undefined) {
                throw new Error('missing');
            }
            const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
            return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        },
        write: async (path: string, data: string) => {
            files.set(path, data);
        },
    };
}

describe('capability: only this plugin’s UI may ask for a share link', () => {
    it('refuses a call that does not carry the token, and refuses a guessed one', () => {
        assert.throws(() => requireUi(undefined, 'a share link'), CapabilityError);
        assert.throws(() => requireUi('', 'a share link'), CapabilityError);
        assert.throws(() => requireUi('deadbeef', 'a share link'), CapabilityError);
    });

    it('accepts the token the UI holds', () => {
        assert.doesNotThrow(() => requireUi(uiProof(), 'a share link'));
        assert.equal(uiProof(), uiProof(), 'the token is stable for the session');
    });
});

describe('permissions: who else can write what the plugin trusts', () => {
    function stubFs(modes: Record<string, number>) {
        (globalThis as unknown as { window: { require: unknown } }).window = {
            require: (module: string) => {
                assert.equal(module, 'fs');
                return {
                    statSync: (path: string) => {
                        if (!(path in modes)) {
                            throw new Error('missing');
                        }
                        return { mode: modes[path] };
                    },
                };
            },
        };
    }

    const app = (base: string) =>
        ({ vault: { adapter: { getBasePath: () => base } } }) as never;

    it('reports a world-writable plugin folder: whoever writes it runs code', () => {
        (globalThis as unknown as { window: unknown }).window = undefined;
        stubFs({ '/v/.obsidian/plugins/proton-drive-sync': 0o40777 });
        const findings = checkPermissions(app('/v'), '.obsidian/plugins/proton-drive-sync');
        assert.equal(findings.length, 1);
        assert.match(findings[0].problem, /writable by anyone/);
        assert.equal(findings[0].mode, '0777');
    });

    it('says nothing about a folder only its owner can write', () => {
        (globalThis as unknown as { window: unknown }).window = undefined;
        stubFs({ '/v/.obsidian/plugins/proton-drive-sync': 0o40755, '/v/.obsidian': 0o40755 });
        assert.deepEqual(checkPermissions(app('/v'), '.obsidian/plugins/proton-drive-sync'), []);
    });

    it('treats a world-readable stored sign-in as a finding of its own', () => {
        (globalThis as unknown as { window: unknown }).window = undefined;
        stubFs({ '/v/.obsidian/plugins/proton-drive-sync/session.bin': 0o100644 });
        const findings = checkPermissions(app('/v'), '.obsidian/plugins/proton-drive-sync');
        assert.equal(findings.length, 1);
        assert.match(findings[0].problem, /readable by anyone/);
    });
});

describe('integrity: code that changed without a new version', () => {
    it('records the code on the first run', async () => {
        const files = new Map<string, string>([['p/main.js', 'code-v1']]);
        const state = await checkSelf({ vault: { adapter: memoryAdapter(files) } } as never, 'p', '1.0.0', SILENT);
        assert.equal(state, 'first-run');
        assert.ok(files.has('p/plugin-self.json'));
    });

    it('says nothing when the code is the code that was recorded', async () => {
        const files = new Map<string, string>([['p/main.js', 'code-v1']]);
        const app = { vault: { adapter: memoryAdapter(files) } } as never;
        await checkSelf(app, 'p', '1.0.0', SILENT);
        assert.equal(await checkSelf(app, 'p', '1.0.0', SILENT), 'unchanged');
    });

    it('calls a new version an update, and the same version with new code tampering', async () => {
        const files = new Map<string, string>([['p/main.js', 'code-v1']]);
        const app = { vault: { adapter: memoryAdapter(files) } } as never;
        await checkSelf(app, 'p', '1.0.0', SILENT);

        files.set('p/main.js', 'code-v2');
        assert.equal(await checkSelf(app, 'p', '1.1.0', SILENT), 'updated');

        files.set('p/main.js', 'code-v2-tampered');
        assert.equal(await checkSelf(app, 'p', '1.1.0', SILENT), 'changed-without-update');
    });
});
