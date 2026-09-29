import { ALWAYS_EXCLUDED } from '../settings';

/**
 * Path handling for the vault side of the sync.
 *
 * Vault paths are `/`-separated, relative to the vault root, with no leading
 * slash — the form Obsidian's `Vault` API uses everywhere. Keeping that the
 * only representation in the engine avoids a class of bug where a path
 * round-trips through the OS separator and stops matching its own sync record.
 */

export function parentPath(path: string): string {
    const index = path.lastIndexOf('/');
    return index === -1 ? '' : path.slice(0, index);
}

export function basename(path: string): string {
    const index = path.lastIndexOf('/');
    return index === -1 ? path : path.slice(index + 1);
}

export function joinPath(parent: string, name: string): string {
    return parent === '' ? name : `${parent}/${name}`;
}

/** Every ancestor of a path, root first, excluding the path itself. */
export function ancestorPaths(path: string): string[] {
    const segments = path.split('/').slice(0, -1);
    const ancestors: string[] = [];
    let current = '';
    for (const segment of segments) {
        current = current === '' ? segment : `${current}/${segment}`;
        ancestors.push(current);
    }
    return ancestors;
}

export function splitExtension(path: string): { stem: string; extension: string } {
    const name = basename(path);
    const dot = name.lastIndexOf('.');
    if (dot <= 0) {
        return { stem: path, extension: '' };
    }
    return { stem: path.slice(0, path.length - (name.length - dot)), extension: name.slice(dot) };
}

/**
 * Decides which vault paths take part in the sync.
 *
 * Built once per settings change rather than per path, because the exclusion
 * list is consulted for every file in the vault on every full reconciliation.
 */
export class PathFilter {
    private readonly matchers: RegExp[];

    constructor(userPatterns: string[], syncObsidianConfig: boolean) {
        const patterns = [...ALWAYS_EXCLUDED, ...userPatterns.map((p) => p.trim()).filter(Boolean)];
        if (!syncObsidianConfig) {
            patterns.push('.obsidian/**', '.obsidian');
        }
        this.matchers = patterns.map(globToRegExp);
    }

    isExcluded(path: string): boolean {
        return this.matchers.some((matcher) => matcher.test(path));
    }

    /** True when the path itself, or any folder above it, is excluded. */
    isExcludedWithAncestors(path: string): boolean {
        if (this.isExcluded(path)) {
            return true;
        }
        return ancestorPaths(path).some((ancestor) => this.isExcluded(ancestor));
    }
}

/**
 * Translate a glob to a regular expression.
 *
 * Supports the subset users reach for in an ignore list: `*` within a segment,
 * `**` across segments, `?` for one character, and a trailing `/` to mean "this
 * folder and everything under it".
 */
function globToRegExp(pattern: string): RegExp {
    const normalized = pattern.endsWith('/') ? `${pattern}**` : pattern;
    let source = '';

    for (let i = 0; i < normalized.length; i++) {
        const char = normalized[i]!;
        if (char === '*') {
            if (normalized[i + 1] === '*') {
                // `a/**` should also match `a` itself, so the preceding
                // separator is folded into the optional group.
                if (source.endsWith('/')) {
                    source = `${source.slice(0, -1)}(?:/.*)?`;
                } else {
                    source += '.*';
                }
                i++;
                if (normalized[i + 1] === '/') {
                    i++;
                }
            } else {
                source += '[^/]*';
            }
            continue;
        }
        if (char === '?') {
            source += '[^/]';
            continue;
        }
        source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }

    return new RegExp(`^${source}$`);
}

/**
 * Name for the copy written when a conflict cannot be merged away.
 *
 * The device name and timestamp are in the filename because that is the only
 * place they survive: the file has to be recognisable months later, from any
 * device, without consulting the plugin's own state.
 */
export function conflictCopyPath(path: string, deviceName: string, when: Date): string {
    const { stem, extension } = splitExtension(path);
    const stamp = formatConflictTimestamp(when);
    const device = sanitiseForFilename(deviceName);
    const suffix = device ? `${stamp} from ${device}` : stamp;
    return `${stem} (conflict ${suffix})${extension}`;
}

function formatConflictTimestamp(when: Date): string {
    const pad = (value: number) => String(value).padStart(2, '0');
    return (
        `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ` +
        `${pad(when.getHours())}${pad(when.getMinutes())}`
    );
}

/** Strip characters that are illegal in a filename on Windows, macOS or Linux. */
function sanitiseForFilename(value: string): string {
    return value.replace(/[\\/:*?"<>|]/g, '-').trim();
}
