import { ALWAYS_EXCLUDED, codeExclusions, configExclusions } from '../settings';

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

/**
 * Whether a name from Drive can be one segment of a vault path, on every
 * device the vault might sync to.
 *
 * Names on Drive are end-to-end encrypted, so Proton's servers cannot check
 * them, and the SDK only checks their length: anyone who can write to the
 * folder can give a file or folder any name at all. `..`, or a name with a
 * `/` in it, would make a path that leads out of the vault, or around the
 * exclusions that keep code out of a shared one. `\` separates segments on
 * Windows, which also drops a segment's trailing dots and spaces, so a name
 * made only of dots and spaces is no safer there; and Node refuses NUL in a
 * path. A name like these could not be written on every device anyway.
 */
export function isSafeName(name: string): boolean {
    return name !== '' && !/^[. ]+$/.test(name) && !/[/\\\0]/.test(name);
}

/**
 * Whether a vault path stays inside the vault once the operating system
 * resolves it: relative, and with no segment that is empty, `.` or `..`. On
 * Windows, where `\` separates segments too, a segment's trailing dots and
 * spaces are dropped, and `C:` names a drive, none made only of dots and
 * spaces, and no drive. The last check before anything touches the disk; see
 * {@link isSafeName} for where names from Drive are checked first.
 */
export function staysInVault(path: string, windows: boolean): boolean {
    if (path === '') {
        return true;
    }
    if (path.includes('\0') || (windows && /^[a-z]:/i.test(path))) {
        return false;
    }
    const outside = windows ? /^[. ]*$/ : /^\.{0,2}$/;
    return path.split(windows ? /[\\/]/ : '/').every((segment) => !outside.test(segment));
}

/**
 * A path as a case-insensitive filesystem, and Windows, would take it: letter
 * case folded, and each segment's trailing dots and spaces dropped, as Windows
 * drops them. There `.Obsidian/plugins./x` is the same folder as
 * `.obsidian/plugins/x`, so an exclusion that keeps code out must catch both;
 * see {@link PathFilter}.
 */
export function aliasKey(path: string): string {
    return path
        .split('/')
        .map((segment) => segment.replace(/[. ]+$/, '').toLowerCase())
        .join('/');
}

/** True when `path` is `folder` itself or anything below it. */
export function isWithin(path: string, folder: string): boolean {
    return folder === '' || path === folder || path.startsWith(`${folder}/`);
}

/** Re-root a path that sits within `fromFolder` under `toFolder` instead. */
export function replacePrefix(path: string, fromFolder: string, toFolder: string): string {
    return path === fromFolder ? toFolder : `${toFolder}${path.slice(fromFolder.length)}`;
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
    /**
     * The plugin's own exclusions: matched against {@link aliasKey}, so that
     * no other spelling of an excluded path, such as `.Obsidian/plugins` on a
     * filesystem that ignores letter case, gets past the ones that keep code
     * out of a shared vault.
     */
    private readonly builtIn: RegExp[];
    /** The user's own patterns, matched as written. */
    private readonly user: RegExp[];

    constructor(
        userPatterns: string[],
        syncObsidianConfig: boolean,
        private readonly configDir: string,
        pluginDir: string | null = null,
        /** The vault is shared with others: never sync config that runs code; see {@link codeExclusions}. */
        sharedWithOthers = false,
    ) {
        const patterns = [...ALWAYS_EXCLUDED, ...configExclusions(configDir, pluginDir)];
        if (!syncObsidianConfig) {
            patterns.push(`${configDir}/**`, configDir);
        }
        if (sharedWithOthers) {
            patterns.push(...codeExclusions(configDir));
        }
        this.builtIn = patterns.map((pattern) => globToRegExp(aliasKey(pattern)));
        this.user = userPatterns
            .map((p) => p.trim())
            .filter(Boolean)
            .map(globToRegExp);
    }

    /** Whether the path lives in the vault's config folder. */
    isConfigPath(path: string): boolean {
        return path === this.configDir || path.startsWith(`${this.configDir}/`);
    }

    isExcluded(path: string): boolean {
        const alias = aliasKey(path);
        return this.builtIn.some((matcher) => matcher.test(alias)) || this.user.some((matcher) => matcher.test(path));
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
        const char = normalized[i];
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

/**
 * `(conflict 2026-09-30 1412 from laptop)` as written by
 * {@link conflictCopyPath}, plus the ` 2`, ` 3`… that the engine adds when
 * that name is already taken. The device name may contain anything but a path
 * separator, parentheses included, so the match is anchored on the timestamp.
 */
const CONFLICT_SUFFIX = / \(conflict \d{4}-\d{2}-\d{2} \d{4}(?: from [^/]*)?\)(?: \d+)?$/;

/** The note a conflict copy was made from, or null when `path` is not a conflict copy. */
export function conflictCopyOriginal(path: string): string | null {
    const { stem, extension } = splitExtension(path);
    const match = CONFLICT_SUFFIX.exec(stem);
    if (!match || match.index === 0 || stem.lastIndexOf('/') >= match.index) {
        return null;
    }
    return `${stem.slice(0, match.index)}${extension}`;
}

/**
 * A reason the exclusion list will not do what it looks like it does, or
 * undefined when it is fine. Shown under the setting as the user types.
 */
export function checkExcludePatterns(patterns: string[]): string | undefined {
    for (const raw of patterns) {
        const pattern = raw.trim();
        if (pattern === '') {
            continue;
        }
        if (pattern.includes('\\')) {
            return `"${pattern}": use / between folders, even on Windows.`;
        }
        if (pattern.startsWith('/')) {
            return `"${pattern}": patterns are relative to the vault, so drop the leading /.`;
        }
        if (pattern.startsWith('./')) {
            return `"${pattern}": patterns are relative to the vault already, so drop the ./.`;
        }
        if (/^\*+\/?$/.test(pattern) || pattern === '**/*') {
            return `"${pattern}" would exclude the whole vault.`;
        }
    }
    return undefined;
}
