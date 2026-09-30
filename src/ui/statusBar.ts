import { Menu, setIcon, setTooltip } from 'obsidian';

import type { SyncStatus, SyncSummary, TransferProgress } from '../sync/engine';
import { basename } from '../sync/paths';

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
    paused: {
        icon: 'pause-circle',
        label: 'Paused',
        tooltip: 'Proton Drive Sync: paused. Click to resume; anything changed meanwhile is synced then.',
    },
    'waiting-for-wifi': {
        icon: 'wifi-off',
        label: 'Waiting for Wi-Fi',
        tooltip: 'Proton Drive Sync: on mobile data, and set to sync on Wi-Fi only.',
    },
};

/** Longest file name shown in the status bar before it is shortened. */
const MAX_NAME_LENGTH = 24;

export type StatusBarActions = {
    syncNow: () => void;
    togglePause: () => void;
    showConflicts: () => void;
    openSettings: () => void;
};

/**
 * The status bar entry.
 *
 * A sync that runs in the background needs somewhere the user can glance to see
 * that it is still working, because the alternative - noticing only when a note
 * is missing on the other device - is how people lose trust in a sync tool.
 * Conflicts are surfaced here too, since the whole point of keeping both copies
 * is lost if nobody notices the second one.
 *
 * Click syncs now, or resumes when paused; right-click offers the rest.
 */
export class StatusBar {
    private summary: SyncSummary | null = null;

    constructor(
        private readonly element: HTMLElement,
        private readonly actions: StatusBarActions,
    ) {
        this.element.addClass('mod-clickable');
        this.element.addEventListener('click', () => {
            if (this.summary?.status === 'paused') {
                actions.togglePause();
            } else {
                actions.syncNow();
            }
        });
        this.element.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            this.menu().showAtMouseEvent(event);
        });
    }

    update(summary: SyncSummary): void {
        this.summary = summary;
        this.render();
    }

    /** Re-render with the last summary, so "synced 2m ago" keeps counting. */
    refresh(): void {
        if (this.summary) {
            this.render();
        }
    }

    private render(): void {
        const summary = this.summary!;
        const presentation = PRESENTATION[summary.status];
        this.element.empty();

        const icon = this.element.createSpan({ cls: 'proton-drive-sync-icon' });
        setIcon(icon, summary.conflicts > 0 ? 'alert-circle' : presentation.icon);
        if (summary.status === 'syncing') {
            icon.addClass('proton-drive-sync-spin');
        }

        this.element.createSpan({ text: ` ${this.label(summary, presentation)}` });
        setTooltip(this.element, this.buildTooltip(summary, presentation));
    }

    private label(summary: SyncSummary, presentation: Presentation): string {
        if (summary.conflicts > 0) {
            return `${summary.conflicts} conflict${summary.conflicts === 1 ? '' : 's'}`;
        }
        if (summary.status === 'syncing') {
            if (summary.transfer) {
                return transferLabel(summary.transfer);
            }
            if (summary.progress) {
                return `Syncing ${summary.progress.done}/${summary.progress.total}`;
            }
        }
        if (summary.status === 'idle' && summary.lastSyncedAt !== null) {
            return `Synced ${timeAgo(summary.lastSyncedAt)}`;
        }
        return presentation.label;
    }

    private buildTooltip(summary: SyncSummary, presentation: Presentation): string {
        const lines = [presentation.tooltip];

        if (summary.conflicts > 0) {
            lines.push(
                `${summary.conflicts} file${summary.conflicts === 1 ? '' : 's'} need a decision — ` +
                    'right-click here, or run "Show sync conflicts" from the command palette.',
            );
        }
        if (summary.progress) {
            lines.push(`${summary.progress.done} of ${summary.progress.total} files checked in this pass`);
        }
        if (summary.transfer) {
            const { transfer } = summary;
            lines.push(
                `${transfer.direction === 'upload' ? 'Uploading' : 'Downloading'} ${transfer.path}: ` +
                    `${formatBytes(transfer.bytes)} of ${formatBytes(transfer.total)}`,
            );
        }
        if (summary.lastSyncedAt !== null) {
            lines.push(`Last synced ${new Date(summary.lastSyncedAt).toLocaleString()}`);
        }
        if (summary.uploaded > 0 || summary.downloaded > 0) {
            lines.push(`Since Obsidian opened: ${summary.uploaded} uploaded, ${summary.downloaded} downloaded`);
        }
        if (summary.lastError) {
            lines.push(`Last error: ${summary.lastError}`);
        }
        lines.push('Right-click for more options.');
        return lines.join('\n');
    }

    private menu(): Menu {
        const paused = this.summary?.status === 'paused';
        return new Menu()
            .addItem((item) =>
                item
                    .setTitle('Sync now')
                    .setIcon('refresh-cw')
                    .onClick(() => this.actions.syncNow()),
            )
            .addItem((item) =>
                item
                    .setTitle(paused ? 'Resume syncing' : 'Pause syncing')
                    .setIcon(paused ? 'play-circle' : 'pause-circle')
                    .onClick(() => this.actions.togglePause()),
            )
            .addItem((item) =>
                item
                    .setTitle('Show sync conflicts')
                    .setIcon('alert-circle')
                    .onClick(() => this.actions.showConflicts()),
            )
            .addSeparator()
            .addItem((item) =>
                item
                    .setTitle('Settings')
                    .setIcon('settings')
                    .onClick(() => this.actions.openSettings()),
            );
    }
}

function transferLabel(transfer: TransferProgress): string {
    const arrow = transfer.direction === 'upload' ? '↑' : '↓';
    const name = basename(transfer.path);
    const shown = name.length > MAX_NAME_LENGTH ? `${name.slice(0, MAX_NAME_LENGTH - 1)}…` : name;
    const percent = transfer.total > 0 ? Math.floor((transfer.bytes / transfer.total) * 100) : 0;
    return `${arrow} ${shown} ${percent}%`;
}

/** "just now", "5m ago", "3h ago", "2d ago": short enough for the status bar. */
export function timeAgo(timestamp: number, now = Date.now()): string {
    const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
    if (seconds < 60) {
        return 'just now';
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        return `${minutes}m ago`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        return `${hours}h ago`;
    }
    return `${Math.floor(hours / 24)}d ago`;
}

export function formatBytes(bytes: number): string {
    if (bytes < 1024 * 1024) {
        return `${Math.round(bytes / 1024)} KB`;
    }
    if (bytes < 1024 * 1024 * 1024) {
        return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
