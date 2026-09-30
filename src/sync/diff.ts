import { longestCommonSubsequence, MAX_DIFF_LINES, splitLines } from './merge';

/**
 * Line diff for showing two versions of a note side by side in one column,
 * the way a code review shows a change: lines only in the old version marked
 * `-`, lines only in the new one marked `+`, the rest as context.
 *
 * Built on the same longest-common-subsequence as the three-way merge, and
 * bounded the same way, so a pathological pair of files is declined rather
 * than freezing the app.
 */

export type DiffLine =
    | { type: 'context'; text: string; oldNo: number; newNo: number }
    | { type: 'removed'; text: string; oldNo: number }
    | { type: 'added'; text: string; newNo: number };

export type DiffResult =
    | { ok: true; lines: DiffLine[]; added: number; removed: number }
    | { ok: false; reason: 'too-large' | 'binary' };

export function diffLines(oldText: string, newText: string): DiffResult {
    if (oldText.includes('\0') || newText.includes('\0')) {
        return { ok: false, reason: 'binary' };
    }
    const a = oldText === '' ? [] : splitLines(oldText);
    const b = newText === '' ? [] : splitLines(newText);

    let prefix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
        prefix++;
    }
    let suffix = 0;
    while (
        suffix < a.length - prefix &&
        suffix < b.length - prefix &&
        a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
    ) {
        suffix++;
    }

    const aMiddle = a.slice(prefix, a.length - suffix);
    const bMiddle = b.slice(prefix, b.length - suffix);
    if (aMiddle.length > MAX_DIFF_LINES || bMiddle.length > MAX_DIFF_LINES) {
        return { ok: false, reason: 'too-large' };
    }

    const lines: DiffLine[] = [];
    let added = 0;
    let removed = 0;
    const context = (i: number, j: number) => lines.push({ type: 'context', text: a[i], oldNo: i + 1, newNo: j + 1 });

    for (let i = 0; i < prefix; i++) {
        context(i, i);
    }

    // Within each gap between matches, removals come before additions, so a
    // replaced line reads as "-old" then "+new", the pairing a reader expects.
    let i = 0;
    let j = 0;
    const flushGap = (untilI: number, untilJ: number) => {
        for (; i < untilI; i++) {
            lines.push({ type: 'removed', text: aMiddle[i], oldNo: prefix + i + 1 });
            removed++;
        }
        for (; j < untilJ; j++) {
            lines.push({ type: 'added', text: bMiddle[j], newNo: prefix + j + 1 });
            added++;
        }
    };
    for (const [matchI, matchJ] of longestCommonSubsequence(aMiddle, bMiddle)) {
        flushGap(matchI, matchJ);
        context(prefix + i, prefix + j);
        i++;
        j++;
    }
    flushGap(aMiddle.length, bMiddle.length);

    for (let k = 0; k < suffix; k++) {
        context(a.length - suffix + k, b.length - suffix + k);
    }

    return { ok: true, lines, added, removed };
}

export type DiffSegment =
    | { kind: 'hunk'; header: string; lines: DiffLine[] }
    /** Unchanged lines between hunks, collapsed until the reader asks for them. */
    | { kind: 'collapsed'; lines: DiffLine[] };

/**
 * Group a diff into hunks with `context` unchanged lines around each change,
 * and collapse the unchanged stretches between them.
 */
export function toSegments(lines: DiffLine[], context = 3): DiffSegment[] {
    const changed = lines.map((line) => line.type !== 'context');
    const keep = lines.map((_, index) => {
        for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) {
            if (changed[k]) {
                return true;
            }
        }
        return false;
    });

    const segments: DiffSegment[] = [];
    let index = 0;
    while (index < lines.length) {
        const start = index;
        const visible = keep[index];
        while (index < lines.length && keep[index] === visible) {
            index++;
        }
        const run = lines.slice(start, index);
        segments.push(visible ? { kind: 'hunk', header: hunkHeader(run), lines: run } : { kind: 'collapsed', lines: run });
    }
    return segments;
}

/** `@@ -oldStart,oldCount +newStart,newCount @@`, as in a unified diff. */
function hunkHeader(lines: DiffLine[]): string {
    const oldNos = lines.flatMap((line) => (line.type === 'added' ? [] : [line.oldNo]));
    const newNos = lines.flatMap((line) => (line.type === 'removed' ? [] : [line.newNo]));
    const range = (nos: number[], fallback: number) => `${nos[0] ?? fallback},${nos.length}`;
    const before = lines.find((line) => line.type !== 'added');
    const after = lines.find((line) => line.type !== 'removed');
    return (
        `@@ -${range(oldNos, before && 'oldNo' in before ? before.oldNo : 0)} ` +
        `+${range(newNos, after && 'newNo' in after ? after.newNo : 0)} @@`
    );
}

/**
 * The part of a changed line that actually differs from its counterpart, as
 * `[start, end)` offsets into each: everything outside is a shared prefix or
 * suffix. Lets a one-word edit in a long paragraph stand out.
 */
export function changedRange(oldLine: string, newLine: string): { old: [number, number]; new: [number, number] } {
    let start = 0;
    while (start < oldLine.length && start < newLine.length && oldLine[start] === newLine[start]) {
        start++;
    }
    let end = 0;
    while (
        end < oldLine.length - start &&
        end < newLine.length - start &&
        oldLine[oldLine.length - 1 - end] === newLine[newLine.length - 1 - end]
    ) {
        end++;
    }
    return { old: [start, oldLine.length - end], new: [start, newLine.length - end] };
}
