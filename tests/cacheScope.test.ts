import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { nodeScope } from '../src/proton/persistentCache';

/** Node uids as the SDK really spells them: `<volumeId>~<nodeId>`. */
const VOLUME = 'w8SKm5oZxAhYYVfypUQRCf47jLomjutkpnfx2A-ogB7C6bWFDkPaIgk7IhtCKI_BjvIYAfyoEllHeQO1S6aVCQ==';
const INSIDE = `${VOLUME}~cAhpMHUWeNeA_8LbBn8S1mW6Y2pszEhhowG4335697aUZRN19GyAV9m8ORCaPXgD2TT-HYJIzHlp0RUu9XyvrA==`;
const OUTSIDE = `${VOLUME}~ZD7EDo60rN9pWPQ3ovQR0cYTimKyOluvhr-K3IsDCCV2W_QREEtG8YjJt6rOTc7HYSUtOKpE5qsupcy8Sg76Nw==`;
const UNSYNCED_CHILD = `${VOLUME}~Xk3nQ1pO7sUvR2tW9yZa4bCd5eFg6hIj7kLm8nOp9qRs0tUv1wXy2zAb3cDe4fGh5iJk6lMn7oPq8rSt9uVw==`;

/** The key the SDK stores a node under, and the tag naming its parent. */
const nodeKey = (uid: string): string => `node-${uid}`;
const childOf = (parentUid: string): string[] => [`volume:${VOLUME}`, `nodeParentUid:${parentUid}`];

/** What the plugin hands `nodeScope`: the state, the synced folder, its parents, `.devices`. */
const SCOPE_ROOT = `${VOLUME}~RootOfTheSync==`;
const PARENT_OF_ROOT = `${VOLUME}~ParentOfTheSync==`;
const DEVICES_FOLDER = `${VOLUME}~DevicesFolder==`;

function scoped(): Set<string> {
    return new Set([INSIDE, SCOPE_ROOT, PARENT_OF_ROOT, DEVICES_FOLDER]);
}

describe('what the saved Drive metadata cache keeps', () => {
    it('keeps entries for nodes this vault syncs, under the key the SDK uses', () => {
        const inScope = nodeScope(() => scoped());
        assert.equal(inScope(nodeKey(INSIDE), childOf(SCOPE_ROOT)), true);
    });

    it('drops nodes outside the synced folder: those names are the only ones the vault lacks', () => {
        const inScope = nodeScope(() => scoped());
        assert.equal(inScope(nodeKey(OUTSIDE), childOf(`${VOLUME}~SomeOtherFolder==`)), false);
    });

    it('keeps the synced folder, its parents and the .devices folder, which are read on every start', () => {
        const inScope = nodeScope(() => scoped());
        for (const uid of [SCOPE_ROOT, PARENT_OF_ROOT, DEVICES_FOLDER]) {
            assert.equal(inScope(nodeKey(uid), []), true, uid);
        }
    });

    it('keeps a child of the synced folder the state has not recorded yet', () => {
        // A file created a moment ago, or one of the device lists in .devices:
        // inside the vault, and not in the state at the time the cache is written.
        const inScope = nodeScope(() => scoped());
        assert.equal(inScope(nodeKey(UNSYNCED_CHILD), childOf(SCOPE_ROOT)), true);
        assert.equal(inScope(nodeKey(UNSYNCED_CHILD), childOf(DEVICES_FOLDER)), true);
    });

    it('drops a child of a folder outside the synced folder', () => {
        const inScope = nodeScope(() => scoped());
        assert.equal(inScope(nodeKey(UNSYNCED_CHILD), childOf(OUTSIDE)), false);
    });

    it('keeps entries that carry no names at all (shares, volumes, keys)', () => {
        const inScope = nodeScope(() => scoped());
        for (const key of ['shares', `volume-${VOLUME}`, 'privateKey:primary']) {
            assert.equal(inScope(key), true, key);
        }
    });

    it('keeps everything while the vault has not reconciled anything yet', () => {
        // A cache is what makes the first catch-up cheap; dropping it because the
        // state is still empty would defeat that.
        const inScope = nodeScope(() => new Set());
        assert.equal(inScope(nodeKey(OUTSIDE), childOf(OUTSIDE)), true);
    });
});
