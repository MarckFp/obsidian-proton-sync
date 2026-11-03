import type { App } from 'obsidian';

/**
 * Who else can write to the places this plugin trusts.
 *
 * A vault on a share, or one created with a loose umask, can be writable by
 * other local users or processes. That matters more than any token: whoever can
 * write `.obsidian/plugins/proton-drive-sync/main.js` runs code in this process,
 * with the OS user's keyring — and `session.bin` next to it becomes readable.
 *
 * Desktop only: on mobile there is no `fs` and no other local user.
 */
export type PermissionFinding = {
    path: string;
    mode: string;
    /** What is wrong, in words a user can act on. */
    problem: string;
};

type Stats = { mode: number };

function statOf(path: string): Stats | null {
    try {
        const fs = (window as unknown as { require: (module: string) => { statSync: (p: string) => Stats } }).require('fs');
        return fs.statSync(path);
    } catch {
        return null;
    }
}

function describe(mode: number): string {
    return `0${(mode & 0o777).toString(8).padStart(3, '0')}`;
}

/**
 * Folders whose contents decide what runs, and the session file itself.
 * A world-writable vault is common on NAS shares; that is precisely why this
 * reports rather than throws, and why the settings decide what to do about it.
 */
export function checkPermissions(app: App, pluginDir: string): PermissionFinding[] {
    const findings: PermissionFinding[] = [];
    const base = (app.vault.adapter as unknown as { getBasePath?: () => string }).getBasePath?.();
    if (!base) {
        return findings;
    }
    // `pluginDir` is vault-relative; `fs` wants a real path.
    const absolute = (path: string): string => (path.startsWith('/') ? path : `${base}/${path}`);
    const targets: { path: string; what: string }[] = [
        { path: absolute(pluginDir), what: 'the plugin folder' },
        { path: absolute(`${pluginDir}/main.js`), what: 'this plugin\'s own code' },
        { path: absolute(`${pluginDir}/session.bin`), what: 'the stored sign-in' },
        { path: absolute('.obsidian'), what: 'the config folder' },
    ];
    for (const target of targets) {
        const stats = statOf(target.path);
        if (!stats) {
            continue;
        }
        const mode = stats.mode & 0o777;
        if (mode & 0o002) {
            findings.push({
                path: target.path,
                mode: describe(stats.mode),
                problem: `${target.what} is writable by anyone on this machine (${describe(stats.mode)})`,
            });
        } else if (mode & 0o020 && target.path.endsWith('session.bin')) {
            findings.push({
                path: target.path,
                mode: describe(stats.mode),
                problem: `${target.what} is writable by the file's group (${describe(stats.mode)})`,
            });
        } else if (mode & 0o004 && target.path.endsWith('session.bin')) {
            findings.push({
                path: target.path,
                mode: describe(stats.mode),
                problem: `${target.what} is readable by anyone on this machine (${describe(stats.mode)})`,
            });
        }
    }
    return findings;
}
