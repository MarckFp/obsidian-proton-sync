import type { LogLevel } from './util/logger';
import type { ConflictPolicy } from './sync/types';

export type PluginSettings = {
    /** Node uid of the Drive folder the vault maps onto. Unset until chosen. */
    remoteFolderUid: string | null;
    /** Human-readable path of that folder, for display only. */
    remoteFolderPath: string | null;
    /** Account the stored session belongs to; shown in settings, and used to
     *  detect that the session now belongs to someone else. */
    accountEmail: string | null;

    conflictPolicy: ConflictPolicy;
    /** Keeps the losing side as a sibling file under `prefer-*` policies too. */
    keepConflictCopies: boolean;

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

    /** Skip files larger than this. 0 disables the limit. */
    maxFileSizeMb: number;
    /** Glob patterns, matched against vault-relative paths. */
    excludePatterns: string[];
    /** Sync `.obsidian/` — appearance, plugins, hotkeys — alongside the notes. */
    syncObsidianConfig: boolean;

    /** Names the device in conflict copies and in the sync log. */
    deviceName: string;
    /**
     * Stable per-installation id, handed to the SDK.
     *
     * Drive marks an in-progress upload with the uid of the client that started
     * it. Keeping ours stable lets the SDK recognise a draft this installation
     * abandoned - after a crash, say - and clean it up on its own, instead of
     * stopping to ask whether another device's upload may be overwritten.
     */
    clientUid: string;
    logLevel: LogLevel;
};

/**
 * Files that should never leave the device, regardless of user configuration.
 *
 * `workspace.json` and friends record which panes are open and where; syncing
 * them makes two devices fight over each other's layout on every focus change.
 * The rest are editor scratch files and OS droppings.
 */
export const ALWAYS_EXCLUDED = [
    '.obsidian/workspace.json',
    '.obsidian/workspace-mobile.json',
    '.obsidian/workspace',
    '.obsidian/cache',
    '.trash/**',
    '.git/**',
    '.DS_Store',
    '**/.DS_Store',
    'Thumbs.db',
    '**/*.tmp',
    '**/~$*',
];

export const DEFAULT_SETTINGS: PluginSettings = {
    remoteFolderUid: null,
    remoteFolderPath: null,
    accountEmail: null,

    conflictPolicy: 'keep-both',
    keepConflictCopies: true,

    autoSync: true,
    syncOnStartup: true,
    uploadDebounceMs: 2000,
    remotePollSeconds: 30,
    transferConcurrency: 3,

    maxFileSizeMb: 0,
    excludePatterns: [],
    syncObsidianConfig: false,

    deviceName: '',
    clientUid: '',
    logLevel: 'info',
};

/** Lower bound on the poll interval, to keep the account out of rate limiting. */
export const MIN_POLL_SECONDS = 15;
