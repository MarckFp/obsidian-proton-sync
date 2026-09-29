import { type App, Notice } from 'obsidian';

import type { ConflictEvent } from '../sync/engine';
import { basename } from '../sync/paths';
import type { ConflictReason } from '../sync/types';

/** Files listed by name; the rest are counted. */
const MAX_LISTED = 5;

const REASON_TEXT: Record<ConflictReason, string> = {
    'both-modified': 'edited here and on another device',
    'both-created': 'created here and on another device',
    'deleted-remotely-modified-locally': 'deleted on another device but edited here',
    'deleted-locally-modified-remotely': 'deleted here but edited on another device',
};

function outcomeText(event: ConflictEvent): string {
    switch (event.outcome) {
        case 'kept-both':
            return `both kept, the other version is "${basename(event.copyPath ?? '')}"`;
        case 'merged':
            return 'the edits were merged';
        case 'kept-local':
            return 'this device’s version was kept';
        case 'kept-remote':
            return 'the version from Drive was kept';
        case 'deferred':
            return 'waiting for you to choose';
    }
}

/**
 * Tell the user that a sync conflict happened, and to which files.
 *
 * Every policy but `manual` settles a conflict on its own, which is the point,
 * but the result still deserves a look: a conflict copy nobody notices is a
 * second version of a note drifting on its own. The notice stays until it is
 * dismissed, and each file in it opens on click.
 */
export function showConflictNotice(app: App, events: ConflictEvent[], reviewConflicts: () => void): void {
    if (events.length === 0) {
        return;
    }

    const fragment = createFragment((root) => {
        root.createDiv({
            cls: 'proton-drive-sync-notice-title',
            text:
                events.length === 1
                    ? 'Proton Drive Sync: a file changed in two places'
                    : `Proton Drive Sync: ${events.length} files changed in two places`,
        });

        const list = root.createEl('ul', { cls: 'proton-drive-sync-notice-list' });
        for (const event of events.slice(0, MAX_LISTED)) {
            const item = list.createEl('li');
            // Only notes the vault indexes can be opened; config files cannot.
            if (app.vault.getFileByPath(event.path)) {
                const link = item.createEl('a', { text: event.path, href: '#' });
                link.addEventListener('click', (click) => {
                    click.preventDefault();
                    void app.workspace.openLinkText(event.path, '', false);
                });
            } else {
                item.createSpan({ text: event.path });
            }
            item.appendText(`: ${REASON_TEXT[event.reason]}; ${outcomeText(event)}.`);
        }
        if (events.length > MAX_LISTED) {
            root.createDiv({
                text: `…and ${events.length - MAX_LISTED} more. The plugin settings list them under Recent activity.`,
            });
        }

        if (events.some((event) => event.outcome === 'deferred')) {
            const button = root.createEl('button', { text: 'Review conflicts', cls: 'mod-cta' });
            button.addEventListener('click', () => reviewConflicts());
        }
    });

    new Notice(fragment, 0);
}
