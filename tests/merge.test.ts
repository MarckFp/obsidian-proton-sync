import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mergeThreeWay } from '../src/sync/merge';

const lines = (...items: string[]) => items.join('\n');

function mergedText(base: string, local: string, remote: string): string {
    const result = mergeThreeWay(base, local, remote);
    assert.equal(result.merged, true, `expected a merge, got ${JSON.stringify(result)}`);
    return (result as { merged: true; text: string }).text;
}

function refusal(base: string, local: string, remote: string): string {
    const result = mergeThreeWay(base, local, remote);
    assert.equal(result.merged, false, `expected a refusal, got ${JSON.stringify(result)}`);
    return (result as { merged: false; reason: string }).reason;
}

describe('mergeThreeWay — disjoint edits', () => {
    it('keeps both sides when they edited different regions', () => {
        const base = lines('# Note', '', 'alpha', '', 'beta');
        const local = lines('# Note', '', 'ALPHA', '', 'beta');
        const remote = lines('# Note', '', 'alpha', '', 'BETA');
        assert.equal(mergedText(base, local, remote), lines('# Note', '', 'ALPHA', '', 'BETA'));
    });

    it('combines an append on one side with an edit on the other', () => {
        const base = lines('one', 'two');
        const local = lines('ONE', 'two');
        const remote = lines('one', 'two', 'three');
        assert.equal(mergedText(base, local, remote), lines('ONE', 'two', 'three'));
    });

    it('keeps a deletion on one side and an edit elsewhere on the other', () => {
        const base = lines('a', 'b', 'c', 'd', 'e');
        const local = lines('a', 'c', 'd', 'e');
        const remote = lines('a', 'b', 'c', 'd', 'E');
        assert.equal(mergedText(base, local, remote), lines('a', 'c', 'd', 'E'));
    });
});

describe('mergeThreeWay — one side unchanged', () => {
    it('takes the local version when the remote never moved', () => {
        const base = lines('a', 'b');
        const local = lines('a', 'b', 'c');
        assert.equal(mergedText(base, local, base), local);
    });

    it('takes the remote version when the local never moved', () => {
        const base = lines('a', 'b');
        const remote = lines('a', 'b', 'c');
        assert.equal(mergedText(base, base, remote), remote);
    });

    it('is a no-op when nothing moved', () => {
        const base = lines('a', 'b');
        assert.equal(mergedText(base, base, base), base);
    });
});

describe('mergeThreeWay — convergent edits', () => {
    it('accepts both sides having made the identical change', () => {
        const base = lines('a', 'b');
        const both = lines('a', 'B');
        assert.equal(mergedText(base, both, both), both);
    });
});

describe('mergeThreeWay — refusals', () => {
    it('refuses when both sides rewrote the same line differently', () => {
        const base = lines('a', 'b', 'c');
        assert.equal(refusal(base, lines('a', 'LOCAL', 'c'), lines('a', 'REMOTE', 'c')), 'overlapping-edits');
    });

    it('refuses when one side edited a line the other deleted', () => {
        const base = lines('a', 'b', 'c');
        assert.equal(refusal(base, lines('a', 'c'), lines('a', 'B', 'c')), 'overlapping-edits');
    });

    it('refuses to interleave two different insertions at the same point', () => {
        // Both sides appended different text in the same place. Either order is
        // a guess, so neither is produced.
        const base = lines('a', 'z');
        assert.equal(refusal(base, lines('a', 'local', 'z'), lines('a', 'remote', 'z')), 'overlapping-edits');
    });

    it('declines binary content instead of corrupting it', () => {
        assert.equal(refusal('a\0b', 'a\0c', 'a\0d'), 'binary');
    });

    it('declines a diff too large to compute cheaply', () => {
        const base = Array.from({ length: 6000 }, (_, i) => `base ${i}`).join('\n');
        const local = Array.from({ length: 6000 }, (_, i) => `local ${i}`).join('\n');
        assert.equal(refusal(base, local, base), 'too-large');
    });
});

describe('mergeThreeWay — line endings', () => {
    it('preserves CRLF when the local copy uses it', () => {
        const base = 'a\r\nb';
        const local = 'a\r\nB';
        const remote = 'a\r\nb\r\nc';
        assert.equal(mergedText(base, local, remote), 'a\r\nB\r\nc');
    });
});

describe('mergeThreeWay — realistic note', () => {
    it('merges edits made on two devices to different sections', () => {
        const base = lines(
            '# Meeting notes',
            '',
            '## Agenda',
            '- intro',
            '- budget',
            '',
            '## Actions',
            '- [ ] send recap',
        );
        const laptop = lines(
            '# Meeting notes',
            '',
            '## Agenda',
            '- intro',
            '- budget',
            '- hiring',
            '',
            '## Actions',
            '- [ ] send recap',
        );
        const phone = lines(
            '# Meeting notes',
            '',
            '## Agenda',
            '- intro',
            '- budget',
            '',
            '## Actions',
            '- [x] send recap',
        );
        assert.equal(
            mergedText(base, laptop, phone),
            lines(
                '# Meeting notes',
                '',
                '## Agenda',
                '- intro',
                '- budget',
                '- hiring',
                '',
                '## Actions',
                '- [x] send recap',
            ),
        );
    });
});
