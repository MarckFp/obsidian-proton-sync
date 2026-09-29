import { App, Modal, Notice, Setting } from 'obsidian';

import type ProtonDriveSyncPlugin from '../main';
import type { ConflictInfo, ConflictReason } from '../sync/types';

const REASON_TEXT: Record<ConflictReason, string> = {
    'both-modified': 'Edited here and on another device since the last sync.',
    'both-created': 'Created independently here and on another device.',
    'deleted-remotely-modified-locally': 'Deleted on another device, but edited here.',
    'deleted-locally-modified-remotely': 'Deleted here, but edited on another device.',
};

/**
 * Lists the files waiting on a decision, under the `manual` conflict policy.
 *
 * Only reachable in that mode: every other policy resolves conflicts as they
 * are found, and leaves a conflict copy in the vault rather than an entry here.
 */
export class ConflictsModal extends Modal {
    constructor(
        app: App,
        private readonly plugin: ProtonDriveSyncPlugin,
    ) {
        super(app);
    }

    override onOpen(): void {
        this.render();
    }

    override onClose(): void {
        this.contentEl.empty();
    }

    private render(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: 'Sync conflicts' });

        const conflicts = this.plugin.state.conflicts();
        if (conflicts.length === 0) {
            contentEl.createEl('p', { text: 'Nothing is waiting on a decision.' });
            return;
        }

        contentEl.createEl('p', {
            text:
                'These files changed in two places at once. Nothing has been overwritten — ' +
                'choose which version to keep, or keep both.',
        });

        for (const entry of conflicts) {
            this.renderConflict(contentEl, entry);
        }
    }

    private renderConflict(container: HTMLElement, entry: { path: string; conflict: ConflictInfo }): void {
        const reason: ConflictReason = entry.conflict.reason;

        new Setting(container)
            .setName(entry.path)
            .setDesc(REASON_TEXT[reason])
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

    /**
     * Apply one decision.
     *
     * The choice is applied by clearing the conflict flag and re-running the
     * normal sync for just that path with a temporary policy, rather than by a
     * separate code path — so a manual resolution goes through exactly the
     * checks and the ordering that an automatic one does.
     */
    private async resolve(path: string, policy: 'keep-both' | 'prefer-local' | 'prefer-remote'): Promise<void> {
        const original = this.plugin.settings.conflictPolicy;
        try {
            this.plugin.state.clearConflict(path);
            this.plugin.settings.conflictPolicy = policy;
            this.plugin.engine.updateSettings(this.plugin.settings);

            await this.plugin.engine.syncPath(path);
            new Notice(`Resolved "${path}".`);
        } catch (error) {
            new Notice(`Could not resolve "${path}": ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            this.plugin.settings.conflictPolicy = original;
            this.plugin.engine.updateSettings(this.plugin.settings);
            this.render();
        }
    }
}
