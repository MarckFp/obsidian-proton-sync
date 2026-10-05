import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXPIRY_CHOICES, expiryFor } from '../src/ui/shareModal';

describe('share link expiry', () => {
    it('offers never, a day, a week and a month', () => {
        assert.deepEqual(
            EXPIRY_CHOICES.map((choice) => choice.days),
            [null, 1, 7, 30],
        );
    });

    it('counts days from now, and gives no date for never', () => {
        assert.equal(expiryFor(null, 0), undefined);
        assert.equal(expiryFor(7, 1_000)?.getTime(), 1_000 + 7 * 86_400_000);
    });
});
