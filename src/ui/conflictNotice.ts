import { type App, Notice } from 'obsidian';

import type { ConflictEvent } from '../sync/engine';
import { isTextPath } from '../sync/media';
import { outcomeText, REASON_TEXT } from './conflictText';

/** Files listed by name; the rest are counted. */
const MAX_LISTED = 5;

/**
 * Tell the user that a sync conflict happened, and to which files.
 *
 * Every policy but `manual` settles a conflict on its own, which is the point,
 * but the result still deserves a look: a conflict copy nobody notices is a
 * second version of a note drifting on its own. The notice stays until it is
 * dismissed, each file in it opens on click, and every conflict in it also
 * stays listed in the conflicts dialog afterwards.
 */
export type ConflictNoticeActions = {
    reviewConflicts: () => void;
    /** Compare a note with the conflict copy written beside it. */
    compare: (path: string, copyPath: string) => void;
};

export function showConflictNotice(app: App, events: ConflictEvent[], actions: ConflictNoticeActions): void {
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
            const { copyPath } = event;
            if (copyPath && isTextPath(event.path) && app.vault.getFileByPath(copyPath)) {
                item.appendText(' ');
                const compare = item.createEl('a', { text: 'Compare', href: '#' });
                compare.addEventListener('click', (click) => {
                    click.preventDefault();
                    actions.compare(event.path, copyPath);
                });
            }
        }
        if (events.length > MAX_LISTED) {
            root.createDiv({ text: `…and ${events.length - MAX_LISTED} more.` });
        }

        // Always offered: closing the notice must not be the last chance to
        // see these, so the conflicts dialog keeps a history of them.
        const waiting = events.some((event) => event.outcome === 'deferred');
        const button = root.createEl('button', {
            text: waiting ? 'Review conflicts' : 'Show all conflicts',
            cls: waiting ? 'mod-cta' : '',
        });
        button.addEventListener('click', () => actions.reviewConflicts());
    });

    new Notice(fragment, 0);
}
