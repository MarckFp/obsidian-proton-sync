import { App, Modal, Setting } from 'obsidian';

import type { SyncPlan } from '../sync/engine';

/** Paths listed per group before the rest are counted. */
const MAX_LISTED = 200;

/**
 * What the first sync with a folder that already holds files is about to do,
 * with the choice to go ahead or hold off.
 *
 * This is the one moment a user cannot yet predict the plugin: pointing an
 * existing vault at an existing Drive folder mixes two sets of files, and a
 * surprise here is what makes people distrust a sync tool from day one. The
 * answer is resolved through `onDecision` exactly once; closing the dialog
 * counts as holding off.
 */
export class FirstSyncModal extends Modal {
    private decided = false;

    constructor(
        app: App,
        private readonly plan: SyncPlan,
        private readonly folderName: string,
        private readonly conflictPolicy: string,
        private readonly onDecision: (start: boolean) => void,
    ) {
        super(app);
    }

    override onOpen(): void {
        const { contentEl, plan } = this;
        this.setTitle('Before the first sync');

        contentEl.createEl('p', {
            text:
                `This vault has ${plan.localFiles} file${plural(plan.localFiles)} and "${this.folderName}" on ` +
                `Proton Drive has ${plan.remoteFiles}. Here is what syncing them will do. Nothing is deleted ` +
                'on either side by a first sync.',
        });

        const list = contentEl.createEl('ul', { cls: 'proton-drive-sync-plan' });
        this.group(list, plan.downloads, 'downloaded from Drive into this vault');
        this.group(list, plan.uploads, 'uploaded from this vault to Drive');
        this.group(
            list,
            plan.conflicts,
            `on both sides with different content. Your conflict setting decides: ${this.conflictPolicy}.`,
        );
        this.group(
            list,
            plan.settings,
            'of Obsidian settings replaced by the ones on Drive. Obsidian asks to reload afterwards to apply them.',
        );
        this.group(list, plan.held, 'over a size limit, so left where they are');
        this.group(list, plan.removals, 'removed, because an earlier sync recorded them');
        if (plan.unchanged > 0) {
            list.createEl('li', { text: `${plan.unchanged} already identical on both sides.` });
        }

        new Setting(contentEl)
            .addButton((button) =>
                button.setButtonText('Not now').onClick(() => {
                    this.decide(false);
                }),
            )
            .addButton((button) =>
                button
                    .setButtonText('Start syncing')
                    .setCta()
                    .onClick(() => {
                        this.decide(true);
                    }),
            );
        contentEl.createEl('p', {
            cls: 'proton-drive-sync-muted',
            text: 'Holding off pauses syncing. Resume it from the status bar or the command palette when ready.',
        });
    }

    override onClose(): void {
        this.contentEl.empty();
        if (!this.decided) {
            this.decided = true;
            this.onDecision(false);
        }
    }

    private decide(start: boolean): void {
        this.decided = true;
        this.onDecision(start);
        this.close();
    }

    private group(list: HTMLElement, paths: string[], description: string): void {
        if (paths.length === 0) {
            return;
        }
        const item = list.createEl('li');
        const details = item.createEl('details');
        details.createEl('summary', { text: `${paths.length} file${plural(paths.length)} ${description}` });
        const files = details.createEl('ul', { cls: 'proton-drive-sync-plan-files' });
        for (const path of paths.slice(0, MAX_LISTED)) {
            files.createEl('li', { text: path });
        }
        if (paths.length > MAX_LISTED) {
            files.createEl('li', { text: `…and ${paths.length - MAX_LISTED} more.` });
        }
    }
}

function plural(count: number): string {
    return count === 1 ? '' : 's';
}
