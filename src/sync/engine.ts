import {
    DriveEventType,
    NodeType,
    NodeWithSameNameExistsValidationError,
    type NodeEntity,
    type ProtonDriveClient,
} from '@protontech/drive-sdk';
import type { App } from 'obsidian';

import { MIN_POLL_SECONDS, type PluginSettings } from '../settings';
import { PathBatcher } from '../util/debounce';
import type { Logger } from '../util/logger';
import { Limiter, runPooled } from '../util/pool';
import { ConflictResolver } from './conflicts';
import { DriveIO, type NodeLocation, type RemoteTree, type UploadSource } from './drive';
import { basename, conflictCopyPath, isWithin, PathFilter, parentPath, replacePrefix, splitExtension } from './paths';
import { reconcile } from './reconcile';
import type { SyncState } from './state';
import type { ConflictPolicy, ConflictReason, LocalState, RemoteState, SyncAction, SyncBase } from './types';
import { LARGE_FILE_BYTES, VaultIO } from './vault';

export type SyncStatus =
    | 'signed-out'
    | 'not-configured'
    | 'idle'
    | 'syncing'
    | 'offline'
    | 'error'
    | 'paused'
    /** Held by the "Wi-Fi only" setting while on a cellular connection. */
    | 'waiting-for-wifi';

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
    /** Files handled so far in the current pass, when it covers more than one. */
    progress: { done: number; total: number } | null;
    /** The largest transfer in flight, if any is large enough to report. */
    transfer: TransferProgress | null;
};

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

/** What the engine needs to know about the device it runs on. */
export type EngineEnvironment = {
    isMobile: boolean;
    /** Whether the connection is known to be cellular. */
    isMetered: () => boolean;
};

const DESKTOP: EngineEnvironment = { isMobile: false, isMetered: () => false };

/** How a conflict ended, for telling the user about it. */
export type ConflictOutcome = 'kept-both' | 'merged' | 'kept-local' | 'kept-remote' | 'deferred';

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

type PendingRename = { from: string; to: string; isFolder: boolean };

/** One node event from Drive, reduced to what is needed to place it. */
type NodeChange = { nodeUid: string; parentNodeUid: string | undefined };

/** What one pass knows about the Drive side of the paths it is reconciling. */
type RemoteView = {
    /** Paths to reconcile. Differs from the paths asked about when a file turned out to have moved. */
    paths: Set<string>;
    states: Map<string, RemoteState | undefined>;
    /**
     * Paths whose Drive side could not be established, left alone until it
     * can. Absence is never inferred from a failed lookup: a file missing from
     * Drive is deleted from the vault, so "missing" has to be a fact.
     */
    skip: Set<string>;
};

/** How long a continuously-edited file may hold up everything else. */
const MAX_BATCH_WAIT_MS = 15_000;

/**
 * Files checked at once in a pass. Checking is local work, a stat and at most
 * a hash, so it runs well above the transfer limit: a full sync of a large
 * vault is mostly files that turn out unchanged, and they should not queue
 * behind the few that need an upload.
 */
const SCAN_CONCURRENCY = 8;

/** Transfers smaller than this finish too fast for progress to mean anything. */
const PROGRESS_MIN_BYTES = 1024 * 1024;

/** Progress updates are coalesced to at most one per this interval. */
const CHANGE_THROTTLE_MS = 250;

/** Transferred first, so a first sync is usable long before the attachments arrive. */
const NOTE_EXTENSIONS = new Set(['.md', '.canvas', '.base', '.txt']);

/**
 * Drives the sync: watches both sides, decides what each change means through
 * `reconcile`, and carries out the result.
 *
 * Two loops feed it. Local edits arrive as vault events and are batched, so a
 * burst of autosaves becomes one upload. Remote changes arrive as Drive events,
 * polled on a timer - the Drive API offers no push channel, so a remote edit
 * becomes visible here one poll interval after it lands, not instantly.
 *
 * Everything funnels through a single queue: two overlapping passes over the
 * same path would race between deciding what to do and doing it.
 */
export class SyncEngine {
    private readonly vault: VaultIO;
    private readonly batcher: PathBatcher;

    private drive: DriveIO | null = null;
    private filter: PathFilter;
    private resolver: ConflictResolver | null = null;

    private rootUid: string | null = null;
    private treeEventScopeId: string | null = null;

    private running = false;
    private status: SyncStatus = 'signed-out';
    private lastSyncedAt: number | null = null;
    private lastError: string | null = null;
    private uploaded = 0;
    private downloaded = 0;
    private paused = false;
    /** A full sync was asked for while the network was held; it runs once it is not. */
    private deferredFullSync = false;
    private progress: { done: number; total: number } | null = null;
    private readonly transfers = new Map<symbol, TransferProgress>();
    private changeTimer: number | null = null;
    /** What {@link updateSettings} compares against to spot a change of scope. */
    private scopeKey: string;
    /**
     * Local states worked out by {@link plan}, reused by the first sync that
     * follows it while the files are unchanged, so nothing is hashed twice.
     */
    private readonly plannedLocal = new Map<string, LocalState>();
    /** Settings files downloaded by the first sync now running; null when this is not a first sync. */
    private adoptingSettings: string[] | null = null;
    /**
     * Set once a first sync has put Drive's settings in place. Until Obsidian
     * reloads, it still runs on the settings it started with, and would write
     * those back over the downloaded files at its next save; uploading them
     * would then replace the settings on Drive with a new vault's defaults. So
     * settings files only come down, never go up, for the rest of the session.
     */
    private settingsHeld = false;

    private queue: Promise<void> = Promise.resolve();
    private pollTimer: number | null = null;
    /** A poll is queued or running; only one at a time. */
    private polling = false;
    private abortController: AbortController | null = null;

    /** Renames seen in the current tick, applied together; see {@link onVaultRename}. */
    private pendingRenames: PendingRename[] = [];
    private renameTimer: number | null = null;
    /** Policies chosen for single files in the conflicts dialog; see {@link resolveConflict}. */
    private readonly policyOverrides = new Map<string, ConflictPolicy>();
    /** Folders deleted locally, whose Drive counterpart is removed once their files have been. */
    private readonly pendingFolderDeletes = new Set<string>();

    /**
     * Paths a remote-event pass could not settle - a lookup failed, or the
     * transfer did - retried with the next poll. The event cursor moves on
     * regardless, so without this they would wait for the next full sync.
     */
    private readonly retryPaths = new Set<string>();

    /**
     * Paths that differ from another path only in letter case, found by the
     * last full sync; see {@link findCaseCollisions}.
     */
    private caseCollisions = new Set<string>();

    /** Folder path to node uid, rebuilt on every full sync. */
    private readonly folderUids = new Map<string, string>();

    constructor(
        app: App,
        private readonly state: SyncState,
        private settings: PluginSettings,
        private readonly logger: Logger,
        private readonly hooks: EngineHooks,
        private readonly scope: VaultScope,
        private readonly environment: EngineEnvironment = DESKTOP,
    ) {
        this.vault = new VaultIO(app, logger.getLogger('vault'));
        this.filter = this.createFilter(settings);
        this.scopeKey = scopeKeyOf(settings);
        this.batcher = new PathBatcher(settings.uploadDebounceMs, MAX_BATCH_WAIT_MS, (paths) => {
            void this.enqueue(() => this.processPaths(new Set(paths)));
        });
    }

    getSummary(): SyncSummary {
        return {
            status: this.status,
            lastSyncedAt: this.lastSyncedAt,
            lastError: this.lastError,
            conflicts: this.state.conflicts().length,
            uploaded: this.uploaded,
            downloaded: this.downloaded,
            progress: this.progress ? { ...this.progress } : null,
            transfer: this.largestTransfer(),
        };
    }

    isPaused(): boolean {
        return this.paused;
    }

    /** Apply changed settings without a restart, resyncing if the scope changed. */
    updateSettings(settings: PluginSettings): void {
        // Compared against a snapshot, not the previous object: the plugin
        // mutates one settings object in place and hands the same one back.
        const scopeKey = scopeKeyOf(settings);
        const scopeChanged = scopeKey !== this.scopeKey;
        this.scopeKey = scopeKey;

        this.settings = settings;
        this.filter = this.createFilter(settings);
        this.batcher.setDelay(settings.uploadDebounceMs);
        this.resolver = this.drive ? this.createResolver(this.drive, settings.conflictPolicy) : null;

        if (this.running && scopeChanged && !this.paused) {
            void this.syncNow();
        }
    }

    async start(client: ProtonDriveClient, rootUid: string): Promise<void> {
        this.drive = new DriveIO(client, this.logger.getLogger('drive'));
        this.resolver = this.createResolver(this.drive, this.settings.conflictPolicy);
        this.rootUid = rootUid;
        this.running = true;
        this.paused = this.settings.paused;
        this.abortController = new AbortController();

        if (this.paused) {
            // Nothing runs until resume, which starts with a full sync and so
            // needs nothing primed here.
            this.setStatus('paused');
            return;
        }
        if (this.settings.syncOnStartup) {
            await this.syncNow();
        } else {
            // The event scope is only known once the root node has been read,
            // and without it there is nothing to poll.
            await this.enqueue(() => this.primeEventScope());
            this.setStatus('idle');
        }
        this.scheduleRemotePoll();
    }

    async stop(): Promise<void> {
        this.running = false;
        this.batcher.cancel();
        if (this.pollTimer !== null) {
            window.clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
        if (this.renameTimer !== null) {
            window.clearTimeout(this.renameTimer);
            this.renameTimer = null;
        }
        if (this.changeTimer !== null) {
            window.clearTimeout(this.changeTimer);
            this.changeTimer = null;
        }
        this.pendingRenames = [];
        this.pendingFolderDeletes.clear();
        this.retryPaths.clear();
        this.plannedLocal.clear();
        this.deferredFullSync = false;
        this.abortController?.abort();
        this.abortController = null;
        await this.queue.catch(() => undefined);
        await this.state.flush();
    }

    /**
     * Hold everything: no watching, no polling. A pass already running is
     * left to finish, since stopping a transfer halfway gains nothing.
     *
     * Edits made while paused are not tracked one by one; the full sync that
     * {@link resume} starts with finds them all, the same way a sync after a
     * restart does.
     */
    pause(): void {
        if (this.paused) {
            return;
        }
        this.paused = true;
        this.batcher.cancel();
        this.pendingRenames = [];
        for (const timer of [this.pollTimer, this.renameTimer]) {
            if (timer !== null) {
                window.clearTimeout(timer);
            }
        }
        this.pollTimer = null;
        this.renameTimer = null;
        this.logger.info('Sync paused');
        this.setStatus(this.status === 'syncing' ? 'syncing' : 'paused');
    }

    /** Pick up where {@link pause} left off, with a full sync to catch up. */
    async resume(): Promise<void> {
        if (!this.paused) {
            return;
        }
        this.paused = false;
        this.logger.info('Sync resumed');
        if (!this.running) {
            return;
        }
        this.setStatus('idle');
        await this.syncNow();
        this.scheduleRemotePoll();
    }

    /** Queue a full reconciliation of both sides. */
    async syncNow(): Promise<void> {
        return this.enqueue(() => this.fullSync());
    }

    /** Re-examine one path now. */
    async syncPath(path: string): Promise<void> {
        return this.enqueue(() => this.processPaths(new Set([path])));
    }

    /**
     * Settle a conflict the user decided on, with the policy they picked, for
     * that one file.
     *
     * The choice goes through the normal sync of the path rather than a
     * separate code path, so a manual resolution gets exactly the checks an
     * automatic one does. The policy applies to this pass over this path
     * only: every other pass, and every other conflicted file, keeps the
     * user's setting.
     */
    async resolveConflict(path: string, policy: ConflictPolicy): Promise<void> {
        return this.enqueue(async () => {
            this.state.clearConflict(path);
            this.policyOverrides.set(path, policy);
            try {
                await this.processPaths(new Set([path]));
            } finally {
                this.policyOverrides.delete(path);
            }
        });
    }

    // -- vault events ----------------------------------------------------

    /** Whether local and remote changes are being followed right now. */
    private get watching(): boolean {
        return this.running && this.settings.autoSync && !this.paused;
    }

    onVaultChange(path: string): void {
        if (!this.watching) {
            return;
        }
        if (this.vault.isSelfWrite(path) || this.filter.isExcludedWithAncestors(path)) {
            return;
        }
        this.batcher.add(path);
    }

    onVaultFolderDelete(path: string): void {
        if (!this.watching) {
            return;
        }
        if (this.vault.isSelfWrite(path) || this.filter.isExcludedWithAncestors(path)) {
            return;
        }
        // Handled after the files inside it, which arrive as their own
        // deletions; the batch is what brings the two together.
        this.pendingFolderDeletes.add(path);
        this.batcher.add(path);
    }

    /**
     * A file or folder was renamed or moved in the vault.
     *
     * Carried to Drive as a rename of the same node, not as a deletion plus an
     * upload. Obsidian names every new note "Untitled" and the user renames it
     * seconds later - often after its first upload - so a rename that was not
     * followed on Drive left the old name there and brought it back into the
     * vault on the next pass. Keeping the node also keeps its revision history.
     *
     * Renaming a folder produces one event for the folder and one for every
     * item inside it, all in the same tick. They are gathered and applied
     * together so the folder can move as one node on Drive, whichever order
     * Obsidian reports them in.
     */
    onVaultRename(oldPath: string, newPath: string, isFolder: boolean): void {
        if (!this.watching) {
            return;
        }
        if (this.vault.isSelfWrite(oldPath) || this.vault.isSelfWrite(newPath)) {
            return;
        }

        const oldExcluded = this.filter.isExcludedWithAncestors(oldPath);
        const newExcluded = this.filter.isExcludedWithAncestors(newPath);
        if (oldExcluded && newExcluded) {
            return;
        }
        if (oldExcluded || newExcluded) {
            // Across the exclusion boundary a rename is, as far as Drive is
            // concerned, a creation or a deletion.
            if (!isFolder) {
                this.batcher.add(oldExcluded ? newPath : oldPath);
            } else if (!oldExcluded) {
                this.onVaultFolderDelete(oldPath);
                for (const record of this.state.entries()) {
                    if (record.type === 'file' && isWithin(record.path, oldPath)) {
                        this.batcher.add(record.path);
                    }
                }
            }
            return;
        }

        this.batcher.rename(oldPath, newPath);
        this.pendingRenames.push({ from: oldPath, to: newPath, isFolder });
        if (this.renameTimer === null) {
            this.renameTimer = window.setTimeout(() => {
                this.renameTimer = null;
                const renames = this.pendingRenames.splice(0);
                void this.enqueue(() => this.applyLocalRenames(renames));
            }, 0);
        }
    }

    // -- the two sync passes ---------------------------------------------

    private async fullSync(): Promise<void> {
        const drive = this.drive;
        const rootUid = this.rootUid;
        if (!drive || !rootUid) {
            this.setStatus('not-configured');
            return;
        }
        if (this.networkHeld()) {
            this.deferredFullSync = true;
            this.setStatus('waiting-for-wifi');
            return;
        }
        this.deferredFullSync = false;

        this.setStatus('syncing');
        try {
            // A full pass settles everything, including what earlier polls
            // could not.
            this.retryPaths.clear();
            this.adoptingSettings = this.state.paths().length === 0 ? [] : null;

            // Where the event feed stands, taken before the listing, so that
            // a change made while the tree is walked is still replayed by the
            // next poll rather than skipped over.
            const scopeId = (await drive.getNode(rootUid)).treeEventScopeId;
            if (this.state.getEventCursor(scopeId) === null) {
                const latest = await drive.latestEventId(scopeId);
                if (latest !== null) {
                    this.state.setEventCursor(scopeId, latest);
                }
            }

            const tree = await drive.listTree(rootUid, (path) => !this.filter.isExcluded(path));
            drive.logSkipped(tree);
            this.treeEventScopeId = tree.treeEventScopeId;

            this.folderUids.clear();
            this.folderUids.set('', rootUid);
            for (const [path, uid] of tree.folders) {
                this.folderUids.set(path, uid);
            }

            // Before anything is compared by path, make sure the paths agree:
            // a note renamed on another device has to be renamed here first,
            // or it reads as one file deleted and an unrelated one created.
            await this.followRemoteMoves(tree);
            const { skip, goneFolders } = await this.verifyMissingNodes(tree);

            const local = await this.vault.list((path) => !this.filter.isExcluded(path));
            const locallyDeletedFolders = await this.syncFolders(local.folders, tree, goneFolders);

            const paths = new Set<string>();
            for (const path of local.files) {
                if (!this.filter.isExcludedWithAncestors(path)) {
                    paths.add(path);
                }
            }
            for (const path of tree.files.keys()) {
                if (!this.filter.isExcludedWithAncestors(path)) {
                    paths.add(path);
                }
            }
            // Paths the last sync knew about that are now absent from both
            // sides still need visiting, so their records are retired.
            for (const record of this.state.entries()) {
                if (record.type === 'file' && !this.filter.isExcludedWithAncestors(record.path)) {
                    paths.add(record.path);
                }
            }

            this.caseCollisions = this.findCaseCollisions(paths);
            if (this.adoptingSettings) {
                // A first sync settles the config folder before anything
                // else. Obsidian needs a reload to apply settings, plugins and
                // themes from Drive, and asking for it now, while the vault is
                // still nearly empty, makes the reload quick and spares
                // Obsidian and its plugins indexing every note twice. The
                // state is saved first, so a reload loses none of it; the
                // notes then continue, or resume after the reload.
                const settingsPaths = new Set([...paths].filter((path) => this.filter.isConfigPath(path)));
                await this.reconcileAll(settingsPaths, tree.files, skip);
                await this.state.flush();
                this.announceAdoptedSettings();
                for (const path of settingsPaths) {
                    paths.delete(path);
                }
            }
            await this.reconcileAll(paths, tree.files, skip);
            await this.cleanUpDeletedFolders(goneFolders, locallyDeletedFolders);
            this.plannedLocal.clear();

            this.lastSyncedAt = Date.now();
            this.lastError = null;
            this.setStatus('idle');
        } catch (error) {
            this.reportFailure('Full sync failed', error);
        } finally {
            this.adoptingSettings = null;
            await this.state.flush();
        }
    }

    /**
     * Reconcile a specific set of paths, resolving each side on demand.
     *
     * Used for both local and remote events. The remote side is looked up per
     * node rather than by listing the tree, which is what keeps steady-state
     * syncing down to a couple of requests per changed file.
     */
    private async processPaths(paths: Set<string>, confirmedAbsent: Set<string> = new Set()): Promise<void> {
        if (!this.drive || !this.rootUid || !this.running) {
            return;
        }
        if (this.networkHeld()) {
            for (const path of paths) {
                this.retryPaths.add(path);
            }
            this.setStatus('waiting-for-wifi');
            return;
        }

        this.setStatus('syncing');
        try {
            const files = new Set(
                [...paths].filter(
                    (path) => this.state.get(path)?.type !== 'folder' && !this.pendingFolderDeletes.has(path),
                ),
            );
            const view = await this.lookupRemote(files, confirmedAbsent);
            const failed = await this.reconcileAll(view.paths, view.states, view.skip);
            for (const path of [...view.skip, ...failed]) {
                this.retryPaths.add(path);
            }
            await this.applyLocalFolderDeletes();

            this.lastSyncedAt = Date.now();
            this.lastError = null;
            this.setStatus('idle');
        } catch (error) {
            for (const path of paths) {
                this.retryPaths.add(path);
            }
            this.reportFailure('Sync failed', error);
        } finally {
            await this.state.flush();
        }
    }

    /**
     * Decide and carry out every path, returning the ones that failed.
     *
     * Deciding is cheap and runs {@link SCAN_CONCURRENCY} wide; only the
     * paths that need Drive queue for one of the user's transfer slots, notes
     * first. A file that changes while it waits is decided again, so the
     * wait never turns into acting on a stale decision.
     */
    private async reconcileAll(
        paths: Set<string>,
        remoteStates: Map<string, RemoteState | undefined>,
        skip: Set<string> = new Set(),
    ): Promise<string[]> {
        const ordered = [...paths]
            .filter((path) => !skip.has(path) && !this.caseCollisions.has(path))
            .sort(this.transferOrder(remoteStates));
        for (const path of skip) {
            this.logger.debug(`Leaving "${path}" alone: could not confirm its state on Drive`);
        }

        const transfers = new Limiter(this.settings.transferConcurrency);
        const limit = this.sizeLimitBytes();
        this.progress = ordered.length > 1 ? { done: 0, total: ordered.length } : null;

        // Deciding runs in parallel, but paths take their place in the
        // transfer queue strictly in `ordered` order: each waits for the one
        // before it to be queued or found to need nothing. Without this, a
        // large attachment decided a moment sooner would take a slot ahead of
        // the notes the ordering is there to put first.
        let previousQueued: Promise<void> = Promise.resolve();
        const work = ordered.map((path) => {
            const turn = previousQueued;
            let markQueued!: () => void;
            previousQueued = new Promise<void>((resolve) => (markQueued = resolve));

            return async () => {
                try {
                    if (this.state.isConflicted(path) && this.settings.conflictPolicy === 'manual') {
                        // Left for the user; acting now would undo a pending decision.
                        return;
                    }
                    let decision = await this.decide(path, remoteStates.get(path), limit);
                    await turn;
                    if (!decision) {
                        return;
                    }
                    if (!needsTransfer(decision.action)) {
                        markQueued();
                        await this.applyAction(path, decision.action, decision.local, decision.remote);
                        return;
                    }
                    // `run` claims its place synchronously, so the next path
                    // may go as soon as it has been called.
                    const transfer = transfers.run(async () => {
                        if (decision && (await this.localMoved(path, decision.local))) {
                            decision = await this.decide(path, remoteStates.get(path), limit);
                        }
                        if (decision) {
                            await this.applyAction(path, decision.action, decision.local, decision.remote);
                        }
                    });
                    markQueued();
                    await transfer;
                } finally {
                    markQueued();
                    if (this.progress) {
                        this.progress.done++;
                        this.emitChange();
                    }
                }
            };
        });

        const failed: string[] = [];
        try {
            await runPooled(work, SCAN_CONCURRENCY, (error, index) => {
                this.logger.error(`Failed to sync "${ordered[index]}"`, error);
                this.lastError = errorMessage(error);
                failed.push(ordered[index]);
            });
        } finally {
            this.progress = null;
        }
        return failed;
    }

    /** What to do with one path, or null when it is to be left alone this pass. */
    private async decide(
        path: string,
        remote: RemoteState | undefined,
        limit: number,
    ): Promise<{ action: SyncAction; local: LocalState | undefined; remote: RemoteState | undefined } | null> {
        const record = this.state.get(path);
        const planned = this.plannedLocal.get(path);
        const known = record?.base ?? (planned && { hash: planned.hash, size: planned.size, localMtime: planned.mtime });

        const local = await this.vault.getState(path, known);
        if (local && local.size > limit) {
            this.logger.info(`Skipping "${path}": ${megabytes(local.size)} MB exceeds the configured limit`);
            return null;
        }

        const action = reconcile({
            path,
            ...(record?.base !== undefined && { base: record.base }),
            ...(local !== undefined && { local }),
            ...(remote !== undefined && { remote }),
        });
        if (remote?.size !== undefined && remote.size > limit && (action.type === 'download' || action.type === 'conflict')) {
            this.logger.info(`Leaving "${path}" on Drive: ${megabytes(remote.size)} MB exceeds this device's limit`);
            return null;
        }
        if (
            this.settingsHeld &&
            this.filter.isConfigPath(path) &&
            (action.type === 'upload' || action.type === 'delete-remote' || action.type === 'conflict')
        ) {
            this.logger.debug(`Holding "${path}" until Obsidian reloads with the settings from Drive`);
            return null;
        }
        return { action, local, remote };
    }

    /** Whether the file is no longer what `local` described: edited, created or removed since. */
    private async localMoved(path: string, local: LocalState | undefined): Promise<boolean> {
        const stat = await this.vault.stat(path);
        if (!local || !stat) {
            return (local === undefined) !== (stat === undefined);
        }
        return stat.size !== local.size || stat.mtime !== local.mtime;
    }

    /** Notes before everything else, then smaller before larger where the size is known. */
    private transferOrder(remoteStates: Map<string, RemoteState | undefined>): (a: string, b: string) => number {
        const rank = (path: string) => (NOTE_EXTENSIONS.has(splitExtension(path).extension.toLowerCase()) ? 0 : 1);
        const size = (path: string) =>
            remoteStates.get(path)?.size ?? this.state.get(path)?.base?.size ?? Number.MAX_SAFE_INTEGER;
        return (a, b) => rank(a) - rank(b) || size(a) - size(b);
    }

    // -- carrying out a decision -----------------------------------------

    private async applyAction(
        path: string,
        action: SyncAction,
        local: LocalState | undefined,
        remote: RemoteState | undefined,
    ): Promise<void> {
        switch (action.type) {
            case 'noop':
                return;

            case 'forget':
                this.state.delete(path);
                return;

            case 'adopt':
                if (local) {
                    this.state.setSynced(path, action.nodeUid, 'file', baseOf(local, action.revisionUid));
                }
                return;

            case 'upload':
                if (local) {
                    await this.upload(path, remote);
                }
                return;

            case 'download':
                await this.download(path, action.nodeUid, action.revisionUid, remote);
                return;

            case 'delete-local':
                this.logger.info(`Removing "${path}", deleted on another device`);
                await this.vault.trash(path);
                this.state.delete(path);
                return;

            case 'delete-remote':
                this.logger.info(`Removing "${path}" from Drive, deleted locally`);
                await this.drive!.trashNode(action.nodeUid);
                this.state.delete(path);
                return;

            case 'conflict':
                await this.handleConflict(path, action.reason, local, remote);
                return;
        }
    }

    /**
     * Upload the file's current content, as a new revision of the node it is
     * paired with or as a new file. The base records what was actually sent,
     * which is not necessarily what the reconcile saw a moment earlier.
     */
    private async upload(path: string, remote: RemoteState | undefined): Promise<void> {
        const { source, local } = await this.vault.openUpload(path);
        const progress = this.trackTransfer(path, 'upload', source.size);
        try {
            await this.sendUpload(path, remote, source, local, progress.onProgress);
        } finally {
            progress.end();
        }
    }

    private async sendUpload(
        path: string,
        remote: RemoteState | undefined,
        source: UploadSource,
        local: LocalState,
        onProgress: ((bytes: number) => void) | undefined,
    ): Promise<void> {
        const drive = this.drive!;
        const signal = this.abortController?.signal;

        const record = this.state.get(path);
        const nodeUid = remote?.nodeUid ?? record?.nodeUid;
        if (nodeUid) {
            const previousRevision = remote?.revisionUid ?? record?.base?.remoteRevisionUid;
            const previousHash = record?.base?.hash;
            const result = await drive.uploadRevision(nodeUid, source, signal, onProgress);
            this.uploaded++;
            this.state.setSynced(path, result.nodeUid, 'file', baseOf(local, result.revisionUid));
            this.logger.debug(`Uploaded "${path}"`);
            if (previousRevision) {
                await this.rescueSupersededEdits(path, nodeUid, previousRevision, result.revisionUid, [
                    local.hash,
                    previousHash,
                ]);
            }
            return;
        }

        const parentUid = await this.ensureRemoteFolder(parentPath(path));
        let result: { nodeUid: string; revisionUid: string };
        try {
            result = await drive.uploadNewFile(parentUid, basename(path), source, signal, onProgress);
        } catch (error) {
            // Another device created a file under the same name since this
            // pass looked. That is the both-created conflict, found late.
            if (error instanceof NodeWithSameNameExistsValidationError && !error.isUnfinishedUpload) {
                const existing = await this.findByName(path, new Map());
                if (existing?.hash === local.hash) {
                    // The same bytes, from another device: nothing to resolve.
                    this.state.setSynced(path, existing.nodeUid, 'file', baseOf(local, existing.revisionUid));
                    return;
                }
                if (existing) {
                    await this.handleConflict(path, 'both-created', local, existing);
                    return;
                }
            }
            throw error;
        }
        this.uploaded++;
        this.state.setSynced(path, result.nodeUid, 'file', baseOf(local, result.revisionUid));
        this.logger.debug(`Uploaded "${path}"`);
    }

    /**
     * Keep an edit that another device uploaded while this one was uploading.
     *
     * Drive has no conditional upload, so when two devices save the same note
     * within the same few seconds, both uploads succeed and the later one
     * silently becomes the current version. Nothing is lost on Drive, since
     * the earlier revision stays in the history, but nobody would ever look
     * there. So the superseded edit is written beside the note as a conflict
     * copy, exactly as if the conflict had been seen before the upload.
     */
    private async rescueSupersededEdits(
        path: string,
        nodeUid: string,
        previousRevision: string,
        uploadedRevision: string,
        /** Content that costs nothing to supersede: what was just uploaded, and the version it was based on. */
        knownHashes: (string | undefined)[],
    ): Promise<void> {
        let superseded;
        try {
            superseded = await this.drive!.revisionsBetween(nodeUid, previousRevision, uploadedRevision);
        } catch (error) {
            this.logger.debug(`Could not check the revision history of "${path}"`, error);
            return;
        }
        const lost = superseded
            .filter((revision) => !knownHashes.includes(revision.claimedDigests?.sha1))
            .at(-1);
        if (!lost) {
            return;
        }

        const copyPath = await this.availablePath(conflictCopyPath(path, this.settings.deviceName, new Date()));
        this.logger.warn(`"${path}" was saved on another device during this upload; keeping that version as "${copyPath}"`);
        await this.fetchInto(copyPath, { revisionUid: lost.uid }, lost.claimedSize, lost.claimedModificationTime?.getTime());
        await this.uploadAsNewFile(copyPath);
        this.reportConflict({ path, reason: 'both-modified', outcome: 'kept-both', copyPath });
    }

    /** Upload a file that has no node on Drive yet, such as a fresh conflict copy. */
    private async uploadAsNewFile(path: string): Promise<void> {
        const { source, local } = await this.vault.openUpload(path);
        const parentUid = await this.ensureRemoteFolder(parentPath(path));
        const result = await this.drive!.uploadNewFile(parentUid, basename(path), source, this.abortController?.signal);

        this.uploaded++;
        this.state.setSynced(path, result.nodeUid, 'file', baseOf(local, result.revisionUid));
    }

    private async download(
        path: string,
        nodeUid: string,
        revisionUid: string,
        remote: RemoteState | undefined,
    ): Promise<void> {
        const written = await this.fetchInto(path, { nodeUid }, remote?.size, remote?.mtime);
        this.downloaded++;
        this.state.setSynced(path, nodeUid, 'file', baseOf(written, revisionUid));
        if (this.adoptingSettings && this.filter.isConfigPath(path)) {
            this.adoptingSettings.push(path);
        }
        if (path === `${this.scope.configDir}/community-plugins.json`) {
            await this.keepSelfEnabled(path);
        }
        this.logger.debug(`Downloaded "${path}"`);
    }

    /**
     * Write a node's current content, or one specific revision, to a vault
     * path.
     *
     * Large files, and files whose size Drive does not report, are streamed to
     * disk where the platform allows it; the rest are small enough to buffer,
     * which lets Obsidian's adapter do the write and keeps the file cache in
     * step.
     */
    private async fetchInto(
        path: string,
        what: { nodeUid: string } | { revisionUid: string },
        size: number | undefined,
        mtime: number | undefined,
    ): Promise<LocalState> {
        const drive = this.drive!;
        const signal = this.abortController?.signal;
        const { onProgress, end } = this.trackTransfer(path, 'download', size);

        try {
            if (size === undefined || size > LARGE_FILE_BYTES) {
                const file = await this.vault.openDownload(path);
                if (file) {
                    try {
                        await ('nodeUid' in what
                            ? drive.downloadTo(what.nodeUid, file.sink, signal, onProgress)
                            : drive.downloadRevisionTo(what.revisionUid, file.sink, signal, onProgress));
                        return await file.commit(mtime);
                    } catch (error) {
                        await file.abort();
                        throw error;
                    }
                }
            }

            const data = await ('nodeUid' in what
                ? drive.downloadFile(what.nodeUid, signal, onProgress)
                : drive.downloadRevision(what.revisionUid, signal, onProgress));
            return await this.vault.writeBinary(path, data, mtime);
        } finally {
            end();
        }
    }

    private async handleConflict(
        path: string,
        reason: ConflictReason,
        local: LocalState | undefined,
        remote: RemoteState | undefined,
    ): Promise<void> {
        const record = this.state.get(path);
        this.logger.warn(`Conflict on "${path}" (${reason})`);

        const resolution = await this.resolverFor(path, reason).resolve({
            path,
            reason,
            ...(record?.base !== undefined && { base: record.base }),
            ...(local !== undefined && { local }),
            ...(remote !== undefined && { remote }),
            readLocalText: () => this.vault.readText(path),
        });

        switch (resolution.action) {
            case 'defer':
                this.state.setConflict(path, { detectedAt: Date.now(), reason });
                this.logger.warn(`"${path}" needs a decision: ${resolution.note}`);
                this.reportConflict({ path, reason, outcome: 'deferred' });
                return;

            case 'take-local':
                if (local) {
                    if (!remote) {
                        // The node this path used to map to was trashed on
                        // Drive. Uploading a revision to it would either fail or
                        // resurrect the file inside the trash, so the stale
                        // record is dropped and the edit goes up as a new file.
                        this.state.delete(path);
                    }
                    await this.upload(path, remote);
                    this.state.clearConflict(path);
                    this.reportConflict({ path, reason, outcome: 'kept-local' });
                }
                return;

            case 'take-remote':
                if (remote) {
                    await this.download(path, remote.nodeUid, remote.revisionUid, remote);
                    this.state.clearConflict(path);
                    this.reportConflict({ path, reason, outcome: 'kept-remote' });
                }
                return;

            case 'take-merged': {
                await this.vault.writeBinary(path, resolution.content);
                await this.upload(path, remote);
                this.state.clearConflict(path);
                this.reportConflict({ path, reason, outcome: 'merged' });
                return;
            }

            case 'keep-both': {
                const copyPath = await this.availablePath(resolution.copyPath);
                if (await this.keepBoth(path, copyPath, resolution.keepAtPath, local, remote, reason)) {
                    this.reportConflict({ path, reason, outcome: 'kept-both', copyPath });
                }
                return;
            }
        }
    }

    /**
     * Write both versions into the vault and push both to Drive.
     *
     * The copy is uploaded here rather than left to the next pass so the other
     * devices see it straight away. A conflict copy that exists on only one
     * machine is the kind of thing a user discovers a week later.
     */
    private async keepBoth(
        path: string,
        copyPath: string,
        keepAtPath: 'local' | 'remote',
        local: LocalState | undefined,
        remote: RemoteState | undefined,
        reason: ConflictReason,
    ): Promise<boolean> {
        if (keepAtPath === 'local') {
            if (!remote) {
                return false;
            }
            await this.fetchInto(copyPath, { nodeUid: remote.nodeUid }, remote.size, remote.mtime);
            await this.uploadAsNewFile(copyPath);
            if (local) {
                await this.upload(path, remote);
            }
        } else {
            if (!local) {
                return false;
            }
            await this.vault.copy(path, copyPath);
            await this.uploadAsNewFile(copyPath);
            if (remote) {
                await this.download(path, remote.nodeUid, remote.revisionUid, remote);
            }
        }

        this.state.clearConflict(path);
        this.logger.warn(`Kept both versions of "${path}" (${reason}); the other copy is at "${copyPath}"`);
        return true;
    }

    /** `path`, or the first "name 2.ext", "name 3.ext"… that is free, so a copy never overwrites another. */
    private async availablePath(path: string): Promise<string> {
        if (!(await this.vault.exists(path))) {
            return path;
        }
        const { stem, extension } = splitExtension(path);
        for (let n = 2; ; n++) {
            const candidate = `${stem} ${n}${extension}`;
            if (!(await this.vault.exists(candidate))) {
                return candidate;
            }
        }
    }

    // -- renames made in the vault ----------------------------------------

    private async applyLocalRenames(renames: PendingRename[]): Promise<void> {
        if (!this.drive || !this.rootUid || !this.running) {
            return;
        }
        if (this.networkHeld()) {
            // Too many paths to carry over one by one; a full sync on Wi-Fi
            // sees the result of every rename.
            this.deferredFullSync = true;
            this.setStatus('waiting-for-wifi');
            return;
        }

        const touched = new Set<string>();
        const applied: PendingRename[] = [];
        const carriedByParent = (rename: PendingRename) =>
            applied.some(
                (done) => isWithin(rename.from, done.from) && replacePrefix(rename.from, done.from, done.to) === rename.to,
            );

        // Folders first, shallowest first: once a folder has moved on Drive,
        // everything inside it has moved too, and the renames reported for its
        // contents are already satisfied.
        const folders = renames.filter((rename) => rename.isFolder).sort((a, b) => byDepth(a.from, b.from));
        for (const rename of folders) {
            if (carriedByParent(rename)) {
                continue;
            }
            let uid: string | undefined;
            try {
                uid = await this.findRemoteFolder(rename.from);
            } catch (error) {
                this.logger.warn(`Could not look up folder "${rename.from}" on Drive`, error);
            }
            if (!uid) {
                // Never reached Drive; the files inside are handled one by one.
                continue;
            }
            try {
                await this.moveRemoteNode(uid, rename.to);
            } catch (error) {
                this.logger.warn(`Could not rename folder "${rename.from}" on Drive; moving its files instead`, error);
                continue;
            }
            this.state.renameFolder(rename.from, rename.to);
            this.renameKnownFolders(rename.from, rename.to);
            this.folderUids.set(rename.to, uid);
            this.state.setSynced(rename.to, uid, 'folder');
            applied.push(rename);
            this.logger.info(`Renamed folder "${rename.from}" to "${rename.to}" on Drive`);

            for (const record of this.state.entries()) {
                if (record.type === 'file' && isWithin(record.path, rename.to)) {
                    touched.add(record.path);
                }
            }
        }

        for (const rename of renames.filter((rename) => !rename.isFolder)) {
            touched.add(rename.to);
            if (carriedByParent(rename)) {
                continue;
            }
            const record = this.state.get(rename.from);
            if (record?.type !== 'file') {
                // Not on Drive yet: the reconcile below uploads it under its
                // new name, and there is nothing under the old one to remove.
                continue;
            }
            try {
                await this.moveRemoteNode(record.nodeUid, rename.to);
                this.state.rename(rename.from, rename.to);
                this.logger.info(`Renamed "${rename.from}" to "${rename.to}" on Drive`);
            } catch (error) {
                // Typically a name already taken on Drive. Falling back to
                // delete-and-upload still converges; it only costs the history.
                this.logger.warn(`Could not rename "${rename.from}" on Drive; uploading it under the new name`, error);
                touched.add(rename.from);
            }
        }

        await this.processPaths(touched);
    }

    /** Put a node at the Drive location matching a vault path: same parent folder, same name. */
    private async moveRemoteNode(nodeUid: string, toPath: string): Promise<void> {
        const drive = this.drive!;
        const parentUid = await this.ensureRemoteFolder(parentPath(toPath));
        const node = await drive.getNode(nodeUid);
        if (node.trashTime !== undefined) {
            throw new Error('it is in the Drive trash');
        }
        if (node.parentUid !== parentUid) {
            await drive.moveNode(nodeUid, parentUid);
        }
        const name = basename(toPath);
        if (drive.nameOf(node) !== name) {
            await drive.renameNode(nodeUid, name);
        }
    }

    // -- renames and moves made on Drive ----------------------------------

    /**
     * Bring vault paths in line with nodes that were renamed or moved on Drive
     * since the last sync, using the tree just listed.
     */
    private async followRemoteMoves(tree: RemoteTree): Promise<void> {
        // Folders first, shallowest first, so that by the time the files are
        // checked, those inside a moved folder are already where Drive has them.
        const folderUids = this.state
            .entries()
            .filter((record) => record.type === 'folder')
            .sort((a, b) => byDepth(a.path, b.path))
            .map((record) => record.nodeUid);
        for (const uid of folderUids) {
            const record = this.state.getByNodeUid(uid);
            const remotePath = tree.nodePaths.get(uid);
            if (
                record?.type === 'folder' &&
                remotePath !== undefined &&
                remotePath !== record.path &&
                !this.filter.isExcludedWithAncestors(record.path)
            ) {
                await this.followRemoteMove(record.path, remotePath, 'folder');
            }
        }

        for (const record of this.state.entries()) {
            const remotePath = tree.nodePaths.get(record.nodeUid);
            if (
                record.type === 'file' &&
                remotePath !== undefined &&
                remotePath !== record.path &&
                !this.filter.isExcludedWithAncestors(record.path)
            ) {
                await this.followRemoteMove(record.path, remotePath, 'file');
            }
        }
    }

    /**
     * Rename a vault path to follow its node on Drive. Returns false, leaving
     * the vault untouched, when that is not safe.
     *
     * The unsafe case is a destination that is already taken here. The file
     * is then detached from its node, so it goes up again under its current
     * name and both copies survive, rather than one replacing the other.
     */
    private async followRemoteMove(fromPath: string, toPath: string, type: 'file' | 'folder'): Promise<boolean> {
        if (this.filter.isExcludedWithAncestors(toPath)) {
            // Moved somewhere this device does not sync. Keep the local copy.
            if (type === 'file') {
                this.state.delete(fromPath);
            }
            return false;
        }

        const caseOnly = fromPath.toLowerCase() === toPath.toLowerCase();
        const occupied =
            (caseOnly ? await this.vault.existsExactly(toPath) : await this.vault.exists(toPath)) ||
            this.state.get(toPath) !== undefined;
        if (occupied) {
            this.logger.info(
                `"${fromPath}" was renamed to "${toPath}" on another device, but "${toPath}" already exists here; ` +
                    'keeping both',
            );
            if (type === 'file') {
                this.state.delete(fromPath);
            }
            return false;
        }

        if (await this.vault.exists(fromPath)) {
            await this.vault.rename(fromPath, toPath);
        }
        if (type === 'folder') {
            this.state.renameFolder(fromPath, toPath);
            this.renameKnownFolders(fromPath, toPath);
        } else {
            this.state.rename(fromPath, toPath);
        }
        this.logger.info(`Renamed "${fromPath}" to "${toPath}", as on another device`);
        return true;
    }

    /**
     * Establish what happened to recorded nodes the tree listing did not
     * contain.
     *
     * Not being in the listing is not the same as being deleted: the node may
     * have moved out of the synced folder, sit under a name that could not be
     * decrypted, or the lookup may simply have failed. Only a node Drive
     * confirms as gone, or as in the trash, lets the reconcile delete the local
     * file; everything else is kept, and uploaded again when it has no node.
     */
    private async verifyMissingNodes(tree: RemoteTree): Promise<{ skip: Set<string>; goneFolders: Set<string> }> {
        const skip = new Set<string>();
        const goneFolders = new Set<string>();
        const insideGoneFolder = (path: string) => [...goneFolders].some((folder) => isWithin(path, folder));

        const missing = this.state
            .entries()
            .filter((record) => !tree.nodePaths.has(record.nodeUid) && !this.filter.isExcludedWithAncestors(record.path));

        // Folders first: trashing a folder on Drive takes everything inside it
        // along, and one lookup of the folder settles all of it.
        const folders = missing.filter((record) => record.type === 'folder').sort((a, b) => byDepth(a.path, b.path));
        const staleFolders: string[] = [];
        for (const record of folders) {
            if (insideGoneFolder(record.path)) {
                continue;
            }
            const location = await this.tryLocate(record.nodeUid);
            if (location?.kind === 'deleted') {
                goneFolders.add(record.path);
            } else if (location?.kind === 'outside' || location?.kind === 'at') {
                // Alive, but not where this vault's folder is. Its record must
                // go, or uploads would keep landing in a folder nobody syncs;
                // the files inside are settled one by one below.
                staleFolders.push(record.path);
            }
        }
        for (const path of [...goneFolders, ...staleFolders]) {
            this.forgetFolder(path);
        }

        for (const record of missing) {
            if (record.type !== 'file' || insideGoneFolder(record.path)) {
                continue;
            }
            const location = await this.tryLocate(record.nodeUid);
            switch (location?.kind) {
                case 'deleted':
                    // Absence confirmed; the reconcile chooses between deleting
                    // the local copy and keeping a local edit.
                    break;
                case 'outside':
                    this.logger.info(`"${record.path}" was moved out of the synced Drive folder; uploading it again`);
                    this.state.delete(record.path);
                    break;
                default:
                    // In a folder that could not be read, or the lookup failed.
                    skip.add(record.path);
            }
        }

        return { skip, goneFolders };
    }

    /**
     * Paths that collide with another when letter case is ignored.
     *
     * Drive, like Linux and Android, keeps `Note.md` and `note.md` apart; the
     * filesystems of Windows, macOS and iOS do not, and there both names reach
     * the same file. Syncing such a pair would download one over the other on
     * every pass, so neither is touched until one is renamed, and the user is
     * told which.
     */
    private findCaseCollisions(paths: Set<string>): Set<string> {
        const byFolded = new Map<string, string[]>();
        for (const path of paths) {
            const folded = path.toLowerCase();
            byFolded.set(folded, [...(byFolded.get(folded) ?? []), path]);
        }
        const collisions = new Set<string>();
        for (const group of byFolded.values()) {
            if (group.length > 1) {
                this.logger.warn(
                    `Not syncing ${group.map((path) => `"${path}"`).join(' and ')}: their names differ only in ` +
                        'letter case, which some devices cannot tell apart. Rename one of them.',
                );
                for (const path of group) {
                    collisions.add(path);
                }
            }
        }
        return collisions;
    }

    /** A node's location, or null when Drive could not be asked. */
    private async tryLocate(nodeUid: string): Promise<NodeLocation | null> {
        try {
            return await this.drive!.locate(nodeUid, this.rootUid!);
        } catch (error) {
            this.logger.debug(`Could not locate node ${nodeUid}`, error);
            return null;
        }
    }

    // -- folders ----------------------------------------------------------

    /**
     * Give both sides every folder the other has, and report folders that
     * were deleted locally since the last sync.
     *
     * Folders carry no content, so nothing else in the sync would ever create
     * an empty one, and an empty folder is usually structure the user set up
     * deliberately before writing into it.
     */
    private async syncFolders(
        localFolders: string[],
        tree: RemoteTree,
        goneFolders: Set<string>,
    ): Promise<Map<string, string>> {
        const localSet = new Set(localFolders);

        // Shallowest first, so a parent exists before its children need it.
        for (const path of [...localSet].sort(byDepth)) {
            if (this.filter.isExcludedWithAncestors(path) || this.folderUids.has(path)) {
                continue;
            }
            if ([...goneFolders].some((folder) => isWithin(path, folder))) {
                // Deleted on Drive. Whether it survives here is decided once
                // the files inside it have been reconciled.
                continue;
            }
            await this.ensureRemoteFolder(path);
        }

        const locallyDeleted = new Map<string, string>();
        for (const [path, uid] of [...tree.folders].sort(([a], [b]) => byDepth(a, b))) {
            if (this.filter.isExcludedWithAncestors(path)) {
                continue;
            }
            const record = this.state.get(path);
            if (localSet.has(path)) {
                // Remembered so later passes can find it without a listing.
                if (record?.nodeUid !== uid) {
                    this.state.setSynced(path, uid, 'folder');
                }
                continue;
            }
            if (record?.type === 'folder' && record.nodeUid === uid) {
                // Synced before and gone now: deleted here.
                locallyDeleted.set(path, uid);
                continue;
            }
            await this.vault.ensureFolder(path);
            this.state.setSynced(path, uid, 'folder');
        }
        return locallyDeleted;
    }

    /**
     * Carry folder deletions across once their contents have been reconciled.
     *
     * Only an emptied folder is removed. Anything still inside a folder that
     * was deleted on the other side is an edit the deletion would have
     * discarded; the reconcile has already restored it, and the folder stays
     * with it.
     */
    private async cleanUpDeletedFolders(goneFolders: Set<string>, locallyDeleted: Map<string, string>): Promise<void> {
        for (const path of [...goneFolders].sort((a, b) => byDepth(b, a))) {
            await this.removeLocalFolderIfEmpty(path);
        }

        for (const [path, uid] of [...locallyDeleted].sort(([a], [b]) => byDepth(b, a))) {
            try {
                if (await this.vault.exists(path)) {
                    continue;
                }
                if (await this.drive!.hasLiveChildren(uid)) {
                    continue;
                }
                await this.drive!.trashNode(uid);
                this.forgetFolder(path);
                this.logger.info(`Removed folder "${path}" from Drive, deleted locally`);
            } catch (error) {
                this.logger.warn(`Could not remove folder "${path}" from Drive`, error);
            }
        }
    }

    /** Folders deleted in the vault since the last pass; see {@link onVaultFolderDelete}. */
    private async applyLocalFolderDeletes(): Promise<void> {
        for (const path of [...this.pendingFolderDeletes].sort((a, b) => byDepth(b, a))) {
            if (this.state.entries().some((record) => record.type === 'file' && isWithin(record.path, path))) {
                // Its files' own deletions have not reached Drive yet; they
                // arrive in a later batch, and the folder waits for them.
                continue;
            }
            this.pendingFolderDeletes.delete(path);
            try {
                if (await this.vault.exists(path)) {
                    continue;
                }
                const uid = await this.findRemoteFolder(path);
                if (!uid) {
                    continue;
                }
                if (await this.drive!.hasLiveChildren(uid)) {
                    this.logger.info(`Kept folder "${path}" on Drive: it still holds files this device has not synced`);
                    continue;
                }
                await this.drive!.trashNode(uid);
                this.forgetFolder(path);
                this.logger.info(`Removed folder "${path}" from Drive, deleted locally`);
            } catch (error) {
                this.logger.warn(`Could not remove folder "${path}" from Drive`, error);
            }
        }
    }

    private async removeLocalFolderIfEmpty(path: string): Promise<void> {
        try {
            if ((await this.vault.exists(path)) && !(await this.vault.hasFiles(path))) {
                await this.vault.trash(path);
                this.logger.info(`Removed folder "${path}", deleted on another device`);
            }
        } catch (error) {
            this.logger.warn(`Could not remove folder "${path}"`, error);
        }
    }

    /** The Drive folder for a vault path, creating it and its parents if needed. */
    private async ensureRemoteFolder(path: string): Promise<string> {
        const known = this.knownFolderUid(path);
        if (known) {
            this.folderUids.set(path, known);
            return known;
        }

        const parentUid = await this.ensureRemoteFolder(parentPath(path));
        const name = basename(path);

        let uid: string;
        try {
            uid = await this.drive!.createFolder(parentUid, name);
        } catch (error) {
            // Another device may have created it between our listing and now.
            const existing = await this.findChildFolder(parentUid, name);
            if (!existing) {
                throw error;
            }
            uid = existing;
        }

        this.folderUids.set(path, uid);
        this.state.setSynced(path, uid, 'folder');
        return uid;
    }

    /** The Drive folder for a vault path if it exists, without creating anything. */
    private async findRemoteFolder(path: string): Promise<string | undefined> {
        const known = this.knownFolderUid(path);
        if (known) {
            return known;
        }
        const parentUid = await this.findRemoteFolder(parentPath(path));
        if (!parentUid) {
            return undefined;
        }
        const uid = await this.findChildFolder(parentUid, basename(path));
        if (uid) {
            this.folderUids.set(path, uid);
        }
        return uid ?? undefined;
    }

    private knownFolderUid(path: string): string | undefined {
        if (path === '') {
            return this.rootUid ?? undefined;
        }
        const known = this.folderUids.get(path);
        if (known) {
            return known;
        }
        const record = this.state.get(path);
        return record?.type === 'folder' ? record.nodeUid : undefined;
    }

    private renameKnownFolders(fromPath: string, toPath: string): void {
        for (const [path, uid] of [...this.folderUids]) {
            if (isWithin(path, fromPath)) {
                this.folderUids.delete(path);
                this.folderUids.set(replacePrefix(path, fromPath, toPath), uid);
            }
        }
    }

    /** Drop every folder uid at or below `path`, so the next upload there creates a fresh folder. */
    private forgetFolder(path: string): void {
        for (const known of [...this.folderUids.keys()]) {
            if (isWithin(known, path)) {
                this.folderUids.delete(known);
            }
        }
        for (const record of this.state.entries()) {
            if (record.type === 'folder' && isWithin(record.path, path)) {
                this.state.delete(record.path);
            }
        }
    }

    private async findChildFolder(parentUid: string, name: string): Promise<string | null> {
        for await (const child of this.drive!.iterateChildren(parentUid)) {
            if (child.name === name && child.node.type === NodeType.Folder) {
                return child.node.uid;
            }
        }
        return null;
    }

    // -- resolving remote state for a set of paths -------------------------

    /**
     * The Drive side of a set of paths, for an incremental pass.
     *
     * Recorded files are looked up by node, all in one request, which also
     * reveals renames made on another device: a node whose name or folder no
     * longer matches its record is followed to its new path before anything
     * is compared. Paths with no usable record are found by listing their
     * parent folder.
     */
    private async lookupRemote(paths: Set<string>, confirmedAbsent: Set<string>): Promise<RemoteView> {
        const drive = this.drive!;
        const view: RemoteView = { paths: new Set(), states: new Map(), skip: new Set() };
        const byName: string[] = [];
        const byUid = new Map<string, string>();

        for (const path of paths) {
            view.paths.add(path);
            const record = this.state.get(path);
            if (confirmedAbsent.has(path)) {
                view.states.set(path, undefined);
            } else if (record?.type === 'file') {
                byUid.set(record.nodeUid, path);
            } else {
                byName.push(path);
            }
        }

        let nodes = new Map<string, NodeEntity | null>();
        if (byUid.size > 0) {
            try {
                nodes = await drive.lookupNodes([...byUid.keys()]);
            } catch (error) {
                this.logger.warn('Could not look up changed files on Drive', error);
                for (const path of byUid.values()) {
                    view.skip.add(path);
                }
            }
        }

        for (const [uid, path] of byUid) {
            if (view.skip.has(path)) {
                continue;
            }
            if (!nodes.has(uid)) {
                // Not answered for, which is not the same as reported missing.
                view.skip.add(path);
                continue;
            }
            const node = nodes.get(uid);
            if (!node || node.trashTime !== undefined) {
                // Gone, but another device may have put a new file under the
                // same name, which a listing will find.
                byName.push(path);
                continue;
            }
            if (this.isAtPath(node, path)) {
                view.states.set(path, drive.toRemoteState(node));
                continue;
            }

            const location = await this.tryLocate(uid);
            switch (location?.kind) {
                case 'deleted':
                    view.states.set(path, undefined);
                    break;
                case 'outside':
                    this.logger.info(`"${path}" was moved out of the synced Drive folder; uploading it again`);
                    this.state.delete(path);
                    view.states.set(path, undefined);
                    break;
                case 'at':
                    if (location.path === path) {
                        view.states.set(path, drive.toRemoteState(node));
                    } else {
                        if (await this.followRemoteMove(path, location.path, 'file')) {
                            view.paths.delete(path);
                        } else {
                            view.states.set(path, undefined);
                        }
                        view.paths.add(location.path);
                        view.states.set(location.path, drive.toRemoteState(node));
                    }
                    break;
                default:
                    view.skip.add(path);
            }
        }

        const listed = new Map<string, Map<string, NodeEntity>>();
        for (const path of byName) {
            try {
                view.states.set(path, await this.findByName(path, listed));
            } catch (error) {
                this.logger.warn(`Could not look up "${path}" on Drive`, error);
                view.skip.add(path);
            }
        }

        return view;
    }

    /** Whether a node still sits where the vault path says: same name, same folder. */
    private isAtPath(node: NodeEntity, path: string): boolean {
        if (this.drive!.nameOf(node) !== basename(path)) {
            return false;
        }
        const expectedParent = this.knownFolderUid(parentPath(path));
        return expectedParent === undefined || node.parentUid === expectedParent;
    }

    /** Find a file on Drive by its path, listing each parent folder at most once per pass. */
    private async findByName(
        path: string,
        listedParents: Map<string, Map<string, NodeEntity>>,
    ): Promise<RemoteState | undefined> {
        const parent = parentPath(path);
        let children = listedParents.get(parent);
        if (!children) {
            const parentUid = this.knownFolderUid(parent);
            if (parentUid === undefined) {
                // The parent folder does not exist on Drive yet, so neither can
                // anything inside it.
                return undefined;
            }
            children = new Map();
            for await (const child of this.drive!.iterateChildren(parentUid)) {
                children.set(child.name, child.node);
            }
            listedParents.set(parent, children);
        }

        const node = children.get(basename(path));
        return node ? this.drive!.toRemoteState(node) : undefined;
    }

    // -- remote event polling ---------------------------------------------

    /** Read the root node just to learn its event scope. */
    private async primeEventScope(): Promise<void> {
        try {
            const root = await this.drive!.getNode(this.rootUid!);
            this.treeEventScopeId = root.treeEventScopeId;
            this.folderUids.set('', this.rootUid!);
        } catch (error) {
            this.reportFailure('Could not read the synced folder', error);
        }
    }

    /**
     * Check Drive now instead of at the next interval: when the app returns to
     * the foreground, or the network comes back. On mobile especially, where
     * the app is suspended in the background and its timers with it, this is
     * what makes a note edited elsewhere show up on opening the app.
     */
    pollNow(): void {
        if (!this.running || this.polling || this.paused) {
            return;
        }
        this.runPoll();
    }

    /**
     * Push edits that are still waiting out the debounce. Called when the app
     * goes to the background, since a mobile OS may suspend or kill it before
     * the timer fires.
     */
    flushPendingEdits(): void {
        this.batcher.flush();
    }

    private scheduleRemotePoll(): void {
        if (!this.running || this.paused) {
            return;
        }
        if (this.pollTimer !== null) {
            window.clearTimeout(this.pollTimer);
        }
        const seconds = Math.max(MIN_POLL_SECONDS, this.settings.remotePollSeconds);
        this.pollTimer = window.setTimeout(() => {
            this.pollTimer = null;
            this.runPoll();
        }, seconds * 1000);
    }

    private runPoll(): void {
        if (this.pollTimer !== null) {
            window.clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
        this.polling = true;
        void this.enqueue(async () => {
            if (this.deferredFullSync) {
                await this.fullSync();
                return;
            }
            await this.pollRemoteEvents();
            await this.pollConfigFolder();
        }).finally(() => {
            this.polling = false;
            this.scheduleRemotePoll();
        });
    }

    /**
     * Ask Drive what changed since the last event that was processed.
     *
     * Event-based rather than a repeated tree walk, which Proton's guidelines
     * for third-party clients require: a recursive listing on a timer is the
     * behaviour that gets an account rate-limited.
     */
    private async pollRemoteEvents(): Promise<void> {
        const drive = this.drive;
        const scopeId = this.treeEventScopeId;
        if (!drive || !scopeId || !this.running || !this.settings.autoSync) {
            return;
        }
        if (this.networkHeld()) {
            // The cursor stays put, so these events are read once allowed.
            this.setStatus('waiting-for-wifi');
            return;
        }
        if (this.status === 'waiting-for-wifi') {
            this.setStatus('idle');
        }

        const cursor = this.state.getEventCursor(scopeId);
        const events: NodeChange[] = [];
        let lastEventId: string | null = null;
        let needsFullSync = false;
        let readError: unknown = null;

        try {
            for await (const event of drive.iterateEvents(scopeId, cursor ?? undefined, this.abortController?.signal)) {
                if (
                    event.type === DriveEventType.NodeCreated ||
                    event.type === DriveEventType.NodeUpdated ||
                    event.type === DriveEventType.NodeDeleted
                ) {
                    events.push({ nodeUid: event.nodeUid, parentNodeUid: event.parentNodeUid });
                } else if (event.type === DriveEventType.TreeRefresh) {
                    // Drive can no longer replay from the cursor. The only
                    // way back to a known-good state is a full comparison.
                    needsFullSync = true;
                }
                // `FastForward` needs nothing but the cursor it carries: Drive
                // sends it for a first poll and when nothing happened.
                lastEventId = event.eventId;
            }
        } catch (error) {
            // Events read before the failure are still good; handle them and
            // resume from the last one next time.
            readError = error;
        }

        if (needsFullSync) {
            await this.fullSync();
        } else {
            await this.applyRemoteEvents(events);
        }
        // Only now: a cursor saved before its events were handled would skip
        // them for good if the app closed in between.
        if (lastEventId !== null) {
            this.state.setEventCursor(scopeId, lastEventId);
        }
        if (readError !== null) {
            this.reportFailure('Could not read Drive events', readError);
        }
        await this.state.flush();
    }

    private async applyRemoteEvents(events: NodeChange[]): Promise<void> {
        const paths = new Set(this.retryPaths);
        this.retryPaths.clear();
        const confirmedAbsent = new Set<string>();
        const goneFolders: string[] = [];

        const nodeUids = [...new Set(events.map((event) => event.nodeUid))];
        // Folders before files: a folder renamed or trashed on Drive changes
        // the path of everything recorded inside it.
        const folderEvents = nodeUids
            .map((uid) => this.state.getByNodeUid(uid))
            .filter((record) => record?.type === 'folder')
            .sort((a, b) => byDepth(a!.path, b!.path))
            .map((record) => record!.nodeUid);
        for (const uid of folderEvents) {
            await this.followRemoteFolder(uid, paths, confirmedAbsent, goneFolders);
        }

        for (const event of events) {
            if (folderEvents.includes(event.nodeUid)) {
                continue;
            }
            const path = await this.pathForEvent(event);
            if (path !== null && path !== '' && !this.filter.isExcludedWithAncestors(path)) {
                paths.add(path);
            }
        }

        if (paths.size > 0) {
            this.logger.debug(`${paths.size} path(s) changed on Drive`);
            await this.processPaths(paths, confirmedAbsent);
        }
        for (const path of goneFolders.sort((a, b) => byDepth(b, a))) {
            await this.removeLocalFolderIfEmpty(path);
        }
    }

    /** React to an event on a recorded folder: follow a rename, or take in a deletion. */
    private async followRemoteFolder(
        uid: string,
        paths: Set<string>,
        confirmedAbsent: Set<string>,
        goneFolders: string[],
    ): Promise<void> {
        const record = this.state.getByNodeUid(uid);
        if (!record) {
            return;
        }
        const filesWithin = (folder: string) =>
            this.state.entries().filter((entry) => entry.type === 'file' && isWithin(entry.path, folder));

        const location = await this.tryLocate(uid);
        switch (location?.kind) {
            case 'deleted':
                for (const file of filesWithin(record.path)) {
                    confirmedAbsent.add(file.path);
                    paths.add(file.path);
                }
                this.forgetFolder(record.path);
                goneFolders.push(record.path);
                return;
            case 'outside':
                // Moved out of the synced folder: its files are no longer on
                // Drive as far as this vault is concerned. They are detached,
                // so they go up again into a fresh folder rather than as new
                // revisions into one nobody syncs.
                this.logger.info(`Folder "${record.path}" was moved out of the synced Drive folder; uploading it again`);
                for (const file of filesWithin(record.path)) {
                    this.state.delete(file.path);
                    paths.add(file.path);
                }
                this.forgetFolder(record.path);
                return;
            case 'at':
                if (location.path !== record.path && (await this.followRemoteMove(record.path, location.path, 'folder'))) {
                    for (const file of filesWithin(location.path)) {
                        paths.add(file.path);
                    }
                }
                return;
            default:
                // Could not be located this time; try again on the next poll.
                for (const file of filesWithin(record.path)) {
                    this.retryPaths.add(file.path);
                }
        }
    }

    /**
     * The vault path an event is about, or null when it concerns nothing here.
     *
     * The event feed covers the whole Drive volume, not just the synced
     * folder, so a busy Drive elsewhere - a photo backup, say - produces a
     * steady stream of events for unrelated nodes. Those are recognised by
     * their parent and dropped without a request. A new folder inside the
     * synced one is recorded as soon as it is seen, so that the events for
     * its contents, which come after it, are recognised in turn.
     */
    private async pathForEvent(event: NodeChange): Promise<string | null> {
        const known = this.state.getByNodeUid(event.nodeUid);
        if (known) {
            return known.path;
        }
        if (event.parentNodeUid !== undefined && !this.isKnownFolderUid(event.parentNodeUid)) {
            return null;
        }
        const location = await this.tryLocate(event.nodeUid);
        if (location?.kind !== 'at' || location.path === '') {
            // Deleted before we asked, or outside the synced folder. Either
            // way there is nothing to reconcile.
            return null;
        }
        if (location.node.type === NodeType.Folder) {
            if (!this.filter.isExcludedWithAncestors(location.path)) {
                await this.vault.ensureFolder(location.path);
                this.folderUids.set(location.path, location.node.uid);
                this.state.setSynced(location.path, location.node.uid, 'folder');
            }
            return null;
        }
        return location.path;
    }

    private isKnownFolderUid(uid: string): boolean {
        if (uid === this.rootUid) {
            return true;
        }
        const record = this.state.getByNodeUid(uid);
        return record?.type === 'folder' || [...this.folderUids.values()].includes(uid);
    }

    /**
     * Pick up changes in the config folder.
     *
     * Obsidian raises no vault events for its own config folder, so a changed
     * theme or a newly installed plugin would otherwise wait for the next full
     * sync. Cheap: only size and mtime are compared against the last sync,
     * and nothing is read unless one of them moved.
     */
    private async pollConfigFolder(): Promise<void> {
        const { configDir } = this.scope;
        if (!this.running || !this.settings.autoSync || this.filter.isExcludedWithAncestors(configDir)) {
            return;
        }

        const changed = new Set<string>();
        try {
            const listing = await this.vault.list((path) => !this.filter.isExcluded(path), configDir);
            const present = new Set<string>();
            for (const path of listing.files) {
                if (this.filter.isExcludedWithAncestors(path) || this.vault.isSelfWrite(path)) {
                    continue;
                }
                present.add(path);
                const base = this.state.get(path)?.base;
                const stat = await this.vault.stat(path);
                if (stat && (!base || base.size !== stat.size || base.localMtime !== stat.mtime)) {
                    changed.add(path);
                }
            }
            for (const record of this.state.entries()) {
                if (
                    record.type === 'file' &&
                    isWithin(record.path, configDir) &&
                    !present.has(record.path) &&
                    !this.filter.isExcludedWithAncestors(record.path)
                ) {
                    changed.add(record.path);
                }
            }
        } catch (error) {
            this.logger.debug('Could not scan the config folder', error);
            return;
        }

        if (changed.size > 0) {
            this.logger.debug(`${changed.size} config file(s) changed`);
            await this.processPaths(changed);
        }
    }

    // -- plumbing ----------------------------------------------------------

    private createFilter(settings: PluginSettings): PathFilter {
        return new PathFilter(
            settings.excludePatterns,
            settings.syncObsidianConfig,
            this.scope.configDir,
            this.scope.pluginDir,
        );
    }

    private createResolver(drive: DriveIO, policy: ConflictPolicy, keepConflictCopies?: boolean): ConflictResolver {
        return new ConflictResolver(
            drive,
            {
                policy,
                deviceName: this.settings.deviceName,
                keepConflictCopies: keepConflictCopies ?? this.settings.keepConflictCopies,
            },
            this.logger.getLogger('conflicts'),
        );
    }

    /**
     * The user's policy for notes; a fixed one for the config folder.
     *
     * Conflict copies are the right answer for notes and the wrong one for
     * settings: Obsidian would never read `app (conflict ….json`, and a
     * plugin folder full of them is clutter nobody asked for. A config file
     * that appeared on both sides is almost always a new device joining with
     * its default settings, so Drive's established copy wins; one edited on
     * both sides takes the most recent edit.
     */
    private resolverFor(path: string, reason: ConflictReason): ConflictResolver {
        const override = this.policyOverrides.get(path);
        if (override) {
            return this.createResolver(this.drive!, override);
        }
        if (!this.filter.isConfigPath(path)) {
            return this.resolver!;
        }
        return this.createResolver(this.drive!, reason === 'both-created' ? 'prefer-remote' : 'prefer-newest', false);
    }

    /** The smallest size limit in force on this device, in bytes; Infinity for none. */
    private sizeLimitBytes(): number {
        const limits = [this.settings.maxFileSizeMb];
        if (this.environment.isMobile) {
            limits.push(this.settings.mobileMaxFileSizeMb);
        }
        const active = limits.filter((mb) => mb > 0);
        return active.length === 0 ? Infinity : Math.min(...active) * 1024 * 1024;
    }

    /** Whether the "Wi-Fi only" setting is holding the sync right now. */
    private networkHeld(): boolean {
        return this.settings.wifiOnly && this.environment.isMobile && this.environment.isMetered();
    }

    /** Report progress for a transfer of `total` bytes, if it is large enough to be worth it. */
    private trackTransfer(
        path: string,
        direction: TransferProgress['direction'],
        total: number | undefined,
    ): { onProgress: ((bytes: number) => void) | undefined; end: () => void } {
        if (total === undefined || total < PROGRESS_MIN_BYTES) {
            return { onProgress: undefined, end: () => undefined };
        }
        const key = Symbol(path);
        const entry: TransferProgress = { path, direction, bytes: 0, total };
        this.transfers.set(key, entry);
        return {
            onProgress: (bytes) => {
                entry.bytes = Math.min(bytes, total);
                this.emitChange();
            },
            end: () => {
                this.transfers.delete(key);
                this.emitChange();
            },
        };
    }

    private largestTransfer(): TransferProgress | null {
        let largest: TransferProgress | null = null;
        for (const transfer of this.transfers.values()) {
            if (!largest || transfer.total > largest.total) {
                largest = transfer;
            }
        }
        return largest ? { ...largest } : null;
    }

    /** Hold local settings changes and ask for a reload, if the first sync took settings from Drive. */
    private announceAdoptedSettings(): void {
        const adopted = this.adoptingSettings ?? [];
        this.adoptingSettings = null;
        if (adopted.length === 0) {
            return;
        }
        this.settingsHeld = true;
        this.logger.info(
            `Took ${adopted.length} settings file(s) from Drive; settings changes here are held until Obsidian reloads`,
        );
        this.hooks.onSettingsAdopted?.(adopted.sort((a, b) => a.localeCompare(b)));
    }

    /**
     * Make sure a downloaded list of enabled plugins still includes this one.
     *
     * Obsidian decides which plugins to load from `community-plugins.json`.
     * Taking Drive's copy wholesale, as a joining device does, would switch
     * this plugin off at the next reload whenever that copy lacks it (written
     * before it was installed, say), and with it the sync. Adding it back only
     * ever keeps it on; the corrected list is uploaded by the next pass like
     * any local edit, so Drive's copy stops lacking it.
     */
    private async keepSelfEnabled(path: string): Promise<void> {
        const id = this.scope.pluginId;
        if (!id) {
            return;
        }
        let enabled: unknown;
        try {
            enabled = JSON.parse(await this.vault.readText(path));
        } catch (error) {
            this.logger.warn(`Could not read "${path}" to check this plugin is still enabled`, error);
            return;
        }
        if (!Array.isArray(enabled) || enabled.includes(id)) {
            return;
        }
        enabled.push(id);
        await this.vault.writeBinary(path, new TextEncoder().encode(JSON.stringify(enabled, null, 2)).buffer);
        this.logger.warn(`Drive's list of enabled plugins did not include this one; added it back so syncing stays on`);
    }

    /**
     * Tell the user about a conflict, unless it was in the config folder.
     *
     * Settings files are settled by a fixed rule, Drive's copy when a device
     * joins and the newest edit otherwise, and never leave a copy to look at.
     * A notice for them only reads as something having gone wrong: on a new
     * device every default settings file would be listed as a conflict.
     */
    private reportConflict(event: ConflictEvent): void {
        if (this.filter.isConfigPath(event.path)) {
            this.logger.info(`Settings file "${event.path}" differed on both sides (${event.reason}): ${event.outcome}`);
            return;
        }
        this.hooks.onConflict(event);
    }

    /** Tell the UI about progress, at most once per {@link CHANGE_THROTTLE_MS}. */
    private emitChange(): void {
        if (this.changeTimer !== null) {
            return;
        }
        this.changeTimer = window.setTimeout(() => {
            this.changeTimer = null;
            this.hooks.onChange(this.getSummary());
        }, CHANGE_THROTTLE_MS);
    }

    /** Serialises passes so two of them cannot interleave on the same path. */
    private enqueue(task: () => Promise<void>): Promise<void> {
        this.queue = this.queue.catch(() => undefined).then(task);
        return this.queue;
    }

    private reportFailure(message: string, error: unknown): void {
        this.logger.error(message, error);
        this.lastError = errorMessage(error);
        this.setStatus(isOffline(error) ? 'offline' : 'error');
    }

    private setStatus(status: SyncStatus): void {
        this.status = status === 'idle' && this.paused ? 'paused' : status;
        this.hooks.onChange(this.getSummary());
    }

    // -- read-only views for the UI ----------------------------------------

    /**
     * What a first sync against `rootUid` would do, without doing any of it.
     *
     * Shown before the first sync of a vault with a folder that already holds
     * files, which is the one moment where the user cannot yet know what the
     * plugin is about to change. The local states worked out here are kept for
     * the sync that follows, so it does not hash every file a second time.
     */
    async plan(client: ProtonDriveClient, rootUid: string): Promise<SyncPlan> {
        const drive = new DriveIO(client, this.logger.getLogger('drive'));
        const included = (path: string) => !this.filter.isExcludedWithAncestors(path);
        const [tree, local] = await Promise.all([
            drive.listTree(rootUid, (path) => !this.filter.isExcluded(path)),
            this.vault.list((path) => !this.filter.isExcluded(path)),
        ]);

        const localFiles = local.files.filter(included);
        const remoteFiles = [...tree.files.keys()].filter(included);
        const plan: SyncPlan = {
            localFiles: localFiles.length,
            localNotes: localFiles.filter((path) => !this.filter.isConfigPath(path)).length,
            remoteFiles: remoteFiles.length,
            uploads: [],
            downloads: [],
            conflicts: [],
            settings: [],
            removals: [],
            held: [],
            unchanged: 0,
        };

        const limit = this.sizeLimitBytes();
        const paths = [...new Set([...localFiles, ...remoteFiles])];
        this.plannedLocal.clear();
        await runPooled(
            paths.map((path) => async () => {
                const record = this.state.get(path);
                const localState = await this.vault.getState(path, record?.base);
                if (localState) {
                    this.plannedLocal.set(path, localState);
                }
                const remote = tree.files.get(path);
                if ((localState?.size ?? 0) > limit || (remote?.size ?? 0) > limit) {
                    plan.held.push(path);
                    return;
                }
                const action = reconcile({
                    path,
                    ...(record?.base !== undefined && { base: record.base }),
                    ...(localState !== undefined && { local: localState }),
                    ...(remote !== undefined && { remote }),
                });
                if ((action.type === 'download' || action.type === 'conflict') && this.filter.isConfigPath(path)) {
                    plan.settings.push(path);
                    return;
                }
                switch (action.type) {
                    case 'upload':
                        plan.uploads.push(path);
                        break;
                    case 'download':
                        plan.downloads.push(path);
                        break;
                    case 'conflict':
                        plan.conflicts.push(path);
                        break;
                    case 'delete-local':
                    case 'delete-remote':
                        plan.removals.push(path);
                        break;
                    default:
                        plan.unchanged++;
                }
            }),
            SCAN_CONCURRENCY,
            (error, index) => this.logger.warn(`Could not check "${paths[index]}"`, error),
        );

        for (const list of [plan.uploads, plan.downloads, plan.conflicts, plan.settings, plan.removals, plan.held]) {
            list.sort((a, b) => a.localeCompare(b));
        }
        return plan;
    }

    /**
     * The Drive version of a file, for comparing it with the local one. Null
     * when there is no such file on Drive.
     */
    async readRemoteVersion(path: string, maxBytes: number): Promise<ArrayBuffer | null> {
        const drive = this.drive;
        if (!drive) {
            throw new Error('Not connected to Proton Drive');
        }
        const record = this.state.get(path);
        let remote: RemoteState | undefined;
        if (record?.type === 'file') {
            const node = await drive.getNode(record.nodeUid);
            remote = node.trashTime === undefined ? drive.toRemoteState(node) : undefined;
        }
        remote ??= await this.findByName(path, new Map());
        if (!remote) {
            return null;
        }
        if (remote.size !== undefined && remote.size > maxBytes) {
            throw new Error(`The Drive version is too large to compare (${megabytes(remote.size)} MB)`);
        }
        return drive.downloadFile(remote.nodeUid);
    }
}

/** The settings that decide which paths take part; a change means a full sync. */
function scopeKeyOf(settings: PluginSettings): string {
    return JSON.stringify([settings.syncObsidianConfig, settings.excludePatterns]);
}

function needsTransfer(action: SyncAction): boolean {
    return action.type !== 'noop' && action.type !== 'forget' && action.type !== 'adopt';
}

function megabytes(bytes: number): number {
    return Math.round(bytes / 1024 / 1024);
}

function baseOf(local: LocalState, remoteRevisionUid: string): SyncBase {
    return { hash: local.hash, size: local.size, localMtime: local.mtime, remoteRevisionUid };
}

function byDepth(a: string, b: string): number {
    return a.split('/').length - b.split('/').length || a.localeCompare(b);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Tell "the network is down" apart from a real failure, so a laptop that closed
 * its lid reads as offline rather than broken.
 */
function isOffline(error: unknown): boolean {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        return true;
    }
    const message = errorMessage(error).toLowerCase();
    return (
        message.includes('network') ||
        message.includes('failed to fetch') ||
        message.includes('enotfound') ||
        message.includes('econnrefused') ||
        message.includes('timeout')
    );
}
