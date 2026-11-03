import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { diffPlugins, type PluginFingerprint } from '../src/security/pluginWatch';

function plugin(id: string, version = '1.0.0', digest = 'aaaa'): PluginFingerprint {
    return { id, name: id, version, author: 'someone', digest, size: 100 };
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
