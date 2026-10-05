import type { LogLevel } from './util/logger';
import type { ConflictPolicy } from './sync/types';

export type PluginSettings = {
    /** Node uid of the Drive folder the vault maps onto. Unset until chosen. */
    remoteFolderUid: string | null;
    /** Human-readable path of that folder, for display only. */
    remoteFolderPath: string | null;

    conflictPolicy: ConflictPolicy;
    /** Keeps the losing side as a sibling file under `prefer-*` policies too. */
    keepConflictCopies: boolean;

    /**
     * Everything held: no passes, no polling, no watching. Changes made in the
     * meantime are found by the full sync that runs on resume. Persisted, so a
     * pause survives a restart.
     */
    paused: boolean;
    /** Watch the vault and sync changes as they happen. */
    autoSync: boolean;
    /** Run a full reconciliation when the plugin loads. */
    syncOnStartup: boolean;
    /** Quiet period after the last edit to a file before it is uploaded. */
    uploadDebounceMs: number;
    /**
     * How often to ask Drive for events, in seconds.
     *
     * Proton's guidelines ask clients to sync from events rather than poll, and
     * the SDK's own scheduler uses 30s for the user's own volume. Going lower
     * risks the account being rate-limited; the setting exists so the interval
     * can be raised, not so it can be dropped.
     */
    remotePollSeconds: number;
    /** Parallel uploads/downloads. Kept low to stay within Drive's limits. */
    transferConcurrency: number;

    /** Skip files larger than this, in either direction. 0 disables the limit. */
    maxFileSizeMb: number;
    /**
     * On phones and tablets only: files larger than this are left where they
     * are, to be synced by a desktop device. 0 disables the limit.
     */
    mobileMaxFileSizeMb: number;
    /**
     * On phones and tablets only: hold the sync while on a cellular
     * connection. Only Android reports the connection type; elsewhere this has
     * no effect.
     */
    wifiOnly: boolean;
    /** Glob patterns, matched against vault-relative paths. */
    excludePatterns: string[];
    /** Sync `.obsidian/` — appearance, plugins, hotkeys — alongside the notes. */
    syncObsidianConfig: boolean;

    /** Names the device in conflict copies and in the sync log. */
    deviceName: string;
    logLevel: LogLevel;

    /** Set once the first-run setup has been shown, so it never reappears. */
    onboardingComplete: boolean;

    /**
     * With a PIN: minutes without using Obsidian before the PIN is asked for
     * again. 0 asks only when Obsidian opens. With a time limit, reopening
     * Obsidian within it does not ask either; see `RememberedUnlock`.
     */
    pinLockAfterMinutes: number;
};

/**
 * Files that should never leave the device, regardless of user configuration.
 *
 * Editor scratch files and OS droppings. The config-folder exclusions depend
 * on where the vault keeps its config, so they are built by
 * {@link configExclusions}.
 */
export const ALWAYS_EXCLUDED = [
    '.trash/**',
    '.git/**',
    '.DS_Store',
    '**/.DS_Store',
    'Thumbs.db',
    '**/*.tmp',
    '**/~$*',
];

/**
 * Files inside the config folder that stay on the device even when the rest of
 * it is synced.
 *
 * `workspace.json` and friends record which panes are open and where; syncing
 * them makes two devices fight over each other's layout on every focus change.
 *
 * This plugin's whole folder stays local too. Its data files are per-device by
 * nature: the sync state is this device's merge base and `data.json` carries
 * its device name. Its code gains nothing from syncing either, since a device
 * has to have the plugin installed before it can sync at all; syncing it only
 * meant one device's version replacing another's while it ran, a downgrade as
 * often as an upgrade. Each device updates it through Obsidian instead.
 */
export function configExclusions(configDir: string, pluginDir: string | null): string[] {
    const patterns = [
        `${configDir}/workspace.json`,
        `${configDir}/workspace-mobile.json`,
        `${configDir}/workspace`,
        `${configDir}/cache`,
    ];
    if (pluginDir) {
        patterns.push(`${pluginDir}/`);
    }
    return patterns;
}

export const DEFAULT_SETTINGS: PluginSettings = {
    remoteFolderUid: null,
    remoteFolderPath: null,

    conflictPolicy: 'keep-both',
    keepConflictCopies: true,

    paused: false,
    autoSync: true,
    syncOnStartup: true,
    uploadDebounceMs: 2000,
    remotePollSeconds: 30,
    transferConcurrency: 3,

    maxFileSizeMb: 0,
    mobileMaxFileSizeMb: 0,
    wifiOnly: false,
    excludePatterns: [],
    syncObsidianConfig: true,

    deviceName: '',
    logLevel: 'info',

    onboardingComplete: false,

    pinLockAfterMinutes: 0,
};

/**
 * Lower bound on the poll interval: the rate Proton's own SDK polls a user's
 * Drive at. Faster would only invite rate limiting.
 */
export const MIN_POLL_SECONDS = 30;
