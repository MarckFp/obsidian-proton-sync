import type { ReconcileInput, RemoteState, SyncAction, SyncBase } from './types';

/**
 * Decide what a single path needs, from the three states of a classic
 * three-way merge: the common ancestor left by the last successful sync, the
 * current local file, and the current remote node.
 *
 * Pure and total — no I/O, no clock, no configuration. Everything the engine
 * does to the vault and to Drive flows from this function, so the awkward cases
 * (a device that was offline for a week, a file deleted on one side and edited
 * on the other, two devices that happened to write the same bytes) are decided
 * in one place that can be exhaustively tested.
 *
 * It never resolves a conflict, only reports one; choosing between the two
 * versions is policy, and lives in `conflicts.ts`.
 */
export function reconcile({ base, local, remote }: ReconcileInput): SyncAction {
    // Neither side has the path. Either nothing to do, or a record to drop.
    if (!local && !remote) {
        return base ? { type: 'forget' } : { type: 'noop' };
    }

    // No common ancestor: the path is new to the sync, on one side or both.
    if (!base) {
        if (local && remote) {
            // Both devices produced this path independently — the usual cause
            // is two clients doing their first sync of the same vault. Identical
            // bytes are a coincidence worth taking: pair them up, transfer
            // nothing. Differing bytes are a real conflict, with no ancestor to
            // merge against.
            return sameContent(local.hash, remote)
                ? { type: 'adopt', nodeUid: remote.nodeUid, revisionUid: remote.revisionUid }
                : { type: 'conflict', reason: 'both-created' };
        }
        if (local) {
            return { type: 'upload', reason: 'created' };
        }
        return {
            type: 'download',
            reason: 'created',
            nodeUid: remote!.nodeUid,
            revisionUid: remote!.revisionUid,
        };
    }

    const localChanged = local ? local.hash !== base.hash : false;
    const remoteChanged = remote ? hasRemoteMoved(base, remote) : false;

    // One side is gone. Deleting the other side is only safe if it has not been
    // touched since the ancestor — otherwise the deletion would discard edits
    // the user never saw on the deleting device.
    if (!remote) {
        return localChanged
            ? { type: 'conflict', reason: 'deleted-remotely-modified-locally' }
            : { type: 'delete-local' };
    }
    if (!local) {
        return remoteChanged
            ? { type: 'conflict', reason: 'deleted-locally-modified-remotely' }
            : { type: 'delete-remote', nodeUid: remote.nodeUid };
    }

    if (!localChanged && !remoteChanged) {
        // Content agrees. The revision uid can still be stale — another client
        // may have re-uploaded identical bytes — and leaving it stale would
        // make every later cycle fall back to comparing digests. Refresh it so
        // the ancestor always matches what was last observed.
        return remote.revisionUid === base.remoteRevisionUid
            ? { type: 'noop' }
            : { type: 'adopt', nodeUid: remote.nodeUid, revisionUid: remote.revisionUid };
    }
    if (localChanged && !remoteChanged) {
        return { type: 'upload', reason: 'modified' };
    }
    if (!localChanged && remoteChanged) {
        // The remote moved to a new revision. If it carries the bytes we already
        // have, only the bookkeeping is stale.
        return sameContent(local.hash, remote)
            ? { type: 'adopt', nodeUid: remote.nodeUid, revisionUid: remote.revisionUid }
            : {
                  type: 'download',
                  reason: 'modified',
                  nodeUid: remote.nodeUid,
                  revisionUid: remote.revisionUid,
              };
    }

    // Both sides moved. Converging on the same bytes is not a conflict.
    return sameContent(local.hash, remote)
        ? { type: 'adopt', nodeUid: remote.nodeUid, revisionUid: remote.revisionUid }
        : { type: 'conflict', reason: 'both-modified' };
}

/**
 * Whether the remote node has changed since the ancestor was recorded.
 *
 * A new revision uid is the authoritative signal — every upload, by any client,
 * produces one. The extra hash check keeps a re-upload of byte-identical
 * content from being reported as a change, which matters because Proton Drive
 * gains a revision whenever a client saves, not only when content differs.
 * Clients that record no digest leave only the revision uid to go on.
 */
function hasRemoteMoved(base: SyncBase, remote: RemoteState): boolean {
    if (remote.revisionUid === base.remoteRevisionUid) {
        return false;
    }
    if (remote.hash) {
        return remote.hash !== base.hash;
    }
    return true;
}

/**
 * Compare local bytes against the remote revision.
 *
 * Returns false when the revision carries no digest: claiming equality without
 * evidence risks discarding a real edit, and the cost of being wrong the other
 * way is only a redundant transfer or a conflict copy.
 */
function sameContent(localHash: string, remote: RemoteState): boolean {
    return remote.hash !== undefined && remote.hash === localHash;
}
