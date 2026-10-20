import { ButtonComponent, ItemView, setIcon, type WorkspaceLeaf } from 'obsidian';

import type { DeletedItem, NoteVersion, PendingChange, SyncStatus, SyncSummary } from '../sync/engine';
import { basename } from '../sync/paths';
import { labelButton } from './buttons';
import type { VersionComparison } from './compare';
import { DeletedModal } from './deletedModal';
import { DriveList } from './driveList';
import { ListingSchedule } from './listingSchedule';
import { pendingText, statusDescription, statusDetails, statusIcon, statusLabel } from './syncStatus';
import { VersionsModal } from './versionsModal';

export const SYNC_PANEL_VIEW = 'proton-drive-sync-panel';

/** Entries of the "Not synced yet" list shown before the rest are counted. */
const MAX_PENDING_SHOWN = 30;

/**
 * While the sync holds off from Drive, the trash is not listed unasked either:
 * paused, nothing is polled; on mobile data with "Wi-Fi only", nothing is
 * fetched; and offline, it would only fail.
 */
const HOLDING_OFF: ReadonlySet<SyncStatus> = new Set<SyncStatus>(['paused', 'waiting-for-wifi', 'offline']);

/** What the panel needs from the plugin; kept narrow so the view holds no plugin internals. */
export type SyncPanelHost = {
    summary(): SyncSummary;
    pendingChanges(): PendingChange[];
    /** The note in view, or the one last in view while the sidebar has focus. */
    activeNote(): string | null;
    /** Whether Drive can be asked for versions and the trash now: signed in, a folder chosen, unlocked and connected. */
    canListVersions(): boolean;
    /** Changes when the note's history needs listing again; see `SyncEngine.versionsKey`. */
    versionsKey(path: string): string;
    noteVersions(path: string): Promise<NoteVersion[] | null>;
    /** What choosing one of the note's versions shows; see `versionComparison`. */
    compareVersion(path: string, version: NoteVersion): VersionComparison;
    /** Show the note's public link on Drive, or offer to make one. */
    shareNote(path: string): void;
    /** Files of the vault in Drive's trash, most recent first. */
    recentlyDeleted(): Promise<DeletedItem[]>;
    /** Take one out of the trash; the next check brings it back. */
    restoreDeleted(item: DeletedItem): Promise<void>;
    /** Seconds until Drive is next checked for changes: the trash is listed again as often. */
    pollSeconds(): number;
    /**
     * Owner of the synced folder when it is in someone else's Drive. Files
     * deleted there go to the owner's trash, which this account cannot list.
     */
    sharedBy(): string | null;
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
 * The controls sit one to a row, each the full width of the panel: syncing and
 * pausing; sharing the note in view, and conflicts; the note's versions, and
 * recently deleted files, each in a dialog of its own; and the settings. Both
 * dialogs open on lists the panel keeps ready: the note's versions whenever it
 * changes, and the trash from the moment the sync is up, again as often as
 * Drive is checked for changes.
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
    private shareButton!: ButtonComponent;
    private conflictsButton!: ButtonComponent;
    private versionsButton!: ButtonComponent;
    private deletedButton!: ButtonComponent;
    private pendingHeadingEl!: HTMLElement;
    private pendingEl!: HTMLElement;
    /** Between `onOpen` and `onClose`: a closed panel lists nothing. */
    private opened = false;

    /** The note in view, as last seen: what Share link and Versions act on. */
    private notePath: string | null = null;
    /** What {@link versions} was listed for; see {@link noteChanged}. */
    private versionsKey: string | null = null;
    /** The note's versions on Drive; null when there is no note, or no Drive, to list them for. */
    private versions: DriveList<NoteVersion[] | null> | null = null;

    /** The vault's files in Drive's trash. */
    private readonly deleted = new DriveList<DeletedItem[]>();
    /**
     * Keeps the trash listed, ready for its dialog: as soon as the sync is up,
     * then again as often as Drive is checked for changes, which is every half
     * minute or so while things change and far less often when they do not.
     */
    private readonly deletedSchedule = new ListingSchedule({
        list: () => this.deleted.load(() => this.host.recentlyDeleted()),
        intervalSeconds: () => this.host.pollSeconds(),
        allowed: () => this.listsDeletedUnasked(),
    });

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

        // One to a row, in the order they are reached for; the settings,
        // needed least, at the bottom.
        const actions = root.createDiv({ cls: 'proton-drive-sync-panel-actions' });
        this.syncButton = new ButtonComponent(actions).setCta().onClick(() => this.host.syncNow());
        this.pauseButton = new ButtonComponent(actions).onClick(() => this.host.togglePause());
        this.shareButton = labelButton(new ButtonComponent(actions), 'link', 'Share link').onClick(() => {
            if (this.notePath !== null) {
                this.host.shareNote(this.notePath);
            }
        });
        this.conflictsButton = new ButtonComponent(actions).onClick(() => this.host.showConflicts());
        this.versionsButton = new ButtonComponent(actions).onClick(() => this.openVersions());
        this.deletedButton = labelButton(new ButtonComponent(actions), 'trash-2', 'Recently deleted').onClick(() =>
            this.openDeleted(),
        );
        labelButton(new ButtonComponent(actions), 'settings', 'Settings').onClick(() => this.host.openSettings());

        this.pendingHeadingEl = root.createEl('h6', { cls: 'proton-drive-sync-panel-heading' });
        this.pendingEl = root.createDiv({ cls: 'proton-drive-sync-panel-pending' });

        this.opened = true;
        // The buttons are new: label them whatever was listed before.
        this.versionsKey = null;
        this.update(this.host.summary());
    }

    override async onClose(): Promise<void> {
        this.opened = false;
        this.deletedSchedule.cancel();
    }

    update(summary: SyncSummary): void {
        if (!this.opened) {
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

        // Locked, the main action is unlocking: that is what "sync now" does
        // then, and there is nothing to pause.
        const locked = summary.status === 'locked';
        labelButton(this.syncButton, locked ? 'lock-open' : 'refresh-cw', locked ? 'Unlock' : 'Sync now');
        this.pauseButton.buttonEl.toggle(!locked);

        const paused = summary.status === 'paused';
        labelButton(this.pauseButton, paused ? 'play-circle' : 'pause-circle', paused ? 'Resume' : 'Pause');
        // Always there, so past conflicts stay one tap away; a count, and the
        // accent colour, when some are waiting on a decision.
        labelButton(this.conflictsButton, 'alert-circle', summary.conflicts > 0 ? `Review ${summary.conflicts}` : 'Conflicts');
        this.conflictsButton.buttonEl.toggleClass('mod-warning', summary.conflicts > 0);
        this.deletedButton.setDisabled(!this.host.canListVersions());

        this.renderPending(this.host.pendingChanges(), summary);
        this.noteChanged();
        if (!this.host.canListVersions()) {
            // Signed out, locked or between folders: what was listed is not
            // this vault's trash any more, and the next sync lists it afresh.
            this.deleted.clear();
            this.deletedSchedule.reset();
        }
        // Coming back to Obsidian brings the next listing forward, just as
        // it does the next check of Drive.
        this.deletedSchedule.check();
    }

    /**
     * The note in view, or its synced version, may have changed: list its
     * versions again if so, ready for the dialog. Cheap when nothing changed,
     * so it can run on every status update; Drive is only asked when the
     * listing would differ.
     */
    noteChanged(): void {
        if (!this.opened) {
            return;
        }
        const path = this.host.activeNote();
        const available = path !== null && this.host.canListVersions();
        const key = available ? this.host.versionsKey(path) : `unavailable:${path ?? ''}`;
        if (key === this.versionsKey) {
            return;
        }
        this.versionsKey = key;
        if (available) {
            // Another note gets a list of its own, so a dialog still open on
            // the last one goes on showing that note's versions.
            if (this.versions === null || path !== this.notePath) {
                this.versions = new DriveList();
            }
            const versions = this.versions;
            void versions.load(() => this.host.noteVersions(path));
        } else {
            this.versions = null;
        }
        this.notePath = path;

        // A long note name is cut short on the button; the tooltip has it whole.
        const versionsLabel = path === null ? 'Versions' : `Versions of ${basename(path)}`;
        labelButton(this.versionsButton, 'history', versionsLabel).setTooltip(versionsLabel);
        this.versionsButton.setDisabled(!available);
        this.shareButton.setDisabled(!available);
    }

    private openVersions(): void {
        const path = this.notePath;
        const versions = this.versions;
        if (path === null || versions === null) {
            return;
        }
        new VersionsModal(this.app, path, {
            versions,
            reload: () => void versions.load(() => this.host.noteVersions(path)),
            compare: (version) => this.host.compareVersion(path, version),
        }).open();
    }

    private openDeleted(): void {
        new DeletedModal(this.app, {
            deleted: this.deleted,
            canList: () => this.host.canListVersions(),
            sharedBy: () => this.host.sharedBy(),
            reload: () => void this.deletedSchedule.listNow(),
            restore: (item) => this.host.restoreDeleted(item),
        }).open();
    }

    /**
     * Whether the trash is listed without being asked: while the panel is open
     * and the sync is up, but not while the sync holds off from Drive, nor for
     * a vault in someone else's Drive, whose trash is theirs.
     */
    private listsDeletedUnasked(): boolean {
        return (
            this.opened &&
            this.host.canListVersions() &&
            this.host.sharedBy() === null &&
            !HOLDING_OFF.has(this.host.summary().status)
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
            item.createDiv({ cls: 'proton-drive-sync-muted', text: pendingText(change) });
        }
        if (changes.length > MAX_PENDING_SHOWN) {
            list.createEl('li', { text: `…and ${changes.length - MAX_PENDING_SHOWN} more.` });
        }
    }
}
