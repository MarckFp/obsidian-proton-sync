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
};

export type PluginChange = {
    id: string;
    name: string;
    kind: 'added' | 'changed' | 'removed';
    /** What changed, for a `changed` entry: the version, the code, or both. */
    detail: string;
};

export type PluginWatchReport = {
    at: number;
    /** True on the first run, when there is nothing to compare against yet. */
    baseline: boolean;
    changes: PluginChange[];
    plugins: PluginFingerprint[];
};

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
        if (dir) {
            const path = `${dir}/main.js`;
            try {
                const bytes = await app.vault.adapter.readBinary(path);
                size = bytes.byteLength;
                digestValue = await digest(bytes);
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
    // Always rewrite: a plugin whose code could not be read once should be
    // reported when it becomes readable, and vice versa.
    await saveBaseline(app, folder, plugins);
    return { at: Date.now(), baseline: before === null, changes, plugins };
}
