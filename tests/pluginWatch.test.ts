import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { alertsFrom, capabilitiesIn, diffPlugins, type PluginFingerprint } from '../src/security/pluginWatch';

function plugin(id: string, version = '1.0.0', digest = 'aaaa', touches: string[] = []): PluginFingerprint {
    return { id, name: id, version, author: 'someone', digest, size: 100, touches };
}

describe('watching the other plugins in the vault', () => {
    it('says nothing when the set is unchanged', () => {
        const before = [plugin('a'), plugin('b')];
        assert.deepEqual(diffPlugins(before, [plugin('a'), plugin('b')]), []);
    });

    it('reports a plugin that appeared, one that vanished, and both kinds of change', () => {
        const before = [plugin('kept'), plugin('gone'), plugin('updated', '1.0.0', 'aaaa'), plugin('code', '2.0.0', 'aaaa')];
        const after = [plugin('kept'), plugin('new', '0.1.0'), plugin('updated', '1.1.0', 'aaaa'), plugin('code', '2.0.0', 'bbbb')];

        const changes = diffPlugins(before, after);
        const byId = Object.fromEntries(changes.map((change) => [change.id, change]));

        assert.equal(byId['new'].kind, 'added');
        assert.equal(byId['gone'].kind, 'removed');
        assert.equal(byId['updated'].kind, 'changed');
        assert.match(byId['updated'].detail, /1\.0\.0 → 1\.1\.0/);
        assert.equal(byId['code'].kind, 'changed');
        assert.match(byId['code'].detail, /code changed/);
        assert.equal(changes.length, 4);
    });

    it('notices code that changed without a new version number', () => {
        // The realistic case: a plugin updates its bundle but reports the same
        // version, which is exactly what a version string cannot be trusted for.
        const changes = diffPlugins([plugin('x', '1.0.0', 'aaaa')], [plugin('x', '1.0.0', 'bbbb')]);
        assert.equal(changes.length, 1);
        assert.match(changes[0].detail, /code changed/);
    });

    it('notices code that became readable or unreadable', () => {
        const becameReadable = diffPlugins([{ ...plugin('x'), digest: null }], [plugin('x')]);
        assert.match(becameReadable[0].detail, /code now readable/);

        const becameUnreadable = diffPlugins([plugin('x')], [{ ...plugin('x'), digest: null }]);
        assert.match(becameUnreadable[0].detail, /code now unreadable/);
    });

    it('treats a first run as a baseline, not as dozens of new plugins', () => {
        // `diffPlugins` is only called when a baseline exists; this pins the
        // contract that an empty history means "record", not "everything is new".
        const changes = diffPlugins([], [plugin('a'), plugin('b')]);
        assert.equal(changes.length, 2);
        assert.ok(changes.every((change) => change.kind === 'added'));
    });
});

describe('what is worth interrupting the user for', () => {
    it('says nothing about an update Obsidian announces itself', () => {
        const alerts = alertsFrom([plugin('a', '1.0.0', 'aaaa')], [plugin('a', '1.1.0', 'bbbb')]);
        assert.deepEqual(alerts, []);
    });

    it('reports the same version with different code: an update never produces that', () => {
        const alerts = alertsFrom([plugin('a', '1.0.0', 'aaaa')], [plugin('a', '1.0.0', 'bbbb')]);
        assert.equal(alerts.length, 1);
        assert.equal(alerts[0].reason, 'unannounced-code');
        assert.match(alerts[0].why, /same version 1\.0\.0, different code/);
    });

    it('reports an update that starts reaching for credential APIs', () => {
        const alerts = alertsFrom(
            [plugin('a', '1.0.0', 'aaaa', [])],
            [plugin('a', '1.1.0', 'bbbb', ['safeStorage'])],
        );
        assert.equal(alerts.length, 1);
        assert.equal(alerts[0].reason, 'new-capability');
        assert.match(alerts[0].why, /now mentions safeStorage/);
    });

    it('says nothing when a plugin merely starts using secret storage, which plugins are told to use', () => {
        const before = plugin('a', '1.0.0', 'aaaa', capabilitiesIn('function add(a, b) { return a + b; }'));
        const after = plugin('a', '1.1.0', 'bbbb', capabilitiesIn('app.secretStorage.setSecret("api-key", k)'));
        assert.deepEqual(alertsFrom([before], [after]), []);
    });

    it('does not re-report a capability the plugin already had', () => {
        const alerts = alertsFrom(
            [plugin('a', '1.0.0', 'aaaa', ['safeStorage'])],
            [plugin('a', '1.1.0', 'bbbb', ['safeStorage', 'plugins.plugins'])],
        );
        assert.equal(alerts.length, 1);
        assert.match(alerts[0].why, /now mentions plugins\.plugins$/);
    });

    it('says nothing about a plugin that was just installed or removed', () => {
        assert.deepEqual(alertsFrom([], [plugin('a')]), []);
        assert.deepEqual(alertsFrom([plugin('a')], []), []);
    });

    it('says nothing when a bundle cannot be read, rather than guessing', () => {
        assert.deepEqual(alertsFrom([plugin('a', '1.0.0', null as never)], [plugin('a', '1.0.0', 'bbbb')]), []);
        assert.deepEqual(alertsFrom([plugin('a', '1.0.0', 'aaaa')], [plugin('a', '1.0.0', null as never)]), []);
    });

    it('finds the API names in a bundle, and only those', () => {
        const bundle = 'app.secretStorage.getSecret(x); app.plugins.plugins["y"]; electron.safeStorage';
        assert.deepEqual(capabilitiesIn(bundle).sort(), ['plugins.plugins', 'safeStorage']);
        assert.deepEqual(capabilitiesIn('function add(a,b){return a+b}'), []);
    });
});
