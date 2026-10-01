import type { NoteSyncState, PendingChange, PendingReason, SyncStatus, SyncSummary, TransferProgress } from '../sync/engine';
import { basename } from '../sync/paths';

/**
 * How a sync summary is put into words and icons, shared by everything that
 * shows it: the status bar on desktop, the ribbon icon on mobile, and the
 * sync panel on both. One source, so they never disagree.
 */

type Presentation = { icon: string; label: string; description: string };

const PRESENTATION: Record<SyncStatus, Presentation> = {
    'signed-out': {
        icon: 'log-in',
        label: 'Sign in',
        description: 'Not signed in. Open the plugin settings to connect an account.',
    },
    'not-configured': {
        icon: 'folder-search',
        label: 'Choose folder',
        description: 'No Drive folder chosen yet. Pick one in the plugin settings.',
    },
    idle: { icon: 'refresh-cw', label: 'Synced', description: 'Up to date.' },
    syncing: { icon: 'refresh-cw', label: 'Syncing', description: 'Syncing.' },
    offline: {
        icon: 'cloud-off',
        label: 'Offline',
        description: 'Offline. Changes are queued and will sync when the connection returns.',
    },
    error: { icon: 'alert-triangle', label: 'Error', description: 'The last sync failed.' },
    paused: {
        icon: 'pause-circle',
        label: 'Paused',
        description: 'Paused. Anything changed in the meantime is synced when you resume.',
    },
    locked: {
        icon: 'lock',
        label: 'Sync locked',
        description: 'Your sign-in is protected with a PIN. Enter it to start syncing.',
    },
    'waiting-for-wifi': {
        icon: 'wifi-off',
        label: 'Waiting for Wi-Fi',
        description: 'On mobile data, and set to sync on Wi-Fi only.',
    },
};

/** Why a path is not synced, as the sync panel and the current-note indicator put it. */
export const PENDING_TEXT: Record<PendingReason, string> = {
    transferring: 'Uploading or downloading now',
    waiting: 'Waiting to be synced',
    wifi: 'Waiting for Wi-Fi',
    retrying: 'Failed to sync; will try again',
    'too-large': 'Over this device’s size limit, so not synced here',
    'name-clash': 'Its name clashes with another apart from letter case',
    conflict: 'Changed in two places; waiting for your decision',
};

/** The current note's standing, as the indicator beside the sync icon shows it. */
export type NoteIndicator = {
    state: NoteSyncState;
    /** A transfer of this very note is under way. */
    transferring: boolean;
    text: string;
};

export function noteIndicator(state: NoteSyncState, change: PendingChange | undefined): NoteIndicator {
    const transferring = change?.reason === 'transferring';
    if (state === 'excluded') {
        return { state, transferring, text: 'This note is not synced: it is excluded in the settings.' };
    }
    if (state === 'synced') {
        return { state, transferring, text: 'This note is in sync.' };
    }
    if (!change) {
        return { state, transferring, text: 'This note has changes not synced yet.' };
    }
    const reason = PENDING_TEXT[change.reason];
    return {
        state,
        transferring,
        text: `This note is not in sync yet: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}${change.detail ? ` (${change.detail})` : ''}.`,
    };
}

/** Longest file name shown in a label before it is shortened. */
const MAX_NAME_LENGTH = 24;

/**
 * The icon for the current state. Being locked outranks everything, since
 * nothing syncs until the PIN is entered; after that, a conflict waiting on
 * the user does.
 */
export function statusIcon(summary: SyncSummary): string {
    if (summary.status === 'locked') {
        return PRESENTATION.locked.icon;
    }
    return summary.conflicts > 0 ? 'alert-circle' : PRESENTATION[summary.status].icon;
}

/** One short line: "Synced 5m ago", "Syncing 12/340", "↑ video.mp4 45%", "2 conflicts". */
export function statusLabel(summary: SyncSummary): string {
    if (summary.status === 'locked') {
        return PRESENTATION.locked.label;
    }
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
    return PRESENTATION[summary.status].label;
}

export function statusDescription(summary: SyncSummary): string {
    return PRESENTATION[summary.status].description;
}

/** Everything worth knowing beyond the label, one fact per line. */
export function statusDetails(summary: SyncSummary): string[] {
    const lines: string[] = [];
    if (summary.conflicts > 0) {
        lines.push(`${summary.conflicts} file${summary.conflicts === 1 ? '' : 's'} need a decision.`);
    }
    if (summary.progress) {
        lines.push(`${summary.progress.done} of ${summary.progress.total} files checked in this pass`);
    } else if (summary.status === 'syncing' && !summary.transfer) {
        lines.push('Looking for changes here and on Drive…');
    }
    if (summary.status === 'syncing' && summary.progressFraction !== null) {
        lines.push(`${Math.floor(summary.progressFraction * 100)}% done`);
    }
    if (summary.pending > 0) {
        lines.push(`${summary.pending} change${summary.pending === 1 ? '' : 's'} not synced yet`);
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
    return lines;
}

function transferLabel(transfer: TransferProgress): string {
    const arrow = transfer.direction === 'upload' ? '↑' : '↓';
    const name = basename(transfer.path);
    const shown = name.length > MAX_NAME_LENGTH ? `${name.slice(0, MAX_NAME_LENGTH - 1)}…` : name;
    return `${arrow} ${shown} ${transferPercent(transfer)}%`;
}

export function transferPercent(transfer: TransferProgress): number {
    return transfer.total > 0 ? Math.floor((transfer.bytes / transfer.total) * 100) : 0;
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
