import type { DataAdapter } from 'obsidian';

import type { Logger } from '../util/logger';
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
};

/**
 * The sync's memory between sessions: for every path, what local and remote
 * last agreed on.
 *
 * This is the merge base from `reconcile`, so losing it is not fatal but is
 * expensive — without it every path falls back to the "no common ancestor"
 * rules, where anything that differs becomes a conflict instead of a one-sided
 * change. It is therefore written whole, atomically, and tied to the account
 * and folder it describes so that pointing the plugin somewhere new starts
 * clean rather than reconciling against a stranger's tree.
 *
 * Writes are coalesced: a full sync touches thousands of records and each one
 * would otherwise rewrite the file.
 */
export class SyncState {
    private records = new Map<string, SyncRecord>();
    private nodeUidToPath = new Map<string, string>();
    private unresolvedConflicts = new Map<string, ConflictInfo>();
    private eventCursors = new Map<string, string>();
    private accountEmail: string | null = null;
    private remoteFolderUid: string | null = null;

    private dirty = false;
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private writing: Promise<void> = Promise.resolve();

    constructor(
        private readonly adapter: DataAdapter,
        private readonly filePath: string,
        private readonly logger: Logger,
    ) {}

    async load(accountEmail: string | null, remoteFolderUid: string | null): Promise<void> {
        this.records.clear();
        this.nodeUidToPath.clear();
        this.unresolvedConflicts.clear();
        this.eventCursors.clear();
        this.accountEmail = accountEmail;
        this.remoteFolderUid = remoteFolderUid;

        if (!(await this.adapter.exists(this.filePath))) {
            return;
        }

        try {
            const file = JSON.parse(await this.adapter.read(this.filePath)) as StateFile;

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
            this.logger.debug(`Loaded sync state for ${this.records.size} paths`);
        } catch (error) {
            this.logger.error('Failed to read sync state; starting fresh', error);
            this.records.clear();
            this.nodeUidToPath.clear();
            this.unresolvedConflicts.clear();
            this.eventCursors.clear();
        }
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
        this.nodeUidToPath.delete(record.nodeUid);
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
        this.markDirty();
        await this.flush();
    }

    async flush(): Promise<void> {
        if (this.flushTimer !== null) {
            clearTimeout(this.flushTimer);
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
        };

        // Serialise writes so a slow flush cannot be overtaken by a later one
        // and leave the older state on disk.
        this.writing = this.writing
            .catch(() => undefined)
            .then(() => this.adapter.write(this.filePath, JSON.stringify(file)))
            .catch((error: unknown) => {
                this.logger.error('Failed to write sync state', error);
                // Put the change back so the next flush retries it.
                this.dirty = true;
            });

        return this.writing;
    }

    private markDirty(): void {
        this.dirty = true;
        if (this.flushTimer !== null) {
            return;
        }
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            void this.flush();
        }, 1000);
    }
}
