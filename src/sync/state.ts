import type { DataAdapter } from 'obsidian';

import type { Logger } from '../util/logger';
import { isWithin, replacePrefix } from './paths';
import type { ConflictInfo, SyncBase, SyncRecord } from './types';

const STATE_VERSION = 1;

type StateFile = {
    version: number;
    /** Account the state belongs to; a different one invalidates every record. */
    accountEmail: string | null;
    /** Drive folder the state was built against. */
    remoteFolderUid: string | null;
    records: Record<string, SyncRecord>;
    /**
     * Unresolved conflicts, keyed by path.
     *
     * Kept apart from `records` because the two do not always coexist: a path
     * created independently on both devices conflicts before either side has
     * ever been synced, so there is no record to hang it on.
     */
    conflicts: Record<string, ConflictInfo>;
    /** Last processed Drive event id, per tree event scope. */
    eventCursors: Record<string, string>;
    /** Paths a pass could not settle, to try again; see {@link SyncState.retry}. Absent in files from older versions. */
    retries?: Record<string, RetryInfo>;
    /** When the last full sync finished, in epoch ms. */
    lastFullSyncAt?: number | null;
};

type RetryInfo = { attempts: number; after: number };

/** Waits between retries of one path after the first: 30 s, doubling, at most an hour. */
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 60 * 60_000;

/**
 * The sync's memory between sessions: for every path, what local and remote
 * last agreed on.
 *
 * This is the merge base from `reconcile`, so losing it is not fatal but is
 * expensive — without it every path falls back to the "no common ancestor"
 * rules, where anything that differs becomes a conflict instead of a one-sided
 * change, and deletions made since the last sync come back. It is tied to the
 * account and folder it describes, so that pointing the plugin somewhere new
 * starts clean rather than reconciling against a stranger's tree.
 *
 * It is written so that a crash, a killed mobile app or a full disk can never
 * leave only a torn copy: the new state goes to `<file>.tmp`, the current file
 * becomes `<file>.bak`, and only then does the new one take its name. Loading
 * tries the file, then the temporary file (a write that finished but was not
 * yet moved into place), then the backup. Only when copies exist and none can
 * be read is the state reported lost, see {@link SyncState.wasLost}, rather
 * than quietly started afresh.
 *
 * Writes are coalesced: a full sync touches thousands of records and each one
 * would otherwise rewrite the file.
 */
export class SyncState {
    private records = new Map<string, SyncRecord>();
    private nodeUidToPath = new Map<string, string>();
    private unresolvedConflicts = new Map<string, ConflictInfo>();
    private eventCursors = new Map<string, string>();
    private retries = new Map<string, RetryInfo>();
    private lastFullSyncAt: number | null = null;
    private accountEmail: string | null = null;
    private remoteFolderUid: string | null = null;

    private lost = false;
    private dirty = false;
    private flushTimer: number | null = null;
    private writing: Promise<void> = Promise.resolve();

    constructor(
        private readonly adapter: DataAdapter,
        private readonly filePath: string,
        private readonly logger: Logger,
        /** Called after each save, so what must agree with the state (the Drive cache) is saved with it. */
        private readonly afterFlush: () => void = () => undefined,
    ) {}

    /**
     * Where in Drive's event feed this state stands, as one string: what the
     * saved Drive cache is checked against, since the cache is only current up
     * to the events it has seen.
     */
    cursorsFingerprint(): string {
        return JSON.stringify([...this.eventCursors].sort(([a], [b]) => a.localeCompare(b)));
    }

    private get tempPath(): string {
        return `${this.filePath}.tmp`;
    }

    private get backupPath(): string {
        return `${this.filePath}.bak`;
    }

    /**
     * Whether the last `load` found a saved state but could read none of its
     * copies. The state is empty then, as for a first sync, but the user had
     * one, and should hear about it before a sync runs on the assumption that
     * nothing was ever synced.
     */
    wasLost(): boolean {
        return this.lost;
    }

    async load(accountEmail: string | null, remoteFolderUid: string | null): Promise<void> {
        this.records.clear();
        this.nodeUidToPath.clear();
        this.unresolvedConflicts.clear();
        this.eventCursors.clear();
        this.retries.clear();
        this.lastFullSyncAt = null;
        this.accountEmail = accountEmail;
        this.remoteFolderUid = remoteFolderUid;

        this.lost = false;

        let file: StateFile | null = null;
        let found = false;
        for (const candidate of [this.filePath, this.tempPath, this.backupPath]) {
            if (!(await this.adapter.exists(candidate))) {
                continue;
            }
            found = true;
            file = await this.readCandidate(candidate);
            if (file) {
                if (candidate !== this.filePath) {
                    this.logger.warn(`The sync state file was unreadable; recovered it from "${candidate}"`);
                }
                break;
            }
        }
        if (!file) {
            if (found) {
                this.lost = true;
                this.logger.error('Could not read any copy of the sync state; this device has to compare everything afresh');
            }
            return;
        }

        if (file.version !== STATE_VERSION) {
            this.logger.info(`Discarding sync state written by another version (${file.version})`);
            return;
        }
        if (file.accountEmail !== accountEmail || file.remoteFolderUid !== remoteFolderUid) {
            this.logger.info('Sync state belongs to a different account or folder; starting fresh');
            return;
        }

        for (const [path, record] of Object.entries(file.records ?? {})) {
            this.records.set(path, record);
            this.nodeUidToPath.set(record.nodeUid, path);
        }
        for (const [path, conflict] of Object.entries(file.conflicts ?? {})) {
            this.unresolvedConflicts.set(path, conflict);
        }
        for (const [scope, eventId] of Object.entries(file.eventCursors ?? {})) {
            this.eventCursors.set(scope, eventId);
        }
        for (const [path, retry] of Object.entries(file.retries ?? {})) {
            this.retries.set(path, retry);
        }
        this.lastFullSyncAt = typeof file.lastFullSyncAt === 'number' ? file.lastFullSyncAt : null;
        this.logger.debug(`Loaded sync state for ${this.records.size} paths`);
    }

    /** A copy of the state file, or null if it is torn, empty or not what this class writes. */
    private async readCandidate(path: string): Promise<StateFile | null> {
        try {
            const file = JSON.parse(await this.adapter.read(path)) as Partial<StateFile> | null;
            if (file && typeof file.version === 'number' && typeof file.records === 'object' && file.records !== null) {
                return file as StateFile;
            }
            this.logger.warn(`"${path}" is not a sync state file`);
        } catch (error) {
            this.logger.warn(`Could not read "${path}"`, error);
        }
        return null;
    }

    get(path: string): SyncRecord | undefined {
        return this.records.get(path);
    }

    getByNodeUid(nodeUid: string): SyncRecord | undefined {
        const path = this.nodeUidToPath.get(nodeUid);
        return path === undefined ? undefined : this.records.get(path);
    }

    paths(): string[] {
        return [...this.records.keys()];
    }

    entries(): SyncRecord[] {
        return [...this.records.values()];
    }

    /** Paths waiting on a decision, with why. */
    conflicts(): { path: string; conflict: ConflictInfo }[] {
        return [...this.unresolvedConflicts].map(([path, conflict]) => ({ path, conflict }));
    }

    isConflicted(path: string): boolean {
        return this.unresolvedConflicts.has(path);
    }

    set(record: SyncRecord): void {
        const previous = this.records.get(record.path);
        if (previous && previous.nodeUid !== record.nodeUid) {
            this.nodeUidToPath.delete(previous.nodeUid);
        }
        this.records.set(record.path, record);
        this.nodeUidToPath.set(record.nodeUid, record.path);
        this.markDirty();
    }

    /** Record a completed sync of a path: the new common ancestor. */
    setSynced(path: string, nodeUid: string, type: 'file' | 'folder', base?: SyncBase): void {
        const record: SyncRecord = { path, nodeUid, type, ...(base !== undefined && { base }) };
        this.set(record);
    }

    setConflict(path: string, conflict: ConflictInfo): void {
        this.unresolvedConflicts.set(path, conflict);
        this.markDirty();
    }

    clearConflict(path: string): void {
        if (this.unresolvedConflicts.delete(path)) {
            this.markDirty();
        }
    }

    delete(path: string): void {
        const record = this.records.get(path);
        if (!record) {
            return;
        }
        this.records.delete(path);
        // State written by older versions can hold two records for one node;
        // dropping one must not orphan the other's lookup.
        if (this.nodeUidToPath.get(record.nodeUid) === path) {
            this.nodeUidToPath.delete(record.nodeUid);
        }
        this.markDirty();
    }

    /** Move a record with the vault path it describes, keeping the node uid. */
    rename(fromPath: string, toPath: string): void {
        const record = this.records.get(fromPath);
        if (!record) {
            return;
        }
        this.records.delete(fromPath);
        record.path = toPath;
        this.records.set(toPath, record);
        this.nodeUidToPath.set(record.nodeUid, toPath);

        const conflict = this.unresolvedConflicts.get(fromPath);
        if (conflict) {
            this.unresolvedConflicts.delete(fromPath);
            this.unresolvedConflicts.set(toPath, conflict);
        }
        const retry = this.retries.get(fromPath);
        if (retry) {
            this.retries.delete(fromPath);
            this.retries.set(toPath, retry);
        }
        this.markDirty();
    }

    /**
     * Move a folder's record and everything recorded beneath it.
     *
     * A folder rename is one operation on Drive, so it has to be one operation
     * here too; renaming the children one by one would leave a window where
     * some records point into a folder that no longer exists under that name.
     */
    renameFolder(fromPath: string, toPath: string): void {
        const moved = [...this.records.keys()].filter((path) => isWithin(path, fromPath));
        for (const path of moved) {
            this.rename(path, replacePrefix(path, fromPath, toPath));
        }
        for (const path of [...this.unresolvedConflicts.keys()]) {
            if (isWithin(path, fromPath)) {
                const conflict = this.unresolvedConflicts.get(path)!;
                this.unresolvedConflicts.delete(path);
                this.unresolvedConflicts.set(replacePrefix(path, fromPath, toPath), conflict);
                this.markDirty();
            }
        }
        for (const path of [...this.retries.keys()]) {
            if (isWithin(path, fromPath)) {
                const retry = this.retries.get(path)!;
                this.retries.delete(path);
                this.retries.set(replacePrefix(path, fromPath, toPath), retry);
                this.markDirty();
            }
        }
    }

    /**
     * Note a path to try again, saved with the rest of the state.
     *
     * Kept here rather than in memory because the event that named the path
     * is behind the saved event cursor once the poll that failed has finished:
     * a retry list lost to a restart, which on mobile is often, would leave the
     * change unapplied until the next full sync. The first retry is immediate;
     * after that each failure doubles the wait, so a path that cannot be settled (a name this filesystem refuses, a file
     * locked for days) is retried rarely instead of on every poll. `backoff:
     * false` queues it for the next pass without counting a failure, for a
     * path that was merely held back, by the Wi-Fi setting, say.
     */
    retry(path: string, { backoff = true }: { backoff?: boolean } = {}, now = Date.now()): void {
        const previous = this.retries.get(path);
        const attempts = (previous?.attempts ?? 0) + (backoff ? 1 : 0);
        // The first retry goes with the next poll, as a one-off glitch
        // deserves; only a path that keeps failing starts to wait.
        const wait = backoff && attempts > 1 ? Math.min(RETRY_BASE_MS * 2 ** (attempts - 2), RETRY_MAX_MS) : 0;
        this.retries.set(path, { attempts, after: now + wait });
        this.markDirty();
    }

    /** Paths whose wait has passed. */
    dueRetries(now = Date.now()): string[] {
        return [...this.retries].filter(([, retry]) => retry.after <= now).map(([path]) => path);
    }

    /** All queued retries, due or not. */
    pendingRetries(): string[] {
        return [...this.retries.keys()];
    }

    /** Queued retries with how often each has failed, and when it is next due. */
    retryEntries(): { path: string; attempts: number; after: number }[] {
        return [...this.retries].map(([path, retry]) => ({ path, ...retry }));
    }

    clearRetry(path: string): void {
        if (this.retries.delete(path)) {
            this.markDirty();
        }
    }

    /** After a full sync, which settles everything it could. */
    clearRetries(): void {
        if (this.retries.size > 0) {
            this.retries.clear();
            this.markDirty();
        }
    }

    getLastFullSync(): number | null {
        return this.lastFullSyncAt;
    }

    setLastFullSync(time: number): void {
        this.lastFullSyncAt = time;
        this.markDirty();
    }

    getEventCursor(treeEventScopeId: string): string | null {
        return this.eventCursors.get(treeEventScopeId) ?? null;
    }

    setEventCursor(treeEventScopeId: string, eventId: string): void {
        if (this.eventCursors.get(treeEventScopeId) === eventId) {
            return;
        }
        this.eventCursors.set(treeEventScopeId, eventId);
        this.markDirty();
    }

    /** Drop everything, so the next sync rebuilds from both sides. */
    async reset(): Promise<void> {
        this.records.clear();
        this.nodeUidToPath.clear();
        this.unresolvedConflicts.clear();
        this.eventCursors.clear();
        this.retries.clear();
        this.lastFullSyncAt = null;
        this.lost = false;
        this.markDirty();
        await this.flush();
        // A deliberate reset must not come back from the backup if the new
        // file were ever unreadable.
        try {
            if (await this.adapter.exists(this.backupPath)) {
                await this.adapter.remove(this.backupPath);
            }
        } catch (error) {
            this.logger.warn('Could not remove the previous sync state backup', error);
        }
    }

    async flush(): Promise<void> {
        if (this.flushTimer !== null) {
            window.clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        if (!this.dirty) {
            return this.writing;
        }
        this.dirty = false;

        const file: StateFile = {
            version: STATE_VERSION,
            accountEmail: this.accountEmail,
            remoteFolderUid: this.remoteFolderUid,
            records: Object.fromEntries(this.records),
            conflicts: Object.fromEntries(this.unresolvedConflicts),
            eventCursors: Object.fromEntries(this.eventCursors),
            retries: Object.fromEntries(this.retries),
            lastFullSyncAt: this.lastFullSyncAt,
        };

        // Serialise writes so a slow flush cannot be overtaken by a later one
        // and leave the older state on disk.
        this.writing = this.writing
            .catch(() => undefined)
            .then(() => this.writeAtomically(JSON.stringify(file)))
            .then(() => this.afterFlush())
            .catch((error: unknown) => {
                this.logger.error('Failed to write sync state', error);
                // Put the change back so the next flush retries it.
                this.dirty = true;
            });

        return this.writing;
    }

    /**
     * Replace the state file without ever leaving only a partial one: write
     * the new copy beside it, keep the current one as the backup, then move
     * the new one into place. Renames never land on an existing file, which
     * not every platform's adapter allows.
     */
    private async writeAtomically(text: string): Promise<void> {
        await this.adapter.write(this.tempPath, text);
        if (await this.adapter.exists(this.backupPath)) {
            await this.adapter.remove(this.backupPath);
        }
        if (await this.adapter.exists(this.filePath)) {
            await this.adapter.rename(this.filePath, this.backupPath);
        }
        await this.adapter.rename(this.tempPath, this.filePath);
    }

    private markDirty(): void {
        this.dirty = true;
        if (this.flushTimer !== null) {
            return;
        }
        this.flushTimer = window.setTimeout(() => {
            this.flushTimer = null;
            void this.flush();
        }, 1000);
    }
}
