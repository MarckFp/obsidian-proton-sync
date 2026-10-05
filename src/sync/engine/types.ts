import type { ConflictReason } from '../types';

/**
 * The engine's public types: what it reports, what it needs from the device,
 * and the hooks it calls. Re-exported from `../engine`, so callers keep
 * importing from there.
 */

export type SyncStatus =
    | 'signed-out'
    | 'not-configured'
    | 'idle'
    | 'syncing'
    | 'offline'
    | 'error'
    | 'paused'
    /** Held by the "Wi-Fi only" setting while on a cellular connection. */
    | 'waiting-for-wifi'
    /** The stored sign-in is protected with a PIN that has not been entered yet. Set by the plugin, not the engine. */
    | 'locked';

/** A transfer big enough to be worth showing progress for. */
export type TransferProgress = {
    path: string;
    direction: 'upload' | 'download';
    bytes: number;
    total: number;
};

export type SyncSummary = {
    status: SyncStatus;
    lastSyncedAt: number | null;
    lastError: string | null;
    conflicts: number;
    uploaded: number;
    downloaded: number;
    /** Requests sent to Proton in the last hour, which is what its rate limits count. */
    requestsLastHour: number;
    /** Paths not in sync right now, for whatever reason; see {@link SyncEngine.pendingChanges}. */
    pending: number;
    /**
     * How far the current pass is, from 0 to 1, or null when there is nothing
     * to measure yet (listing Drive and the vault): the panel then shows a bar
     * that only says work is under way.
     */
    progressFraction: number | null;
    /** Files checked so far in the current pass, when it covers more than one. */
    progress: { done: number; total: number } | null;
    /** The largest transfer in flight, if any is large enough to report. */
    transfer: TransferProgress | null;
};

/** Why a path is not in sync right now. */
export type PendingReason =
    | 'transferring'
    | 'waiting'
    | 'wifi'
    | 'retrying'
    | 'too-large'
    | 'name-clash'
    | 'conflict';

export type PendingChange = { path: string; reason: PendingReason; detail?: string };

/** One version of a note in Drive's revision history. */
export type NoteVersion = {
    uid: string;
    /** When Drive received it, epoch ms. */
    created: number;
    size?: number;
    /** The version Drive currently serves. */
    active: boolean;
};


/** A file of the vault in Drive's trash, for the panel's "Recently deleted" list. */
export type DeletedItem = {
    uid: string;
    /** Where it was in the vault. */
    path: string;
    /** When it was trashed, epoch ms. */
    deleted: number;
    size?: number;
    /**
     * What to restore to bring it back, outermost first: itself, after any
     * trashed folders it was in, since each was trashed on its own.
     */
    restoreUids: string[];
    /** The vault path of that folder, when restoring brings a folder back too. */
    withFolder?: string;
    /** A trashed folder listed for itself, because none of the files in it are listed on their own. */
    isFolder?: boolean;
};

/** One note's standing, for the current-note indicator. */
export type NoteSyncState = 'synced' | 'pending' | 'excluded';

/** What a first sync would do, worked out without touching either side. */
export type SyncPlan = {
    localFiles: number;
    /** Local files outside the config folder: zero for a vault that has only just been created. */
    localNotes: number;
    remoteFiles: number;
    uploads: string[];
    downloads: string[];
    /** On both sides with different content: handled by the conflict policy. */
    conflicts: string[];
    /**
     * Obsidian settings files Drive's copy will replace. Kept apart from
     * `conflicts` because the conflict policy never applies to them: when a
     * device joins, Drive's settings win.
     */
    settings: string[];
    /** Removals, which a first sync never makes; listed only if state was not empty. */
    removals: string[];
    /** Over a size limit, so left where they are. */
    held: string[];
    unchanged: number;
};

/**
 * A note open in an editor, as the engine needs it: its text as shown, which
 * may hold typing not yet saved, and a way to change it in place.
 */
export type OpenEditor = {
    text(): string;
    /** Replace the text, as a minimal edit so the cursor and scroll position stay put. */
    replace(text: string): void;
};

/** What the engine needs to know about the device it runs on. */
export type EngineEnvironment = {
    isMobile: boolean;
    /**
     * Whether the vault's filesystem treats names differing only in letter
     * case as one (Windows, macOS, iOS, usually Android). Probed from the vault
     * when not given.
     */
    caseInsensitive?: boolean;
    /** Whether the connection is known to be cellular. */
    isMetered: () => boolean;
    /** Whether Obsidian's window is hidden, minimised or in the background; Drive is then checked less often. */
    isHidden?: () => boolean;
    /** The editor showing a note, if one is open; see {@link SyncEngine.downloadIntoEditor}. */
    openEditor?: (path: string) => OpenEditor | null;
};

export const DESKTOP: EngineEnvironment = { isMobile: false, isMetered: () => false };

/** How a conflict ended, for telling the user about it. */
export type ConflictOutcome =
    | 'kept-both'
    | 'merged'
    | 'kept-local'
    | 'kept-remote'
    | 'deferred'
    /** A name clash settled by renaming the other file on Drive; `copyPath` is its new name. */
    | 'renamed'
    /** Left alone, not synced until one of the two is renamed. */
    | 'not-synced';

export type ConflictEvent = {
    path: string;
    reason: ConflictReason;
    outcome: ConflictOutcome;
    /** Where the other version was saved, when both were kept. */
    copyPath?: string;
};

export type EngineHooks = {
    onChange: (summary: SyncSummary) => void;
    onConflict: (event: ConflictEvent) => void;
    /**
     * A first sync replaced this device's Obsidian settings with the ones on
     * Drive. Obsidian only reads them at startup, so it needs a reload.
     */
    onSettingsAdopted?: (paths: string[]) => void;
};

/** Where this vault keeps things the path filter needs to know about. */
export type VaultScope = {
    configDir: string;
    /** This plugin's own folder, which never syncs. */
    pluginDir: string | null;
    /** This plugin's id, which must stay in the list of enabled plugins; see {@link SyncEngine.keepSelfEnabled}. */
    pluginId?: string;
};
