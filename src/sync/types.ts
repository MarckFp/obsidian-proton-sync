/** Content digest plus the cheap stat fields used to avoid recomputing it. */
export type ContentStamp = {
    /** SHA-1 of the file's bytes, lowercase hex. */
    hash: string;
    size: number;
    /** Local filesystem mtime in epoch milliseconds. */
    mtime: number;
};

/**
 * What the last successful sync of a path left behind: the common ancestor
 * against which the next local and remote states are compared.
 *
 * This is what makes offline editing safe. Without a base, a device coming back
 * online can only see "local differs from remote" and has to guess which side
 * moved; with it, each side is independently classified as changed or unchanged,
 * and only a genuine double-edit is reported as a conflict.
 */
export type SyncBase = {
    hash: string;
    size: number;
    /** Local mtime at the moment of sync; a fast path for "definitely unchanged". */
    localMtime: number;
    /** Revision the remote was on. Changes on every new upload, by any device. */
    remoteRevisionUid: string;
};

export type SyncRecord = {
    /** Vault-relative path, `/`-separated, no leading slash. */
    path: string;
    nodeUid: string;
    type: 'file' | 'folder';
    base?: SyncBase;
};

/**
 * A conflict the `manual` policy left for the user.
 *
 * Tracked by path, separately from sync records: a path created independently
 * on two devices conflicts before either side has a record.
 */
export type ConflictInfo = {
    detectedAt: number;
    reason: ConflictReason;
};

export type ConflictReason =
    /** Both sides edited the file since the last sync. */
    | 'both-modified'
    /** The file appeared independently on both sides with different content. */
    | 'both-created'
    /** One side deleted the file while the other edited it. */
    | 'deleted-remotely-modified-locally'
    | 'deleted-locally-modified-remotely';

/** Local view of a path at reconcile time; `undefined` means it does not exist. */
export type LocalState = ContentStamp;

/** Remote view of a path at reconcile time; `undefined` means it does not exist. */
export type RemoteState = {
    nodeUid: string;
    revisionUid: string;
    /**
     * SHA-1 the uploading client recorded in the revision's extended
     * attributes. Absent for files uploaded by clients that did not record one,
     * in which case size and modification time are the only cheap signals.
     */
    hash?: string;
    size?: number;
    /** Claimed filesystem modification time, if the uploader recorded one. */
    mtime?: number;
};

export type ReconcileInput = {
    path: string;
    base?: SyncBase;
    local?: LocalState;
    remote?: RemoteState;
};

export type SyncAction =
    /** Nothing to do; the two sides already agree. */
    | { type: 'noop' }
    /**
     * Both sides already hold the same bytes but no base recorded it. Adopt the
     * pairing and write a base, transferring nothing.
     */
    | { type: 'adopt'; nodeUid: string; revisionUid: string }
    | { type: 'upload'; reason: 'created' | 'modified' }
    | { type: 'download'; reason: 'created' | 'modified'; nodeUid: string; revisionUid: string }
    | { type: 'delete-local' }
    | { type: 'delete-remote'; nodeUid: string }
    /** The record refers to a path that no longer exists on either side. */
    | { type: 'forget' }
    | { type: 'conflict'; reason: ConflictReason };

export type ConflictPolicy =
    /** Keep both versions: local stays put, the remote copy lands beside it. */
    | 'keep-both'
    /** Attempt a line-level three-way merge, falling back to `keep-both`. */
    | 'merge'
    | 'prefer-local'
    | 'prefer-remote'
    /** Whichever side has the newer modification time wins. */
    | 'prefer-newest'
    /** Touch nothing; record the conflict and wait for the user. */
    | 'manual';
