import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CapabilityError, requireUi, uiProof } from '../src/security/capability';

describe('capability: only this plugin’s UI may act on the account', () => {
    it('refuses a call that does not carry the token, and refuses a guessed one', () => {
        assert.throws(() => requireUi(undefined, 'a share link'), CapabilityError);
        assert.throws(() => requireUi('', 'a share link'), CapabilityError);
        assert.throws(() => requireUi('deadbeef', 'a share link'), CapabilityError);
    });

    it('accepts the token the UI holds', () => {
        assert.doesNotThrow(() => requireUi(uiProof(), 'a share link'));
        assert.equal(uiProof(), uiProof(), 'the token is stable for the session');
    });

    it('says what it refused, so a log line is not a mystery', () => {
        assert.throws(() => requireUi(undefined, 'a share link'), /Refusing a share link/);
        assert.throws(() => requireUi(undefined, 'signing out'), /Refusing signing out/);
    });
});
