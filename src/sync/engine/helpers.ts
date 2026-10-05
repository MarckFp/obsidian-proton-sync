import type { PluginSettings } from '../../settings';
import type { RemoteTree } from '../drive';
import { isWithin, replacePrefix } from '../paths';
import type { LocalState, RemoteState, SyncAction, SyncBase } from '../types';

/** Small pure helpers the engine's modules share. */

/** The settings that decide which paths take part; a change means a full sync. */
export function scopeKeyOf(settings: PluginSettings): string {
    return JSON.stringify([settings.syncObsidianConfig, settings.excludePatterns]);
}

/** Bytes an action moves, as far as known, to weigh it in the progress bar. */
export function transferSize(action: SyncAction, local: LocalState | undefined, remote: RemoteState | undefined): number {
    switch (action.type) {
        case 'upload':
            return local?.size ?? 0;
        case 'download':
            return remote?.size ?? 0;
        case 'conflict':
            return Math.max(local?.size ?? 0, remote?.size ?? 0);
        default:
            return 0;
    }
}

export function needsTransfer(action: SyncAction): boolean {
    return action.type !== 'noop' && action.type !== 'forget' && action.type !== 'adopt';
}

/** "45 s", "3 min", "1 h": how long until a retry. */
export function formatWait(ms: number): string {
    const seconds = Math.ceil(ms / 1000);
    if (seconds < 60) {
        return `${seconds} s`;
    }
    const minutes = Math.round(seconds / 60);
    return minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

export function megabytes(bytes: number): number {
    return Math.round(bytes / 1024 / 1024);
}

export function baseOf(local: LocalState, remoteRevisionUid: string): SyncBase {
    return { hash: local.hash, size: local.size, localMtime: local.mtime, remoteRevisionUid };
}

/** Re-key everything at or below `from` in a listed tree to `to`, after renaming it on Drive. */
export function renameInTree(tree: RemoteTree, from: string, to: string): void {
    for (const map of [tree.files, tree.folders] as Map<string, unknown>[]) {
        for (const [path, value] of [...map]) {
            if (isWithin(path, from)) {
                map.delete(path);
                map.set(replacePrefix(path, from, to), value);
            }
        }
    }
    for (const [uid, path] of tree.nodePaths) {
        if (isWithin(path, from)) {
            tree.nodePaths.set(uid, replacePrefix(path, from, to));
        }
    }
}

export function byDepth(a: string, b: string): number {
    return a.split('/').length - b.split('/').length || a.localeCompare(b);
}

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Tell "the network is down" apart from a real failure, so a laptop that closed
 * its lid reads as offline rather than broken.
 */
export function isOffline(error: unknown): boolean {
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
