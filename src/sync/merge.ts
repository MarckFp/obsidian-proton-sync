/**
 * Line-level three-way merge, used by the `merge` conflict policy.
 *
 * When two devices edit different parts of the same note — the common shape of
 * a conflict after one of them has been offline — there is a correct answer
 * that keeps both edits, and producing it beats handing the user two files to
 * diff by hand. When the edits genuinely overlap there is no correct answer,
 * and this returns nothing so the caller can fall back to keeping both copies.
 *
 * Deliberately conservative: adjacent edits are treated as overlapping rather
 * than interleaved, and anything too large to diff cheaply is declined. A
 * refused merge costs the user a conflict file; a wrong merge costs them text
 * they never agreed to.
 */

/** Above this many differing lines, decline rather than run an O(n·m) diff. */
const MAX_DIFF_LINES = 5000;

export type MergeResult =
    | { merged: true; text: string }
    | { merged: false; reason: 'overlapping-edits' | 'too-large' | 'binary' };

type Region = { baseStart: number; baseEnd: number; otherStart: number; otherEnd: number };

export function mergeThreeWay(baseText: string, localText: string, remoteText: string): MergeResult {
    if (hasNullByte(baseText) || hasNullByte(localText) || hasNullByte(remoteText)) {
        return { merged: false, reason: 'binary' };
    }

    const newline = detectNewline(localText, remoteText, baseText);
    const base = splitLines(baseText);
    const local = splitLines(localText);
    const remote = splitLines(remoteText);

    const localRegions = diffRegions(base, local);
    const remoteRegions = diffRegions(base, remote);
    if (localRegions === null || remoteRegions === null) {
        return { merged: false, reason: 'too-large' };
    }

    const output: string[] = [];
    let baseCursor = 0;

    for (const span of mergeSpans(localRegions, remoteRegions)) {
        // Everything between the previous span and this one is untouched on
        // both sides and passes through verbatim.
        output.push(...base.slice(baseCursor, span.baseStart));

        const baseSlice = base.slice(span.baseStart, span.baseEnd);
        const localSlice = local.slice(
            project(localRegions, span.baseStart, 'start'),
            project(localRegions, span.baseEnd, 'end'),
        );
        const remoteSlice = remote.slice(
            project(remoteRegions, span.baseStart, 'start'),
            project(remoteRegions, span.baseEnd, 'end'),
        );

        if (!span.touchedByLocal) {
            output.push(...remoteSlice);
        } else if (!span.touchedByRemote) {
            output.push(...localSlice);
        } else if (sameLines(localSlice, remoteSlice)) {
            output.push(...localSlice);
        } else if (sameLines(localSlice, baseSlice)) {
            output.push(...remoteSlice);
        } else if (sameLines(remoteSlice, baseSlice)) {
            output.push(...localSlice);
        } else {
            return { merged: false, reason: 'overlapping-edits' };
        }

        baseCursor = span.baseEnd;
    }

    output.push(...base.slice(baseCursor));
    return { merged: true, text: output.join(newline) };
}

type Span = { baseStart: number; baseEnd: number; touchedByLocal: boolean; touchedByRemote: boolean };

/**
 * Collapse both sides' change regions into a single ordered set of spans over
 * the base, recording which sides touched each.
 *
 * Regions that merely touch — one ending exactly where the other begins — stay
 * separate, because base order already says which comes first. The one case
 * with no such answer is two insertions at the very same point, where either
 * ordering is a guess; those are merged so they surface as a conflict rather
 * than as a silently chosen interleaving.
 */
function mergeSpans(localRegions: Region[], remoteRegions: Region[]): Span[] {
    const tagged = [
        ...localRegions.map((region) => ({ region, fromLocal: true })),
        ...remoteRegions.map((region) => ({ region, fromLocal: false })),
    ].sort((a, b) => a.region.baseStart - b.region.baseStart || a.region.baseEnd - b.region.baseEnd);

    const spans: Span[] = [];
    for (const { region, fromLocal } of tagged) {
        const current = spans[spans.length - 1];
        if (current && overlaps(region, current)) {
            current.baseEnd = Math.max(current.baseEnd, region.baseEnd);
            current.touchedByLocal ||= fromLocal;
            current.touchedByRemote ||= !fromLocal;
            continue;
        }
        spans.push({
            baseStart: region.baseStart,
            baseEnd: region.baseEnd,
            touchedByLocal: fromLocal,
            touchedByRemote: !fromLocal,
        });
    }
    return spans;
}

function overlaps(region: Region, span: Span): boolean {
    if (region.baseStart < span.baseEnd) {
        return true;
    }
    // Two pure insertions at the same base position: no order is derivable.
    return region.baseStart === region.baseEnd && span.baseStart === span.baseEnd
        ? region.baseStart === span.baseStart
        : false;
}

/**
 * Translate a base line index into the corresponding index on one side, by
 * accumulating how much every earlier change region grew or shrank it.
 *
 * The edge matters for insertions, which occupy no base lines: a region
 * inserted exactly at `baseIndex` sits after a span that starts there and
 * before the end of a span that finishes there. Getting this wrong silently
 * drops appended text, since the projected slice collapses to nothing.
 *
 * Span boundaries never fall strictly inside a region, because `mergeSpans`
 * merges anything that overlaps or touches.
 */
function project(regions: Region[], baseIndex: number, edge: 'start' | 'end'): number {
    let shift = 0;
    for (const region of regions) {
        if (region.baseEnd > baseIndex) {
            break;
        }
        if (edge === 'start' && region.baseStart === baseIndex) {
            continue;
        }
        shift += region.otherEnd - region.otherStart - (region.baseEnd - region.baseStart);
    }
    return baseIndex + shift;
}

/**
 * The stretches of `base` that `other` replaced, derived from their longest
 * common subsequence. Returns null when the differing portion is too large to
 * diff without a noticeable stall.
 */
function diffRegions(base: string[], other: string[]): Region[] | null {
    let prefix = 0;
    while (prefix < base.length && prefix < other.length && base[prefix] === other[prefix]) {
        prefix++;
    }

    let suffix = 0;
    while (
        suffix < base.length - prefix &&
        suffix < other.length - prefix &&
        base[base.length - 1 - suffix] === other[other.length - 1 - suffix]
    ) {
        suffix++;
    }

    const baseMiddle = base.slice(prefix, base.length - suffix);
    const otherMiddle = other.slice(prefix, other.length - suffix);

    if (baseMiddle.length === 0 && otherMiddle.length === 0) {
        return [];
    }
    if (baseMiddle.length > MAX_DIFF_LINES || otherMiddle.length > MAX_DIFF_LINES) {
        return null;
    }

    const matches = longestCommonSubsequence(baseMiddle, otherMiddle);

    const regions: Region[] = [];
    let baseCursor = 0;
    let otherCursor = 0;
    for (const [baseIndex, otherIndex] of matches) {
        if (baseIndex > baseCursor || otherIndex > otherCursor) {
            regions.push({
                baseStart: prefix + baseCursor,
                baseEnd: prefix + baseIndex,
                otherStart: prefix + otherCursor,
                otherEnd: prefix + otherIndex,
            });
        }
        baseCursor = baseIndex + 1;
        otherCursor = otherIndex + 1;
    }
    if (baseCursor < baseMiddle.length || otherCursor < otherMiddle.length) {
        regions.push({
            baseStart: prefix + baseCursor,
            baseEnd: prefix + baseMiddle.length,
            otherStart: prefix + otherCursor,
            otherEnd: prefix + otherMiddle.length,
        });
    }
    return regions;
}

/** Matched index pairs, ascending. Standard quadratic LCS, bounded by the caller. */
function longestCommonSubsequence(a: string[], b: string[]): [number, number][] {
    const width = b.length + 1;
    const lengths = new Uint32Array((a.length + 1) * width);

    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            lengths[i * width + j] =
                a[i] === b[j]
                    ? lengths[(i + 1) * width + j + 1]! + 1
                    : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!);
        }
    }

    const pairs: [number, number][] = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            pairs.push([i, j]);
            i++;
            j++;
        } else if (lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!) {
            i++;
        } else {
            j++;
        }
    }
    return pairs;
}

function sameLines(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((line, index) => line === b[index]);
}

function splitLines(text: string): string[] {
    return text.split(/\r\n|\n|\r/);
}

/** Preserve the line ending the edited copies use, preferring the local one. */
function detectNewline(...texts: string[]): string {
    for (const text of texts) {
        if (text.includes('\r\n')) {
            return '\r\n';
        }
        if (text.includes('\n')) {
            return '\n';
        }
    }
    return '\n';
}

function hasNullByte(text: string): boolean {
    return text.includes('\0');
}
