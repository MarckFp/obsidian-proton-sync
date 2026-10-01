import { Menu, setIcon, setTooltip } from 'obsidian';

import type { SyncSummary } from '../sync/engine';
import { type NoteIndicator, statusDescription, statusDetails, statusIcon, statusLabel } from './syncStatus';

export type StatusBarActions = {
    syncNow: () => void;
    togglePause: () => void;
    showConflicts: () => void;
    openPanel: () => void;
    openSettings: () => void;
};

/**
 * The status bar entry, on desktop. (Obsidian's mobile app has no status bar;
 * there the ribbon icon and the sync panel take its place.)
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
    private note: NoteIndicator | null = null;

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

    /** The note in view, for the dot beside the icon; null when no note is open. */
    setNote(note: NoteIndicator | null): void {
        this.note = note;
        if (this.summary) {
            this.render();
        }
    }

    /** Re-render with the last summary, so "synced 2m ago" keeps counting. */
    refresh(): void {
        if (this.summary) {
            this.render();
        }
    }

    private render(): void {
        const summary = this.summary!;
        this.element.empty();

        const icon = this.element.createSpan({ cls: 'proton-drive-sync-icon' });
        setIcon(icon, statusIcon(summary));
        if (summary.status === 'syncing') {
            icon.addClass('proton-drive-sync-spin');
        }
        if (this.note) {
            this.element.createSpan({ cls: `proton-drive-sync-note-dot mod-${this.note.state}` });
        }

        this.element.createSpan({ text: ` ${statusLabel(summary)}` });
        setTooltip(
            this.element,
            [
                `Proton Drive Sync: ${statusDescription(summary)}`,
                ...(this.note ? [this.note.text] : []),
                ...statusDetails(summary),
                summary.status === 'paused'
                    ? 'Click to resume.'
                    : summary.status === 'locked'
                      ? 'Click to unlock.'
                      : 'Click to sync now.',
                'Right-click for more options.',
            ].join('\n'),
        );
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
            .addItem((item) =>
                item
                    .setTitle('Open sync panel')
                    .setIcon('cloud')
                    .onClick(() => this.actions.openPanel()),
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
