import { App, Modal, Notice, Setting } from 'obsidian';

import type ProtonDriveSyncPlugin from '../main';
import type { ConflictRecord } from '../sync/conflictHistory';
import { isTextPath } from '../sync/media';
import type { ConflictInfo, ConflictReason } from '../sync/types';
import { compareWithConflictCopy, compareWithDrive } from './compare';
import { outcomeText, REASON_TEXT } from './conflictText';

const PENDING_REASON_TEXT: Record<ConflictReason, string> = {
    'both-modified': 'Edited here and on another device since the last sync.',
    'both-created': 'Created independently here and on another device.',
    'deleted-remotely-modified-locally': 'Deleted on another device, but edited here.',
    'deleted-locally-modified-remotely': 'Deleted here, but edited on another device.',
};

/**
 * Every conflict this device knows about, in two parts.
 *
 * "Waiting on you" lists the files the `manual` policy left for a decision.
 * "History" lists every conflict reported so far, however it was settled, so
 * that closing a notice never loses track of one: each can be opened, and
 * compared with its conflict copy for as long as the copy is there.
 */
export class ConflictsModal extends Modal {
    constructor(
        app: App,
        private readonly plugin: ProtonDriveSyncPlugin,
    ) {
        super(app);
    }

    override onOpen(): void {
        this.setTitle('Sync conflicts');
        this.render();
    }

    override onClose(): void {
        this.contentEl.empty();
    }

    private render(): void {
        const { contentEl } = this;
        contentEl.empty();
        this.renderPending(contentEl);
        this.renderHistory(contentEl);
    }

    // -- waiting on a decision ---------------------------------------------

    private renderPending(container: HTMLElement): void {
        const conflicts = this.plugin.state.conflicts();
        if (conflicts.length === 0) {
            return;
        }
        new Setting(container).setName('Waiting on you').setHeading();
        container.createEl('p', {
            cls: 'proton-drive-sync-muted',
            text:
                'These files changed in two places at once. Nothing has been overwritten — ' +
                'choose which version to keep, or keep both.',
        });
        for (const entry of conflicts) {
            this.renderPendingEntry(container, entry);
        }
    }

    private renderPendingEntry(container: HTMLElement, entry: { path: string; conflict: ConflictInfo }): void {
        const setting = new Setting(container).setName(entry.path).setDesc(PENDING_REASON_TEXT[entry.conflict.reason]);
        if (isTextPath(entry.path)) {
            setting.addButton((button) =>
                button
                    .setButtonText('Compare')
                    .setTooltip('Show what differs between this device and Drive')
                    .onClick(() => compareWithDrive(this.plugin, entry.path, () => this.render())),
            );
        }
        setting
            .addButton((button) =>
                button
                    .setButtonText('Keep both')
                    .setCta()
                    .onClick(() => void this.resolve(entry.path, 'keep-both')),
            )
            .addButton((button) =>
                button.setButtonText('Keep this device').onClick(() => void this.resolve(entry.path, 'prefer-local')),
            )
            .addButton((button) =>
                button.setButtonText('Keep Drive').onClick(() => void this.resolve(entry.path, 'prefer-remote')),
            );
    }

    /** Apply one decision, to this file only; see `SyncEngine.resolveConflict`. */
    private async resolve(path: string, policy: 'keep-both' | 'prefer-local' | 'prefer-remote'): Promise<void> {
        try {
            await this.plugin.engine.resolveConflict(path, policy);
            new Notice(`Resolved "${path}".`);
        } catch (error) {
            new Notice(`Could not resolve "${path}": ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            this.render();
        }
    }

    // -- history -----------------------------------------------------------

    private renderHistory(container: HTMLElement): void {
        const history = this.plugin.conflictHistory;
        const records = history.entries();

        const heading = new Setting(container).setName('History').setHeading();
        if (records.length > 0) {
            heading.addButton((button) =>
                button.setButtonText('Clear history').onClick(async () => {
                    await history.clear();
                    this.render();
                }),
            );
        }

        if (records.length === 0) {
            container.createEl('p', {
                cls: 'proton-drive-sync-muted',
                text:
                    this.plugin.state.conflicts().length === 0
                        ? 'No conflicts yet. Any that happen are listed here, however they were settled.'
                        : 'No settled conflicts yet.',
            });
            return;
        }

        container.createEl('p', {
            cls: 'proton-drive-sync-muted',
            text: 'Conflicts this device has seen, newest first. Only the most recent 200 are kept.',
        });
        for (const record of records) {
            this.renderRecord(container, record);
        }
    }

    private renderRecord(container: HTMLElement, record: ConflictRecord): void {
        const { vault, workspace } = this.app;
        const copyExists = record.copyPath !== undefined && vault.getFileByPath(record.copyPath) !== null;

        let description = `${new Date(record.time).toLocaleString()} · ${capitalise(REASON_TEXT[record.reason])}; ${outcomeText(record)}.`;
        if (record.copyPath !== undefined && !copyExists) {
            description += ' The copy has since been removed.';
        }

        const setting = new Setting(container).setName(record.path).setDesc(description);
        setting.settingEl.addClass('proton-drive-sync-history-entry');

        if (vault.getFileByPath(record.path)) {
            setting.addButton((button) =>
                button.setButtonText('Open').onClick(() => {
                    this.close();
                    void workspace.openLinkText(record.path, '', false);
                }),
            );
        }
        if (copyExists && isTextPath(record.path) && record.copyPath !== undefined) {
            const copyPath = record.copyPath;
            setting.addButton((button) =>
                button
                    .setButtonText('Compare')
                    .setTooltip('Show what differs between the note and its conflict copy')
                    .onClick(() => {
                        this.close();
                        compareWithConflictCopy(this.app, record.path, copyPath);
                    }),
            );
        }
        setting.addExtraButton((button) =>
            button
                .setIcon('x')
                .setTooltip('Remove from history')
                .onClick(async () => {
                    await this.plugin.conflictHistory.remove(record);
                    this.render();
                }),
        );
    }
}

function capitalise(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}
