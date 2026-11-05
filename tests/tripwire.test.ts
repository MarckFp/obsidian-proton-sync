import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { callerPlugin, installTripwires, pluginIdsInStack } from '../src/security/tripwire';
import { Logger } from '../src/util/logger';

/** The shapes Obsidian really emits: `plugin:<id>` frames, and a file path. */
const STACK = [
    'Error: tripwire',
    '    at Object.getSecret (app://obsidian.md/app.js:207:80073)',
    '    at plugin:attacker-probe:23:9',
    '    at async eval (app://obsidian.md/plugins/other-plugin/main.js:7:1)',
].join('\n');

describe('naming the plugin behind an access', () => {
    it('finds the plugin ids in a stack, nearest frame first', () => {
        assert.deepEqual(pluginIdsInStack(STACK), ['attacker-probe', 'other-plugin']);
    });

    it('ignores this plugin’s own frames, so its own reads are not accusations', () => {
        const own = [
            'Error: tripwire',
            '    at plugin:proton-drive-sync:1:1',
            '    at onload (app://obsidian.md/app.js:207:1)',
        ].join('\n');
        assert.equal(callerPlugin(own, 'proton-drive-sync'), null);
        assert.deepEqual(pluginIdsInStack(own), ['proton-drive-sync']);
    });

    it('returns nothing when no plugin file is in the stack', () => {
        assert.equal(callerPlugin('Error: tripwire\n    at foo (app://obsidian.md/app.js:1:1)', 'proton-drive-sync'), null);
    });
});

describe('tripwires on the shared secret storage', () => {
    function fakeApp() {
        const secrets = new Map<string, string>([
            ['proton-drive-sync-session-abc', '{"accessToken":"t"}'],
            ['someone-else', 'theirs'],
        ]);
        const storage = {
            getSecret: (id: string) => secrets.get(id) ?? '',
            peekSecret: (id: string) => secrets.get(id) ?? '',
            listSecrets: () => [...secrets.keys()],
        };
        return { app: { secretStorage: storage } as never, storage, secrets };
    }

    it('leaves the API working and reports nothing when the caller is not a plugin', () => {
        const { app, storage } = fakeApp();
        const hits: unknown[] = [];
        installTripwires({
            app,
            selfId: 'proton-drive-sync',
            instance: {},
            logger: new Logger('error'),
            onHit: (hit) => hits.push(hit),
        });
        // Called from this test file: no plugin frame in the stack.
        assert.equal(storage.getSecret('proton-drive-sync-session-abc'), '{"accessToken":"t"}');
        assert.deepEqual(hits, []);
    });

    it('installs once while loaded, and again after an unload', () => {
        const { app, storage } = fakeApp();
        const original = storage.getSecret;
        const base = {
            app,
            selfId: 'proton-drive-sync',
            logger: new Logger('error'),
            onHit: () => {},
        };
        const first = installTripwires({ ...base, instance: {} });
        const patched = storage.getSecret;
        assert.notEqual(patched, original, 'the shared method is wrapped');

        // A second install while loaded reuses the wiring: wrappers must not nest.
        installTripwires({ ...base, instance: {} });
        assert.equal(storage.getSecret, patched);

        first.uninstall();
        assert.equal(storage.getSecret, original, 'the shared method is restored on unload');

        // Reloading: the instance that is now loaded gets its own wiring, and
        // an old report's uninstall cannot take it away.
        const second = installTripwires({ ...base, instance: {} });
        assert.notEqual(storage.getSecret, original, 'the new instance wraps the method again');
        first.uninstall();
        assert.notEqual(storage.getSecret, original, 'the old uninstall leaves the new wiring alone');
        second.uninstall();
        assert.equal(storage.getSecret, original);
    });

    it('takes the trap getters off on unload, so a real field can take the name again', () => {
        const instance: Record<string, unknown> = {};
        const report = installTripwires({
            app: fakeApp().app,
            selfId: 'proton-drive-sync',
            instance,
            logger: new Logger('error'),
            onHit: () => {},
        });
        assert.equal('session' in instance, true);
        report.uninstall();
        assert.equal('session' in instance, false);
        // Idempotent: a second unload is not an error.
        report.uninstall();
    });

    it('puts traps on the names a hostile plugin would try, and keeps them off the instance’s own keys', () => {
        const instance: Record<string, unknown> = { onload: () => undefined };
        installTripwires({
            app: fakeApp().app,
            selfId: 'proton-drive-sync',
            instance,
            logger: new Logger('error'),
            onHit: () => {},
        });
        // `onload` is untouched; the tempting names exist as getters returning
        // nothing, and are invisible to `Object.keys`.
        assert.equal(typeof instance.onload, 'function');
        assert.equal(instance.session, undefined);
        assert.equal(Object.keys(instance).includes('session'), false);
    });
});
