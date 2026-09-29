import { setIcon, setTooltip } from 'obsidian';

import type { SyncStatus, SyncSummary } from '../sync/engine';

type Presentation = { icon: string; label: string; tooltip: string };

const PRESENTATION: Record<SyncStatus, Presentation> = {
    'signed-out': {
        icon: 'log-in',
        label: 'Sign in',
        tooltip: 'Proton Drive Sync: not signed in. Open the plugin settings to connect an account.',
    },
    'not-configured': {
        icon: 'folder-search',
        label: 'Choose folder',
        tooltip: 'Proton Drive Sync: no Drive folder chosen yet. Pick one in the plugin settings.',
    },
    idle: { icon: 'refresh-cw', label: 'Synced', tooltip: 'Proton Drive Sync: up to date. Click to sync now.' },
    syncing: { icon: 'refresh-cw', label: 'Syncing', tooltip: 'Proton Drive Sync: syncing.' },
    offline: {
        icon: 'cloud-off',
        label: 'Offline',
        tooltip: 'Proton Drive Sync: offline. Changes are queued and will sync when the connection returns.',
    },
    error: { icon: 'alert-triangle', label: 'Error', tooltip: 'Proton Drive Sync: last sync failed.' },
};

/**
 * The status bar entry.
 *
 * A sync that runs in the background needs somewhere the user can glance to see
 * that it is still working, because the alternative - noticing only when a note
 * is missing on the other device - is how people lose trust in a sync tool.
 * Conflicts are surfaced here too, since the whole point of keeping both copies
 * is lost if nobody notices the second one.
 */
export class StatusBar {
    constructor(
        private readonly element: HTMLElement,
        onClick: () => void,
    ) {
        this.element.addClass('mod-clickable');
        this.element.addEventListener('click', onClick);
    }

    update(summary: SyncSummary): void {
        const presentation = PRESENTATION[summary.status];
        this.element.empty();

        const icon = this.element.createSpan({ cls: 'proton-drive-sync-icon' });
        setIcon(icon, summary.conflicts > 0 ? 'alert-circle' : presentation.icon);
        if (summary.status === 'syncing') {
            icon.addClass('proton-drive-sync-spin');
        }

        const label =
            summary.conflicts > 0
                ? `${summary.conflicts} conflict${summary.conflicts === 1 ? '' : 's'}`
                : presentation.label;
        this.element.createSpan({ text: ` ${label}` });

        setTooltip(this.element, this.buildTooltip(summary, presentation));
    }

    private buildTooltip(summary: SyncSummary, presentation: Presentation): string {
        const lines = [presentation.tooltip];

        if (summary.conflicts > 0) {
            lines.push(
                `${summary.conflicts} file${summary.conflicts === 1 ? '' : 's'} need a decision — ` +
                    'run "Show sync conflicts" from the command palette.',
            );
        }
        if (summary.lastSyncedAt !== null) {
            lines.push(`Last synced ${new Date(summary.lastSyncedAt).toLocaleTimeString()}`);
        }
        if (summary.lastError) {
            lines.push(`Last error: ${summary.lastError}`);
        }
        return lines.join('\n');
    }
}
