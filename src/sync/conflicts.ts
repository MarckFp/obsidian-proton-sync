import type { Logger } from '../util/logger';
import type { DriveIO } from './drive';
import { mediaTypeOf } from './media';
import { mergeThreeWay } from './merge';
import { conflictCopyPath } from './paths';
import type { ConflictPolicy, ConflictReason, LocalState, RemoteState, SyncBase } from './types';

export type ConflictContext = {
    path: string;
    reason: ConflictReason;
    base?: SyncBase;
    local?: LocalState;
    remote?: RemoteState;
    /** Reads the local file's text, called only when a merge is attempted. */
    readLocalText: () => Promise<string>;
};

export type Resolution =
    /** Push the local copy; the remote one is superseded. */
    | { action: 'take-local' }
    /** Pull the remote copy; the local one is superseded. */
    | { action: 'take-remote' }
    /** Write these merged bytes locally, then upload them. */
    | { action: 'take-merged'; content: ArrayBuffer }
    /**
     * Keep both versions. `keepAtPath` says which one stays under the original
     * name; the other is written to `copyPath` beside it. Both are then synced,
     * so every device ends up holding the pair.
     */
    | { action: 'keep-both'; keepAtPath: 'local' | 'remote'; copyPath: string }
    /** Leave the file alone and wait for the user. */
    | { action: 'defer'; note: string };

export type ResolverOptions = {
    policy: ConflictPolicy;
    deviceName: string;
    keepConflictCopies: boolean;
};

/**
 * Turns a detected conflict into a concrete plan.
 *
 * `reconcile` deliberately stops at "these two versions disagree"; this is
 * where the user's policy is applied. The engine performs the resulting file
 * operations, so everything here is either a decision or the content work a
 * decision needs.
 *
 * The bias throughout is that no version of the user's text disappears without
 * them having asked for that: the default policy keeps both copies, and every
 * other policy that discards a side is honoured only because it was chosen
 * explicitly.
 */
export class ConflictResolver {
    constructor(
        private readonly drive: DriveIO,
        private readonly options: ResolverOptions,
        private readonly logger: Logger,
        private readonly now: () => Date = () => new Date(),
    ) {}

    async resolve(context: ConflictContext): Promise<Resolution> {
        const { policy } = this.options;

        // A conflict between an edit and a deletion is not a choice between two
        // versions of the text — one side has no text at all. Merging is
        // meaningless and keeping "both" would just recreate the file, so the
        // surviving edit always wins, whatever the policy. The deletion can be
        // repeated; the lost edit cannot be recovered.
        if (context.reason === 'deleted-remotely-modified-locally') {
            this.logger.info(`"${context.path}" was deleted elsewhere but edited here; keeping the local edit`);
            return { action: 'take-local' };
        }
        if (context.reason === 'deleted-locally-modified-remotely') {
            this.logger.info(`"${context.path}" was deleted here but edited elsewhere; restoring the remote edit`);
            return { action: 'take-remote' };
        }

        switch (policy) {
            case 'manual':
                return { action: 'defer', note: 'Waiting for you to choose a version' };

            case 'prefer-local':
                return this.oneSided('local', context);

            case 'prefer-remote':
                return this.oneSided('remote', context);

            case 'prefer-newest':
                return this.byModificationTime(context);

            case 'merge': {
                const merged = await this.tryMerge(context);
                if (merged) {
                    return merged;
                }
                return this.keepBoth(context);
            }

            case 'keep-both':
            default:
                return this.keepBoth(context);
        }
    }

    /**
     * A one-sided policy: the chosen side takes the original filename. Unless
     * the user turned copies off, the other side is kept beside it, which makes
     * `prefer-*` a statement about which version they want to keep opening, not
     * a setting that throws work away.
     */
    private oneSided(winner: 'local' | 'remote', context: ConflictContext): Resolution {
        if (!this.options.keepConflictCopies) {
            return { action: winner === 'local' ? 'take-local' : 'take-remote' };
        }
        return this.keepBoth(context, winner);
    }

    private byModificationTime(context: ConflictContext): Resolution {
        const localTime = context.local?.mtime;
        const remoteTime = context.remote?.mtime;

        if (localTime === undefined || remoteTime === undefined) {
            // Drive only carries a modification time if the uploading client
            // recorded one. With nothing to compare, fall back to keeping both
            // rather than picking arbitrarily.
            this.logger.info(`"${context.path}": no comparable modification times, keeping both versions`);
            return this.keepBoth(context);
        }
        if (localTime === remoteTime) {
            return this.keepBoth(context);
        }
        return localTime > remoteTime ? this.oneSided('local', context) : this.oneSided('remote', context);
    }

    /**
     * Try to reconcile the two versions line by line.
     *
     * Needs the common ancestor, which is not stored locally but is still on
     * Drive as the revision the last sync recorded. When that revision has been
     * pruned, or either side is binary, or the edits overlap, this returns null
     * and the caller keeps both copies instead.
     */
    private async tryMerge(context: ConflictContext): Promise<Resolution | null> {
        const { base, local, remote, path } = context;
        if (!base || !remote || !isMergeable(path, local, remote)) {
            return null;
        }

        let baseText: string;
        let remoteText: string;
        let localText: string;
        try {
            const [baseBytes, remoteBytes] = await Promise.all([
                this.drive.downloadRevision(base.remoteRevisionUid),
                this.drive.downloadFile(remote.nodeUid),
            ]);
            baseText = decodeUtf8(baseBytes);
            remoteText = decodeUtf8(remoteBytes);
            localText = await context.readLocalText();
        } catch (error) {
            this.logger.info(`Could not fetch the common ancestor of "${path}" to merge it`, error);
            return null;
        }

        const result = mergeThreeWay(baseText, localText, remoteText);
        if (!result.merged) {
            this.logger.info(`Could not merge "${path}" (${result.reason}); keeping both versions`);
            return null;
        }

        this.logger.info(`Merged concurrent edits to "${path}"`);
        return { action: 'take-merged', content: new TextEncoder().encode(result.text).buffer as ArrayBuffer };
    }

    /**
     * Local keeps the original filename by default: it is the version the user
     * may have open in an editor right now, and having it replaced underneath
     * them is the one outcome that feels like the plugin lost their work even
     * when nothing was lost.
     */
    private keepBoth(context: ConflictContext, keepAtPath: 'local' | 'remote' = 'local'): Resolution {
        return {
            action: 'keep-both',
            keepAtPath,
            copyPath: conflictCopyPath(context.path, this.options.deviceName, this.now()),
        };
    }
}

/** Above this, a merge is declined before anything is downloaded. */
const MAX_MERGE_BYTES = 4 * 1024 * 1024;

/**
 * Only text is worth fetching two revisions of to attempt a merge. An image or
 * a video would be downloaded twice, decoded as text, and declined anyway.
 */
function isMergeable(path: string, local: LocalState | undefined, remote: RemoteState): boolean {
    const mediaType = mediaTypeOf(path);
    const isText =
        mediaType.startsWith('text/') || mediaType === 'application/json' || mediaType === 'application/xml';
    return isText && (local?.size ?? 0) <= MAX_MERGE_BYTES && (remote.size ?? 0) <= MAX_MERGE_BYTES;
}

function decodeUtf8(data: ArrayBuffer): string {
    return new TextDecoder('utf-8', { fatal: false }).decode(data);
}
