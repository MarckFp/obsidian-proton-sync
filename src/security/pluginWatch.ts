import type { App } from 'obsidian';

/**
 * A fingerprint of every plugin installed in this vault.
 *
 * Nothing here can stop a hostile plugin — it runs in the same process, so it
 * could edit this record as easily as anything else. What it does do is make
 * the ordinary case loud: a plugin you installed once updates itself, or a new
 * one appears, and the next start says so instead of it happening in silence.
 * Every plugin in a vault can read the vault and this plugin's sign-in, so a
 * change to that set is a security event, not a preference.
 *
 * `main.js` is hashed rather than only its version, because a plugin's version
 * is a string it writes about itself.
 */
export type PluginFingerprint = {
    id: string;
    name: string;
    version: string;
    author: string;
    /** sha-256 of `main.js`, or null when it could not be read (no folder, unreadable). */
    digest: string | null;
    size: number;
    /**
     * Which credential-facing APIs the bundle mentions, e.g. `safeStorage`.
     *
     * Kept so an update that starts reaching for other plugins' objects can be
     * told apart from an update that fixes a typo. Names only; nothing is run.
     */
    touches: string[];
};

export type PluginChange = {
    id: string;
    name: string;
    kind: 'added' | 'changed' | 'removed';
    /** What changed, for a `changed` entry: the version, the code, or both. */
    detail: string;
};

/**
 * Something Obsidian's own update notice would not tell you.
 *
 * A plugin updating is announced by Obsidian, with a changelog, so repeating it
 * is noise. Two things are not announced:
 *
 * - the same version with different code, which an update never produces;
 * - an update whose new code starts reaching for credential APIs it did not
 *   mention before, which is what "this plugin can now read the sign-in" looks
 *   like from the outside.
 */
export type PluginAlert = {
    id: string;
    name: string;
    version: string;
    reason: 'unannounced-code' | 'new-capability';
    /** One line, in the words this plugin can defend. */
    why: string;
};

export type PluginWatchReport = {
    at: number;
    /** True on the first run, when there is nothing to compare against yet. */
    baseline: boolean;
    changes: PluginChange[];
    alerts: PluginAlert[];
    plugins: PluginFingerprint[];
};

/**
 * The APIs worth noticing when a bundle starts mentioning them.
 *
 * `secretStorage` is deliberately absent: Obsidian recommends it for a plugin's
 * own API keys, so a plugin adopting it is not a security event, and warning
 * about it made this alarm untrustworthy. What is left either reaches for other
 * plugins' objects, or names this plugin.
 */
const CAPABILITY_WORDS = ['safeStorage', 'plugins.plugins', 'proton-drive-sync'] as const;

export function capabilitiesIn(bundle: string): string[] {
    return CAPABILITY_WORDS.filter((word) => bundle.includes(word));
}

const BASELINE_FILE = 'plugin-baseline.json';

function text(value: unknown, fallback: string): string {
    return typeof value === 'string' && value.length > 0 ? value : fallback;
}

async function digest(bytes: ArrayBuffer): Promise<string> {
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** What is installed right now, this plugin excluded. */
export async function fingerprintPlugins(app: App, selfId: string): Promise<PluginFingerprint[]> {
    const out: PluginFingerprint[] = [];
    // `app.plugins` is Obsidian's plugin manager: not in the public typings, but
    // the same object every plugin uses, and the only place the set is listed.
    const manager = (app as unknown as { plugins?: { manifests?: Record<string, Record<string, unknown>> } }).plugins;
    const manifests = manager?.manifests ?? {};
    for (const [id, manifest] of Object.entries(manifests)) {
        if (id === selfId) {
            continue;
        }
        const dir = typeof manifest.dir === 'string' ? manifest.dir : null;
        let digestValue: string | null = null;
        let size = 0;
        let touches: string[] = [];
        if (dir) {
            const path = `${dir}/main.js`;
            try {
                const bytes = await app.vault.adapter.readBinary(path);
                size = bytes.byteLength;
                digestValue = await digest(bytes);
                touches = capabilitiesIn(new TextDecoder().decode(bytes));
            } catch {
                // A plugin whose code cannot be read is worth noticing, but not
                // worth failing the whole scan over.
                digestValue = null;
            }
        }
        out.push({
            id,
            name: text(manifest.name, id),
            version: text(manifest.version, '?'),
            author: text(manifest.author, '?'),
            digest: digestValue,
            size,
            touches,
        });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function diffPlugins(before: PluginFingerprint[], after: PluginFingerprint[]): PluginChange[] {
    const previous = new Map(before.map((entry) => [entry.id, entry]));
    const current = new Map(after.map((entry) => [entry.id, entry]));
    const changes: PluginChange[] = [];

    for (const [id, entry] of current) {
        const was = previous.get(id);
        if (!was) {
            changes.push({ id, name: entry.name, kind: 'added', detail: `version ${entry.version}` });
            continue;
        }
        const versionChanged = was.version !== entry.version;
        const codeChanged = was.digest !== entry.digest;
        if (!versionChanged && !codeChanged) {
            continue;
        }
        const detail = [
            versionChanged ? `${was.version} → ${entry.version}` : null,
            codeChanged && was.digest && entry.digest ? 'code changed' : null,
            codeChanged && !was.digest ? 'code now readable' : null,
            codeChanged && !entry.digest ? 'code now unreadable' : null,
        ]
            .filter(Boolean)
            .join(', ');
        changes.push({ id, name: entry.name, kind: 'changed', detail: detail || 'changed' });
    }

    for (const [id, entry] of previous) {
        if (!current.has(id)) {
            changes.push({ id, name: entry.name, kind: 'removed', detail: `was ${entry.version}` });
        }
    }

    return changes.sort((a, b) => a.name.localeCompare(b.name));
}

/** The subset worth interrupting the user for; see {@link PluginAlert}. */
export function alertsFrom(before: PluginFingerprint[], after: PluginFingerprint[]): PluginAlert[] {
    const previous = new Map(before.map((entry) => [entry.id, entry]));
    const alerts: PluginAlert[] = [];
    for (const entry of after) {
        const was = previous.get(entry.id);
        if (!was || !entry.digest || !was.digest || entry.digest === was.digest) {
            continue;
        }
        if (was.version === entry.version) {
            alerts.push({
                id: entry.id,
                name: entry.name,
                version: entry.version,
                reason: 'unannounced-code',
                why: `same version ${entry.version}, different code — an update does not do that`,
            });
            continue;
        }
        const fresh = entry.touches.filter((word) => !was.touches.includes(word));
        if (fresh.length > 0) {
            alerts.push({
                id: entry.id,
                name: entry.name,
                version: entry.version,
                reason: 'new-capability',
                why: `${was.version} → ${entry.version} now mentions ${fresh.join(', ')}`,
            });
        }
    }
    return alerts.sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadBaseline(app: App, folder: string): Promise<PluginFingerprint[] | null> {
    const path = `${folder}/${BASELINE_FILE}`;
    try {
        if (!(await app.vault.adapter.exists(path))) {
            return null;
        }
        const parsed = JSON.parse(await app.vault.adapter.read(path)) as { plugins?: PluginFingerprint[] };
        return Array.isArray(parsed.plugins) ? parsed.plugins : null;
    } catch {
        return null;
    }
}

export async function saveBaseline(app: App, folder: string, plugins: PluginFingerprint[]): Promise<void> {
    const path = `${folder}/${BASELINE_FILE}`;
    await app.vault.adapter.write(path, JSON.stringify({ version: 1, plugins }, null, 2));
}

/** Compare what is installed with what was installed last time, then remember the new set. */
export async function watchPlugins(app: App, selfId: string, folder: string): Promise<PluginWatchReport> {
    const plugins = await fingerprintPlugins(app, selfId);
    const before = await loadBaseline(app, folder);
    const changes = before ? diffPlugins(before, plugins) : [];
    const alerts = before ? alertsFrom(before, plugins) : [];
    // Always rewrite: a plugin whose code could not be read once should be
    // reported when it becomes readable, and vice versa.
    await saveBaseline(app, folder, plugins);
    return { at: Date.now(), baseline: before === null, changes, alerts, plugins };
}
