import { type App, ButtonComponent, ExtraButtonComponent, Modal } from 'obsidian';

import type { DeletedItem } from '../sync/engine';
import { basename } from '../sync/paths';
import { ConfirmModal } from './confirmModal';
import type { DriveList } from './driveList';
import { pageOf, renderPager } from './pager';
import { formatBytes, timeAgo } from './syncStatus';

/** What the dialog needs: the trash, as the sync panel keeps it listed, and a way to restore from it. */
export type DeletedHost = {
    deleted: DriveList<DeletedItem[]>;
    /** Whether Drive can be asked now: signed in, a folder chosen, unlocked and connected. */
    canList(): boolean;
    /**
     * Owner of the synced folder when it is in someone else's Drive. Files
     * deleted there go to the owner's trash, which this account cannot list.
     */
    sharedBy(): string | null;
    /** List the trash again. */
    reload(): void;
    /** Take one out of the trash; the next check brings it back. */
    restore(item: DeletedItem): Promise<void>;
};

/**
 * Notes deleted from the vault, on any device, are kept in Drive's trash
 * until it is emptied. This lists them, most recently deleted first, ten to a
 * page, and brings one back after asking: it is restored on Drive, and the
 * next check downloads it into the vault.
 *
 * The list is the sync panel's, listed when the sync starts and again as often
 * as Drive is checked for changes, so the dialog opens on it at once.
 */
export class DeletedModal extends Modal {
    private page = 0;
    /** What the dialog shows now; see {@link render}. */
    private shown = '';
    private unsubscribe: (() => void) | null = null;

    constructor(
        app: App,
        private readonly host: DeletedHost,
    ) {
        super(app);
    }

    override onOpen(): void {
        this.setTitle('Recently deleted');
        this.unsubscribe = this.host.deleted.onChange(() => this.render());
        const { deleted } = this.host;
        if (deleted.items === undefined && !deleted.loading && this.host.canList() && this.host.sharedBy() === null) {
            // Not listed for the panel, while syncing is paused say: asked for now.
            this.host.reload();
        }
        this.render();
    }

    override onClose(): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.contentEl.empty();
    }

    /**
     * The trash as it stands. Drawn again when what it shows changes, and only
     * then: it is listed again in the background, and redrawing for nothing
     * would take a Restore button away from under a finger.
     */
    private render(): void {
        const { items, error, loading } = this.host.deleted;
        const canList = this.host.canList();
        const owner = this.host.sharedBy();
        const signature = JSON.stringify([canList, owner, items, error?.message, items === undefined && loading, this.page]);
        if (signature === this.shown) {
            return;
        }
        this.shown = signature;

        const { contentEl } = this;
        contentEl.empty();
        const say = (text: string) => contentEl.createEl('p', { cls: 'proton-drive-sync-muted', text });
        if (!canList) {
            say('Sign in, choose a Drive folder and unlock to see deleted notes.');
            return;
        }
        if (owner !== null) {
            say(`This vault is shared with you by ${owner}. Deleted notes go to their Proton Drive trash; ask them to restore one.`);
            return;
        }

        const header = contentEl.createDiv({ cls: 'proton-drive-sync-list-header' });
        header.createSpan({
            cls: 'proton-drive-sync-muted',
            text: 'Files from this vault in Drive’s trash, most recently deleted first.',
        });
        new ExtraButtonComponent(header)
            .setIcon('refresh-cw')
            .setTooltip('List Drive’s trash again')
            .onClick(() => this.host.reload());

        if (error) {
            say(`Could not list the trash: ${error.message}`);
        }
        if (items === undefined) {
            if (!error) {
                say('Listing Drive’s trash…');
            }
            return;
        }
        if (items.length === 0) {
            say('Nothing from this vault is in Drive’s trash.');
            return;
        }

        const shown = pageOf(items, this.page);
        this.page = shown.page;
        const list = contentEl.createDiv({ cls: 'proton-drive-sync-list' });
        for (const item of shown.items) {
            const row = list.createDiv({ cls: 'proton-drive-sync-deleted' });
            const text = row.createDiv({ cls: 'proton-drive-sync-deleted-text' });
            text.createDiv({ text: item.isFolder ? `${item.path}/ (folder)` : item.path });
            const details = [`deleted ${timeAgo(item.deleted)}`];
            if (item.size !== undefined) {
                details.push(formatBytes(item.size));
            }
            if (item.withFolder) {
                details.push(`comes back with ${item.withFolder}`);
            }
            text.createDiv({ cls: 'proton-drive-sync-muted', text: details.join(' · ') });
            new ButtonComponent(row).setButtonText('Restore').onClick(() => this.confirmRestore(item));
        }
        renderPager(contentEl, shown.page, shown.pages, (page) => {
            this.page = page;
            this.render();
            this.titleEl.scrollIntoView({ block: 'nearest' });
        });
    }

    /** Ask before taking an item out of the trash, then take it off the list. */
    private confirmRestore(item: DeletedItem): void {
        let text = item.isFolder
            ? `Take the folder "${item.path}" and everything in it out of Drive’s trash.`
            : `Take "${item.path}" out of Drive’s trash.`;
        text += ' It comes back into the vault with the next check.';
        if (item.withFolder) {
            text += ` The folder "${item.withFolder}" it was in comes back too.`;
        }
        new ConfirmModal(this.app, {
            title: `Restore ${basename(item.path)}?`,
            text,
            action: 'Restore',
            run: async () => {
                await this.host.restore(item);
                const restored = new Set(item.restoreUids);
                this.host.deleted.set((this.host.deleted.items ?? []).filter((other) => !restored.has(other.uid)));
            },
        }).open();
    }
}
