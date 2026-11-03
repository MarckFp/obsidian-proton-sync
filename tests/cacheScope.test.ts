import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { nodeScope } from '../src/proton/persistentCache';

const INSIDE = 'w8SKm5oZxAhYYVfypUQRCf47jLomjutkpnfx2A-ogB7C6bWFDkPaIgk7IhtCKI_BjvIYAfyoEllHeQO1S6aVCQ==~cAhpMHUWeNeA_8LbBn8S1mW6Y2pszEhhowG4335697aUZRN19GyAV9m8ORCaPXgD2TT-HYJIzHlp0RUu9XyvrA==';
const OUTSIDE = 'w8SKm5oZxAhYYVfypUQRCf47jLomjutkpnfx2A-ogB7C6bWFDkPaIgk7IhtCKI_BjvIYAfyoEllHeQO1S6aVCQ==~ZD7EDo60rN9pWPQ3ovQR0cYTimKyOluvhr-K3IsDCCV2W_QREEtG8YjJt6rOTc7HYSUtOKpE5qsupcy8Sg76Nw==';

describe('what the saved Drive metadata cache keeps', () => {
    it('keeps entries for nodes this vault syncs', () => {
        const inScope = nodeScope(() => new Set([INSIDE]));
        assert.equal(inScope(INSIDE), true);
    });

    it('drops nodes outside the synced folder: those names are the only ones the vault lacks', () => {
        const inScope = nodeScope(() => new Set([INSIDE]));
        assert.equal(inScope(OUTSIDE), false);
    });

    it('keeps entries that carry no names at all (shares, volumes, keys)', () => {
        const inScope = nodeScope(() => new Set([INSIDE]));
        for (const key of ['shares', 'volume:abc', 'privateKey:primary']) {
            assert.equal(inScope(key), true, key);
        }
    });

    it('keeps everything while the vault has not reconciled anything yet', () => {
        // A cache is what makes the first catch-up cheap; dropping it because the
        // state is still empty would defeat that.
        const inScope = nodeScope(() => new Set());
        assert.equal(inScope(OUTSIDE), true);
    });
});
