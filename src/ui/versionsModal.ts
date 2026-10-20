import { type App, ButtonComponent, ExtraButtonComponent, Modal, Notice, Setting } from 'obsidian';

import type { NoteVersion } from '../sync/engine';
import { basename } from '../sync/paths';
import { labelButton } from './buttons';
import type { VersionComparison } from './compare';
import { showDiff } from './diffModal';
import type { DriveList } from './driveList';
import { pageOf, renderPager } from './pager';
import { formatBytes, timeAgo } from './syncStatus';

/** What the dialog needs: the note's versions, as the sync panel keeps them listed, and what choosing one shows. */
export type VersionsHost = {
    versions: DriveList<NoteVersion[] | null>;
    /** List the versions again. */
    reload(): void;
    compare(version: NoteVersion): VersionComparison;
};

/**
 * A note's versions on Proton Drive, newest first, ten to a page, the current
 * one marked. Choosing one turns the dialog into a comparison of that version
 * with the note as it is now, with the choice to bring it back, and "All
 * versions" to go back to the list.
 *
 * The list is the sync panel's, listed again whenever the note syncs a new
 * version, so the dialog opens on it at once and shows a new one as it comes.
 */
export class VersionsModal extends Modal {
    /** The page of the list, kept while a version is compared. */
    private page = 0;
    /** The version being compared; null while the list is shown. */
    private comparing: NoteVersion | null = null;
    /** What the list shows now; see {@link renderList}. */
    private shown = '';
    private unsubscribe: (() => void) | null = null;

    constructor(
        app: App,
        private readonly path: string,
        private readonly host: VersionsHost,
    ) {
        super(app);
    }

    override onOpen(): void {
        this.unsubscribe = this.host.versions.onChange(() => this.renderList());
        this.showList();
    }

    override onClose(): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.contentEl.empty();
    }

    private showList(): void {
        this.comparing = null;
        this.shown = '';
        this.modalEl.removeClass('proton-drive-sync-diff-modal');
        this.setTitle(`Versions of ${basename(this.path)}`);
        this.renderList();
    }

    /**
     * The list as it stands. Drawn again when what it shows changes, and only
     * then: it is listed again in the background, and redrawing for nothing
     * would take a version away from under a finger about to choose it.
     */
    private renderList(): void {
        if (this.comparing !== null) {
            return;
        }
        const { items, error, loading } = this.host.versions;
        const signature = JSON.stringify([items, error?.message, items === undefined && loading, this.page]);
        if (signature === this.shown) {
            return;
        }
        this.shown = signature;

        const { contentEl } = this;
        contentEl.empty();
        const header = contentEl.createDiv({ cls: 'proton-drive-sync-list-header' });
        header.createSpan({
            cls: 'proton-drive-sync-muted',
            text: 'Newest first. Choose one to compare it with the note as it is now.',
        });
        new ExtraButtonComponent(header)
            .setIcon('refresh-cw')
            .setTooltip('List the versions again')
            .onClick(() => this.host.reload());

        const say = (text: string) => contentEl.createEl('p', { cls: 'proton-drive-sync-muted', text });
        if (error) {
            say(`Could not list the versions: ${error.message}`);
        }
        if (items === undefined) {
            if (!error) {
                say('Listing versions…');
            }
            return;
        }
        if (items === null) {
            say('This note is not on Proton Drive yet, so it has no versions there.');
            return;
        }
        if (items.length === 0) {
            say('No versions on Drive.');
            return;
        }

        const shown = pageOf(items, this.page);
        this.page = shown.page;
        const list = contentEl.createDiv({ cls: 'proton-drive-sync-list' });
        for (const version of shown.items) {
            const item = list.createEl('button', { cls: 'proton-drive-sync-version' });
            const top = item.createDiv({ cls: 'proton-drive-sync-version-date' });
            top.setText(new Date(version.created).toLocaleString());
            if (version.active) {
                top.createSpan({ cls: 'proton-drive-sync-badge', text: 'Current' });
            }
            const details = [timeAgo(version.created)];
            if (version.size !== undefined) {
                details.push(formatBytes(version.size));
            }
            item.createDiv({ cls: 'proton-drive-sync-muted', text: details.join(' · ') });
            item.addEventListener('click', () => this.showVersion(version));
        }
        renderPager(contentEl, shown.page, shown.pages, (page) => {
            this.page = page;
            this.renderList();
            this.titleEl.scrollIntoView({ block: 'nearest' });
        });
    }

    /** Compare one version with the note as it is now, in place of the list. */
    private showVersion(version: NoteVersion): void {
        this.comparing = version;
        const comparison = this.host.compare(version);
        this.setTitle(comparison.title);
        const { contentEl } = this;
        contentEl.empty();
        labelButton(new ButtonComponent(contentEl), 'arrow-left', 'All versions')
            .onClick(() => this.showList())
            .buttonEl.addClass('proton-drive-sync-back');
        // A diff loading after "All versions" lands here, out of sight.
        const body = contentEl.createDiv();

        if (comparison.kind === 'diff') {
            this.modalEl.addClass('proton-drive-sync-diff-modal');
            void showDiff(body, comparison.diff, () => this.close());
            return;
        }
        body.createEl('p', { text: comparison.text });
        if (comparison.warning) {
            body.createEl('p', { cls: 'proton-drive-sync-pin-warning', text: comparison.warning });
        }
        new Setting(body)
            .addButton((button) => button.setButtonText('Cancel').onClick(() => this.showList()))
            .addButton((button) =>
                button
                    .setButtonText('Restore')
                    .setCta()
                    .onClick(async () => {
                        button.setDisabled(true);
                        try {
                            await comparison.restore();
                            this.close();
                        } catch (error) {
                            new Notice(`Could not restore: ${error instanceof Error ? error.message : String(error)}`);
                            button.setDisabled(false);
                        }
                    }),
            );
    }
}
