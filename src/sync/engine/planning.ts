import type { ProtonDriveClient } from '@protontech/drive-sdk';

import type { Logger } from '../../util/logger';
import { runPooled } from '../../util/pool';
import { DriveIO } from '../drive';
import type { PathFilter } from '../paths';
import { reconcile } from '../reconcile';
import type { SyncState } from '../state';
import type { LocalState } from '../types';
import type { VaultIO } from '../vault';
import type { SyncPlan } from './types';

/** Files checked at once while planning; local work, so well above any transfer limit. */
const SCAN_CONCURRENCY = 8;

/** What planning a first sync needs from the engine. */
export type PlanHost = {
    readonly logger: Logger;
    filter(): PathFilter;
    readonly vault: VaultIO;
    readonly state: SyncState;
    /** Filled with the local states worked out, for the sync that follows to reuse. */
    readonly plannedLocal: Map<string, LocalState>;
    sizeLimitBytes(): number;
};

/**
 * What a first sync against `rootUid` would do, without doing any of it.
 *
 * Shown before the first sync of a vault with a folder that already holds
 * files, which is the one moment where the user cannot yet know what the
 * plugin is about to change. The local states worked out here are kept for
 * the sync that follows, so it does not hash every file a second time.
 */
export async function planFirstSync(host: PlanHost, client: ProtonDriveClient, rootUid: string): Promise<SyncPlan> {
    const drive = new DriveIO(client, host.logger.getLogger('drive'));
    const included = (path: string) => !host.filter().isExcludedWithAncestors(path);
    const [tree, local] = await Promise.all([
        drive.listTree(rootUid, (path) => !host.filter().isExcluded(path)),
        host.vault.list((path) => !host.filter().isExcluded(path)),
    ]);

    const localFiles = local.files.filter(included);
    const remoteFiles = [...tree.files.keys()].filter(included);
    const plan: SyncPlan = {
        localFiles: localFiles.length,
        localNotes: localFiles.filter((path) => !host.filter().isConfigPath(path)).length,
        remoteFiles: remoteFiles.length,
        uploads: [],
        downloads: [],
        conflicts: [],
        settings: [],
        removals: [],
        held: [],
        unchanged: 0,
    };

    const limit = host.sizeLimitBytes();
    const paths = [...new Set([...localFiles, ...remoteFiles])];
    host.plannedLocal.clear();
    await runPooled(
        paths.map((path) => async () => {
            const record = host.state.get(path);
            const localState = await host.vault.getState(path, record?.base);
            if (localState) {
                host.plannedLocal.set(path, localState);
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
            if ((action.type === 'download' || action.type === 'conflict') && host.filter().isConfigPath(path)) {
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
        (error, index) => host.logger.warn(`Could not check "${paths[index]}"`, error),
    );

    for (const list of [plan.uploads, plan.downloads, plan.conflicts, plan.settings, plan.removals, plan.held]) {
        list.sort((a, b) => a.localeCompare(b));
    }
    return plan;
}
