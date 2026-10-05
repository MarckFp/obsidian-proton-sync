import type { Logger } from '../../util/logger';
import type { RemoteTree } from '../drive';
import type { PathFilter } from '../paths';
import type { SyncState } from '../state';
import type { LocalState } from '../types';
import type { VaultIO } from '../vault';

/** What rename detection needs from the engine. */
export type LocalRenameHost = {
    readonly state: SyncState;
    filter(): PathFilter;
    readonly vault: VaultIO;
    /** Local states already worked out in this pass, for the reconcile to reuse. */
    readonly plannedLocal: Map<string, LocalState>;
    moveRemoteNode(nodeUid: string, toPath: string): Promise<void>;
    readonly logger: Logger;
};

/**
 * Find renames made in the vault that Drive has not seen, by content, and
 * carry them over as renames.
 *
 * The rename event is the usual way a rename reaches Drive, but it is lost
 * whenever the engine is not watching when it happens, when Obsidian
 * closes before it is applied, or when the file is moved outside Obsidian,
 * where there is no event at all. Left to the reconcile, such a rename
 * reads as a deletion plus a new file: the Drive node is trashed with its
 * revision history, the content is uploaded again, and every other device
 * deletes and downloads instead of moving.
 *
 * A recorded file that is gone from the vault, and a file nobody has a
 * record of with exactly the same content, are the same file. They are
 * paired only when that is unambiguous: one of each for the content (two
 * empty notes, or two copies of one template, could be either), and the
 * Drive node still on the revision the last sync recorded, so that a
 * rename never papers over an edit made on another device. Everything
 * else is left to the reconcile, as before.
 */
export async function followLocalRenames(host: LocalRenameHost, localFiles: string[], tree: RemoteTree): Promise<void> {
    const present = new Set(localFiles);
    const missing = host.state.entries().filter((record) => {
        const remote = tree.files.get(record.path);
        return (
            record.type === 'file' &&
            record.base !== undefined &&
            !present.has(record.path) &&
            !host.filter().isExcludedWithAncestors(record.path) &&
            remote?.nodeUid === record.nodeUid &&
            remote.revisionUid === record.base.remoteRevisionUid
        );
    });
    if (missing.length === 0) {
        return;
    }

    // Only files of a size some missing record had can match; only those are hashed.
    const sizes = new Set(missing.map((record) => record.base!.size));
    const candidates: { path: string; key: string }[] = [];
    for (const path of localFiles) {
        if (host.state.get(path) || tree.files.has(path) || host.filter().isExcludedWithAncestors(path)) {
            continue;
        }
        const stat = await host.vault.stat(path);
        if (!stat || !sizes.has(stat.size)) {
            continue;
        }
        const state = await host.vault.getState(path);
        if (state) {
            // The reconcile would hash it anyway; keep the result for it.
            host.plannedLocal.set(path, state);
            candidates.push({ path, key: `${state.hash}:${state.size}` });
        }
    }

    const byKey = new Map<string, { gone: typeof missing; found: string[] }>();
    for (const record of missing) {
        const key = `${record.base!.hash}:${record.base!.size}`;
        const group = byKey.get(key) ?? { gone: [], found: [] };
        group.gone.push(record);
        byKey.set(key, group);
    }
    for (const candidate of candidates) {
        byKey.get(candidate.key)?.found.push(candidate.path);
    }

    for (const { gone, found } of byKey.values()) {
        if (gone.length !== 1 || found.length !== 1) {
            continue;
        }
        const record = gone[0];
        const to = found[0];
        try {
            await host.moveRemoteNode(record.nodeUid, to);
        } catch (error) {
            host.logger.warn(`Could not carry the rename of "${record.path}" to "${to}" over to Drive`, error);
            continue;
        }
        const remote = tree.files.get(record.path)!;
        tree.files.delete(record.path);
        tree.files.set(to, remote);
        tree.nodePaths.set(record.nodeUid, to);
        host.state.rename(record.path, to);
        host.logger.info(`Renamed "${record.path}" to "${to}" on Drive, as it was renamed here`);
    }
}
