import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { changedRange, diffLines, toSegments, type DiffLine } from '../src/sync/diff';

function render(lines: DiffLine[]): string[] {
    return lines.map((line) => `${line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}${line.text}`);
}

describe('diffLines', () => {
    it('marks lines only in the old text with - and lines only in the new one with +', () => {
        const result = diffLines('a\nb\nc', 'a\nB\nc\nd');
        assert.ok(result.ok);
        assert.deepEqual(render(result.lines), [' a', '-b', '+B', ' c', '+d']);
        assert.equal(result.added, 2);
        assert.equal(result.removed, 1);
    });

    it('numbers lines on each side', () => {
        const result = diffLines('one\ntwo', 'zero\none\ntwo');
        assert.ok(result.ok);
        assert.deepEqual(result.lines[0], { type: 'added', text: 'zero', newNo: 1 });
        assert.deepEqual(result.lines[1], { type: 'context', text: 'one', oldNo: 1, newNo: 2 });
    });

    it('treats a missing side as empty', () => {
        const result = diffLines('', 'new note');
        assert.ok(result.ok);
        assert.deepEqual(render(result.lines), ['+new note']);
    });

    it('reports identical texts as no change', () => {
        const result = diffLines('same\ntext', 'same\ntext');
        assert.ok(result.ok);
        assert.equal(result.added + result.removed, 0);
    });

    it('declines binary content', () => {
        assert.deepEqual(diffLines('a\0b', 'a'), { ok: false, reason: 'binary' });
    });

    it('declines diffs too large to compute quickly', () => {
        const big = (seed: string) => Array.from({ length: 6000 }, (_, i) => `${seed}${i}`).join('\n');
        assert.deepEqual(diffLines(big('a'), big('b')), { ok: false, reason: 'too-large' });
    });
});

describe('toSegments', () => {
    it('keeps a few lines of context around each change and folds the rest', () => {
        const old = Array.from({ length: 20 }, (_, i) => `line ${i}`);
        const changed = [...old];
        changed[10] = 'edited';
        const result = diffLines(old.join('\n'), changed.join('\n'));
        assert.ok(result.ok);

        const segments = toSegments(result.lines, 3);
        assert.deepEqual(
            segments.map((segment) => [segment.kind, segment.lines.length]),
            [
                ['collapsed', 7],
                ['hunk', 8],
                ['collapsed', 6],
            ],
        );
        const hunk = segments[1];
        assert.equal(hunk.kind === 'hunk' && hunk.header, '@@ -8,7 +8,7 @@');
    });
});

describe('changedRange', () => {
    it('isolates the part of a line that differs', () => {
        const range = changedRange('The quick brown fox', 'The quick red fox');
        assert.deepEqual(range, { old: [10, 15], new: [10, 13] });
    });
});
