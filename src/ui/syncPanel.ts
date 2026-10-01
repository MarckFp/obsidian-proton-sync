import { ButtonComponent, ItemView, setIcon, type WorkspaceLeaf } from 'obsidian';

import type { PendingChange, SyncSummary } from '../sync/engine';
import type { LogEntry } from '../util/logger';
import {
    PENDING_TEXT,
    statusDescription,
    statusDetails,
    statusIcon,
    statusLabel,
    transferPercent,
} from './syncStatus';

export const SYNC_PANEL_VIEW = 'proton-drive-sync-panel';

/** Log entries shown in the panel, newest first. */
const RECENT_ENTRIES = 20;

/** Entries of the "Not synced yet" list shown before the rest are counted. */
const MAX_PENDING_SHOWN = 30;


/** What the panel needs from the plugin; kept narrow so the view holds no plugin internals. */
export type SyncPanelHost = {
    summary(): SyncSummary;
    logEntries(): readonly LogEntry[];
    pendingChanges(): PendingChange[];
    /** Open a note, from the "Not synced yet" list. */
    openFile(path: string): void;
    syncNow(): void;
    togglePause(): void;
    showConflicts(): void;
    openSettings(): void;
};

/**
 * The sync's status and controls, in a sidebar panel.
 *
 * Mainly for mobile, where Obsidian has no status bar: the panel lives in the
 * right sidebar, out of the way of the note until it is swiped in, and shows
 * what the status bar shows on desktop plus the controls behind its menu.
 * Available on desktop too, for anyone who wants the detail at a glance.
 *
 * Built once and then updated in place, so a button is never replaced under
 * a finger while progress updates arrive.
 */
export class SyncPanelView extends ItemView {
    private iconEl!: HTMLElement;
    private labelEl!: HTMLElement;
    private descriptionEl!: HTMLElement;
    private progressEl!: HTMLElement;
    private progressFillEl!: HTMLElement;
    private detailsEl!: HTMLElement;
    private syncButton!: ButtonComponent;
    private pauseButton!: ButtonComponent;
    private conflictsButton!: ButtonComponent;
    private logEl!: HTMLElement;
    private pendingHeadingEl!: HTMLElement;
    private pendingEl!: HTMLElement;

    constructor(
        leaf: WorkspaceLeaf,
        private readonly host: SyncPanelHost,
    ) {
        super(leaf);
    }

    override getViewType(): string {
        return SYNC_PANEL_VIEW;
    }

    override getDisplayText(): string {
        return 'Proton Drive Sync';
    }

    override getIcon(): string {
        return 'cloud';
    }

    override async onOpen(): Promise<void> {
        const root = this.contentEl;
        root.empty();
        root.addClass('proton-drive-sync-panel');

        const header = root.createDiv({ cls: 'proton-drive-sync-panel-header' });
        this.iconEl = header.createSpan({ cls: 'proton-drive-sync-icon' });
        this.labelEl = header.createSpan({ cls: 'proton-drive-sync-panel-label' });
        this.descriptionEl = root.createDiv({ cls: 'proton-drive-sync-muted' });

        this.progressEl = root.createDiv({ cls: 'proton-drive-sync-panel-progress' });
        this.progressFillEl = this.progressEl.createDiv({ cls: 'proton-drive-sync-panel-progress-fill' });

        this.detailsEl = root.createEl('ul', { cls: 'proton-drive-sync-panel-details' });

        const actions = root.createDiv({ cls: 'proton-drive-sync-panel-actions' });
        this.syncButton = new ButtonComponent(actions).setCta().onClick(() => this.host.syncNow());
        this.pauseButton = new ButtonComponent(actions).onClick(() => this.host.togglePause());
        this.conflictsButton = new ButtonComponent(actions).setIcon('alert-circle').onClick(() => this.host.showConflicts());
        new ButtonComponent(actions)
            .setIcon('settings')
            .setTooltip('Settings')
            .onClick(() => this.host.openSettings());

        this.pendingHeadingEl = root.createEl('h6', { cls: 'proton-drive-sync-panel-heading' });
        this.pendingEl = root.createDiv({ cls: 'proton-drive-sync-panel-pending' });

        root.createEl('h6', { text: 'Recent activity', cls: 'proton-drive-sync-panel-heading' });
        this.logEl = root.createEl('pre', { cls: 'proton-drive-sync-log' });

        this.update(this.host.summary());
    }

    update(summary: SyncSummary): void {
        if (!this.labelEl) {
            // Not opened yet; a deferred view renders on first reveal.
            return;
        }

        setIcon(this.iconEl, statusIcon(summary));
        this.iconEl.toggleClass('proton-drive-sync-spin', summary.status === 'syncing');
        this.labelEl.setText(statusLabel(summary));
        this.descriptionEl.setText(statusDescription(summary));

        const fraction = summary.transfer
            ? transferPercent(summary.transfer) / 100
            : summary.progress && summary.progress.total > 0
              ? summary.progress.done / summary.progress.total
              : null;
        this.progressEl.toggle(summary.status === 'syncing' && fraction !== null);
        this.progressFillEl.setCssProps({ width: `${Math.round((fraction ?? 0) * 100)}%` });

        this.detailsEl.empty();
        for (const line of statusDetails(summary)) {
            this.detailsEl.createEl('li', { text: line });
        }

        // Locked, the main action is unlocking: that is what "sync now" does then.
        const locked = summary.status === 'locked';
        this.syncButton.setButtonText(locked ? 'Unlock' : 'Sync now').setIcon(locked ? 'lock-open' : 'refresh-cw');
        this.pauseButton.buttonEl.toggle(!locked);

        const paused = summary.status === 'paused';
        this.pauseButton.setButtonText(paused ? 'Resume' : 'Pause').setIcon(paused ? 'play-circle' : 'pause-circle');
        // Always there, so past conflicts stay one tap away; a count, and the
        // accent colour, when some are waiting on a decision.
        this.conflictsButton.setButtonText(summary.conflicts > 0 ? `Review ${summary.conflicts}` : 'Conflicts');
        this.conflictsButton.buttonEl.toggleClass('mod-warning', summary.conflicts > 0);

        this.renderPending(this.host.pendingChanges(), summary);

        const entries = this.host.logEntries().slice(-RECENT_ENTRIES).reverse();
        this.logEl.setText(
            entries.length === 0
                ? 'Nothing logged yet.'
                : entries
                      .map((entry) => `${new Date(entry.time).toLocaleTimeString()} ${entry.message}`)
                      .join('\n'),
        );
    }

    /**
     * Everything not in sync, and why, so a note that is not reaching the other
     * devices is visible here instead of being found missing there.
     */
    private renderPending(changes: PendingChange[], summary: SyncSummary): void {
        this.pendingHeadingEl.setText(changes.length === 0 ? 'Not synced yet' : `Not synced yet (${changes.length})`);
        this.pendingEl.empty();
        if (changes.length === 0) {
            this.pendingEl.createDiv({
                cls: 'proton-drive-sync-muted',
                text:
                    summary.status === 'paused'
                        ? 'Syncing is paused. Changes made meanwhile are found and synced when you resume.'
                        : 'Everything is synced.',
            });
            return;
        }
        const list = this.pendingEl.createEl('ul', { cls: 'proton-drive-sync-panel-details' });
        for (const change of changes.slice(0, MAX_PENDING_SHOWN)) {
            const item = list.createEl('li');
            const link = item.createEl('a', { text: change.path, href: '#' });
            link.addEventListener('click', (event) => {
                event.preventDefault();
                this.host.openFile(change.path);
            });
            item.createDiv({
                cls: 'proton-drive-sync-muted',
                text: change.detail ? `${PENDING_TEXT[change.reason]} (${change.detail})` : PENDING_TEXT[change.reason],
            });
        }
        if (changes.length > MAX_PENDING_SHOWN) {
            list.createEl('li', { text: `…and ${changes.length - MAX_PENDING_SHOWN} more.` });
        }
    }
}
