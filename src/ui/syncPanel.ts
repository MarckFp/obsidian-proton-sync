import { ButtonComponent, ExtraButtonComponent, ItemView, setIcon, type WorkspaceLeaf } from 'obsidian';

import type { DeletedItem, NoteVersion, PendingChange, SyncSummary } from '../sync/engine';
import { basename } from '../sync/paths';
import {
    formatBytes,
    PENDING_TEXT,
    statusDescription,
    statusDetails,
    statusIcon,
    statusLabel,
    timeAgo,
} from './syncStatus';

export const SYNC_PANEL_VIEW = 'proton-drive-sync-panel';

/** Versions of the current note shown per page of its history. */
const VERSIONS_PER_PAGE = 10;

/** Entries of the "Not synced yet" list shown before the rest are counted. */
const MAX_PENDING_SHOWN = 30;


/** What the panel needs from the plugin; kept narrow so the view holds no plugin internals. */
export type SyncPanelHost = {
    summary(): SyncSummary;
    pendingChanges(): PendingChange[];
    /** The note in view, or the one last in view while the sidebar has focus. */
    activeNote(): string | null;
    /** Whether Drive can be asked for versions now: signed in, a folder chosen, not locked. */
    canListVersions(): boolean;
    /** Changes when the note's history needs listing again; see `SyncEngine.versionsKey`. */
    versionsKey(path: string): string;
    noteVersions(path: string): Promise<NoteVersion[] | null>;
    /** Compare the note with a version, and offer to restore it. */
    openVersion(path: string, version: NoteVersion): void;
    /** Show the note's public link on Drive, or offer to make one. */
    shareNote(path: string): void;
    /** Files of the vault in Drive's trash, most recent first. */
    recentlyDeleted(): Promise<DeletedItem[]>;
    /** Take one out of the trash; the next check brings it back. */
    restoreDeleted(item: DeletedItem): Promise<void>;
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
    private pendingHeadingEl!: HTMLElement;
    private pendingEl!: HTMLElement;
    private historyTitleEl!: HTMLElement;
    private historyEl!: HTMLElement;
    private shareButton!: ExtraButtonComponent;
    private deletedEl!: HTMLElement;
    /** The "Recently deleted" list: not asked for, being listed, listed, or failed. */
    private deleted: DeletedItem[] | null | 'loading' | Error = null;

    /** What the history list shows: for which listing, and its state. */
    private historyKey: string | null = null;
    private historyPath: string | null = null;
    private versions: NoteVersion[] | null | 'loading' | Error = null;
    private historyPage = 0;

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
        new ButtonComponent(actions)
            .setIcon('settings')
            .setTooltip('Settings')
            .onClick(() => this.host.openSettings());
        this.conflictsButton = new ButtonComponent(root).setIcon('alert-circle').onClick(() => this.host.showConflicts());
        this.conflictsButton.buttonEl.addClass('proton-drive-sync-panel-wide');

        this.pendingHeadingEl = root.createEl('h6', { cls: 'proton-drive-sync-panel-heading' });
        this.pendingEl = root.createDiv({ cls: 'proton-drive-sync-panel-pending' });

        const historyHeading = root.createDiv({ cls: 'proton-drive-sync-panel-heading proton-drive-sync-panel-history-heading' });
        this.historyTitleEl = historyHeading.createEl('h6');
        this.shareButton = new ExtraButtonComponent(historyHeading)
            .setIcon('link')
            .setTooltip('Share link…')
            .onClick(() => {
                if (this.historyPath !== null) {
                    this.host.shareNote(this.historyPath);
                }
            });
        new ExtraButtonComponent(historyHeading)
            .setIcon('refresh-cw')
            .setTooltip('List the versions again')
            .onClick(() => {
                this.historyKey = null;
                this.noteChanged();
            });
        this.historyEl = root.createDiv({ cls: 'proton-drive-sync-panel-history' });

        const deletedHeading = root.createDiv({ cls: 'proton-drive-sync-panel-heading proton-drive-sync-panel-history-heading' });
        deletedHeading.createEl('h6', { text: 'Recently deleted' });
        new ExtraButtonComponent(deletedHeading)
            .setIcon('refresh-cw')
            .setTooltip('List Drive’s trash again')
            .onClick(() => void this.loadDeleted());
        this.deletedEl = root.createDiv({ cls: 'proton-drive-sync-panel-history' });
        this.renderDeleted();

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

        // Shown for the whole of a sync: measured once there is something to
        // measure against, and until then a moving bar that says work is under
        // way, rather than nothing at all while Drive and the vault are listed.
        const fraction = summary.progressFraction;
        this.progressEl.toggle(summary.status === 'syncing');
        this.progressEl.toggleClass('mod-indeterminate', fraction === null);
        this.progressFillEl.setCssProps({ width: fraction === null ? '' : `${Math.round(fraction * 100)}%` });

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
        this.noteChanged();
    }

    /**
     * The note in view, or its synced version, may have changed: list its
     * history again if so. Cheap when nothing changed, so it can run on every
     * status update; Drive is only asked when the listing would differ.
     */
    noteChanged(): void {
        if (!this.historyEl) {
            return;
        }
        const path = this.host.activeNote();
        const available = path !== null && this.host.canListVersions();
        const key = available ? this.host.versionsKey(path) : `unavailable:${path ?? ''}`;
        if (key === this.historyKey) {
            return;
        }
        this.historyKey = key;
        this.historyPath = path;
        this.historyPage = 0;
        if (!available) {
            this.versions = null;
            this.renderHistory();
            return;
        }
        this.versions = 'loading';
        this.renderHistory();
        void this.host.noteVersions(path).then(
            (versions) => this.showVersions(key, versions),
            (error: unknown) => this.showVersions(key, error instanceof Error ? error : new Error(String(error))),
        );
    }

    private showVersions(key: string, versions: NoteVersion[] | null | Error): void {
        // A slow answer for a note no longer in view is dropped.
        if (key !== this.historyKey) {
            return;
        }
        this.versions = versions;
        this.renderHistory();
    }

    /**
     * The current note's versions on Drive, newest first, a page at a time.
     * Choosing one compares it with the note as it is now, and offers to bring
     * it back.
     */
    private renderHistory(): void {
        const path = this.historyPath;
        this.historyTitleEl.setText(path ? `Versions of ${basename(path)}` : 'Versions');
        this.shareButton.extraSettingsEl.toggle(path !== null && this.host.canListVersions());
        this.historyEl.empty();
        const say = (text: string) => this.historyEl.createDiv({ cls: 'proton-drive-sync-muted', text });

        if (path === null) {
            say('Open a note to see its versions on Proton Drive.');
            return;
        }
        if (!this.host.canListVersions()) {
            say('Sign in, choose a Drive folder and unlock to see this note’s versions.');
            return;
        }
        if (this.versions === 'loading') {
            say('Listing versions…');
            return;
        }
        if (this.versions instanceof Error) {
            say(`Could not list the versions: ${this.versions.message}`);
            return;
        }
        if (this.versions === null) {
            say('This note is not on Proton Drive yet, so it has no versions there.');
            return;
        }
        if (this.versions.length === 0) {
            say('No versions on Drive.');
            return;
        }

        const versions = this.versions;
        const pages = Math.ceil(versions.length / VERSIONS_PER_PAGE);
        const page = Math.min(this.historyPage, pages - 1);
        const list = this.historyEl.createDiv({ cls: 'proton-drive-sync-panel-versions' });
        for (const version of versions.slice(page * VERSIONS_PER_PAGE, (page + 1) * VERSIONS_PER_PAGE)) {
            const item = list.createEl('button', { cls: 'proton-drive-sync-panel-version' });
            const top = item.createDiv({ cls: 'proton-drive-sync-panel-version-date' });
            top.setText(new Date(version.created).toLocaleString());
            if (version.active) {
                top.createSpan({ cls: 'proton-drive-sync-panel-badge', text: 'Current' });
            }
            const details = [timeAgo(version.created)];
            if (version.size !== undefined) {
                details.push(formatBytes(version.size));
            }
            item.createDiv({ cls: 'proton-drive-sync-muted', text: details.join(' · ') });
            item.addEventListener('click', () => this.host.openVersion(path, version));
        }

        if (pages > 1) {
            const pager = this.historyEl.createDiv({ cls: 'proton-drive-sync-panel-pager' });
            new ButtonComponent(pager)
                .setButtonText('Newer')
                .setDisabled(page === 0)
                .onClick(() => {
                    this.historyPage = page - 1;
                    this.renderHistory();
                });
            pager.createSpan({ cls: 'proton-drive-sync-muted', text: `Page ${page + 1} of ${pages}` });
            new ButtonComponent(pager)
                .setButtonText('Older')
                .setDisabled(page >= pages - 1)
                .onClick(() => {
                    this.historyPage = page + 1;
                    this.renderHistory();
                });
        }
    }

    /**
     * List the vault's files in Drive's trash. Asked for, not loaded with the
     * panel: the trash covers the whole account and takes a few requests to
     * list, which is not worth spending each time the sidebar opens.
     */
    private async loadDeleted(): Promise<void> {
        if (!this.host.canListVersions() || this.deleted === 'loading') {
            this.renderDeleted();
            return;
        }
        this.deleted = 'loading';
        this.renderDeleted();
        try {
            this.deleted = await this.host.recentlyDeleted();
        } catch (error) {
            this.deleted = error instanceof Error ? error : new Error(String(error));
        }
        this.renderDeleted();
    }

    /**
     * Notes deleted from the vault, on any device, are kept in Drive's trash
     * until it is emptied. Each can be brought back with one tap: it is
     * restored on Drive, and the next check downloads it into the vault.
     */
    private renderDeleted(): void {
        this.deletedEl.empty();
        const say = (text: string) => this.deletedEl.createDiv({ cls: 'proton-drive-sync-muted', text });
        if (!this.host.canListVersions()) {
            say('Sign in, choose a Drive folder and unlock to see deleted notes.');
            return;
        }
        if (this.deleted === null) {
            new ButtonComponent(this.deletedEl).setButtonText('Show deleted notes').onClick(() => void this.loadDeleted());
            return;
        }
        if (this.deleted === 'loading') {
            say('Listing Drive’s trash…');
            return;
        }
        if (this.deleted instanceof Error) {
            say(`Could not list the trash: ${this.deleted.message}`);
            return;
        }
        if (this.deleted.length === 0) {
            say('Nothing from this vault is in Drive’s trash.');
            return;
        }
        const list = this.deletedEl.createDiv({ cls: 'proton-drive-sync-panel-versions' });
        for (const item of this.deleted) {
            const row = list.createDiv({ cls: 'proton-drive-sync-panel-deleted' });
            const text = row.createDiv({ cls: 'proton-drive-sync-panel-deleted-text' });
            text.createDiv({ text: item.isFolder ? `${item.path}/ (folder)` : item.path });
            const details = [`deleted ${timeAgo(item.deleted)}`];
            if (item.size !== undefined) {
                details.push(formatBytes(item.size));
            }
            if (item.withFolder) {
                details.push(`comes back with ${item.withFolder}`);
            }
            text.createDiv({ cls: 'proton-drive-sync-muted', text: details.join(' · ') });
            const button = new ButtonComponent(row).setButtonText('Restore').onClick(async () => {
                button.setDisabled(true).setButtonText('Restoring…');
                try {
                    await this.host.restoreDeleted(item);
                    const restored = new Set(item.restoreUids);
                    if (Array.isArray(this.deleted)) {
                        this.deleted = this.deleted.filter((other) => !restored.has(other.uid));
                    }
                    this.renderDeleted();
                } catch (error) {
                    button.setDisabled(false).setButtonText('Restore');
                    say(`Could not restore ${item.path}: ${error instanceof Error ? error.message : String(error)}`);
                }
            });
        }
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
