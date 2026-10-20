import { App, Modal, Notice, Setting } from 'obsidian';

import { changedRange, diffLines, toSegments, type DiffLine } from '../sync/diff';

export type DiffAction = {
    label: string;
    /**
     * Which version this action keeps: `removed` for the one shown in red
     * with `-`, `added` for the one in green with `+`. The button takes the
     * same colour and sign, so it is plain which lines a click keeps. Left
     * out for an action that keeps both, which stays neutral.
     */
    keeps?: 'removed' | 'added';
    run: () => Promise<void>;
};

export type DiffOptions = {
    /** The version whose lines are shown with `-`. */
    oldLabel: string;
    /** The version whose lines are shown with `+`. */
    newLabel: string;
    load: () => Promise<{ oldText: string; newText: string }>;
    /** Buttons under the diff; whatever shows the diff is done once one has run. */
    actions?: DiffAction[];
    /** A warning shown above the diff, such as changes an action would replace. */
    warning?: string;
};

export type DiffModalOptions = DiffOptions & { title: string };

/**
 * Two versions of a note as one unified diff, the way a code review shows a
 * change: lines only in the old version in red with `-`, lines only in the
 * new one in green with `+`, a few unchanged lines around each change for
 * context, and the rest folded away. Within a changed line, the part that
 * actually differs is highlighted, so a one-word edit to a long paragraph is
 * visible at a glance.
 *
 * The Markdown is shown as source, not rendered: a diff is about which
 * characters changed, and rendering hides exactly the changes (a link target,
 * a heading level, trailing spaces) that are easiest to miss.
 */
export class DiffModal extends Modal {
    constructor(
        app: App,
        private readonly options: DiffModalOptions,
    ) {
        super(app);
    }

    override onOpen(): void {
        this.setTitle(this.options.title);
        this.modalEl.addClass('proton-drive-sync-diff-modal');
        void showDiff(this.contentEl, this.options, () => this.close());
    }

    override onClose(): void {
        this.contentEl.empty();
    }
}

/**
 * Load both versions and show them as a diff in `container`, with the actions
 * under it, the way {@link DiffModal} does; `done` runs once an action has.
 * For a dialog that compares as one of its steps, such as a note's versions.
 */
export async function showDiff(container: HTMLElement, options: DiffOptions, done: () => void): Promise<void> {
    container.empty();
    container.createEl('p', { text: 'Comparing…', cls: 'proton-drive-sync-muted' });
    let texts: { oldText: string; newText: string };
    try {
        texts = await options.load();
    } catch (error) {
        container.empty();
        container.createEl('p', {
            text: `Could not load both versions: ${error instanceof Error ? error.message : String(error)}`,
        });
        return;
    }
    renderDiff(container, texts.oldText, texts.newText, options, done);
}

function renderDiff(container: HTMLElement, oldText: string, newText: string, options: DiffOptions, done: () => void): void {
    container.empty();

    const result = diffLines(oldText, newText);
    if (!result.ok) {
        container.createEl('p', {
            text:
                result.reason === 'binary'
                    ? 'These files are not text, so there is nothing to compare line by line.'
                    : 'These versions differ in too many lines to compare here.',
        });
        renderActions(container, options, done);
        return;
    }

    if (options.warning) {
        container.createEl('p', { cls: 'proton-drive-sync-pin-warning', text: options.warning });
    }
    const header = container.createDiv({ cls: 'proton-drive-sync-diff-header' });
    header.createSpan({ cls: 'proton-drive-sync-diff-legend mod-removed', text: `− ${options.oldLabel}` });
    header.createSpan({ cls: 'proton-drive-sync-diff-legend mod-added', text: `+ ${options.newLabel}` });
    const stats = header.createSpan({ cls: 'proton-drive-sync-diff-stats' });
    stats.createSpan({ cls: 'mod-added', text: `+${result.added}` });
    stats.appendText(' ');
    stats.createSpan({ cls: 'mod-removed', text: `−${result.removed}` });

    if (result.added === 0 && result.removed === 0) {
        container.createEl('p', { text: 'The two versions are identical.' });
        renderActions(container, options, done);
        return;
    }

    const body = container.createDiv({ cls: 'proton-drive-sync-diff' });
    for (const segment of toSegments(result.lines)) {
        if (segment.kind === 'hunk') {
            body.createDiv({ cls: 'proton-drive-sync-diff-hunk', text: segment.header });
            renderLines(body, segment.lines);
            continue;
        }
        const count = segment.lines.length;
        const fold = body.createEl('button', {
            cls: 'proton-drive-sync-diff-fold',
            text: `Show ${count} unchanged line${count === 1 ? '' : 's'}`,
        });
        fold.addEventListener('click', () => {
            const placeholder = createDiv();
            fold.replaceWith(placeholder);
            renderLines(placeholder, segment.lines);
            placeholder.replaceWith(...Array.from(placeholder.childNodes));
        });
    }

    renderActions(container, options, done);
}

function renderActions(container: HTMLElement, options: DiffOptions, done: () => void): void {
    const actions = options.actions ?? [];
    if (actions.length === 0) {
        return;
    }
    const hint = container.createEl('p', { cls: 'proton-drive-sync-diff-hint' });
    hint.appendText('Choose the version to keep: ');
    hint.createSpan({ cls: 'mod-removed', text: `red (−) keeps ${options.oldLabel}` });
    hint.appendText(', ');
    hint.createSpan({ cls: 'mod-added', text: `green (+) keeps ${options.newLabel}` });
    hint.appendText('.');

    const setting = new Setting(container);
    setting.settingEl.addClass('proton-drive-sync-diff-actions');
    for (const action of actions) {
        setting.addButton((button) => {
            const sign = action.keeps === 'removed' ? '− ' : action.keeps === 'added' ? '+ ' : '';
            button.setButtonText(`${sign}${action.label}`);
            if (action.keeps) {
                button.buttonEl.addClass('proton-drive-sync-diff-action', `mod-${action.keeps}`);
            }
            button.onClick(async () => {
                button.setDisabled(true);
                try {
                    await action.run();
                    done();
                } catch (error) {
                    new Notice(`${action.label} failed: ${error instanceof Error ? error.message : String(error)}`);
                    button.setDisabled(false);
                }
            });
        });
    }
}

/**
 * Append diff rows. A run of removed lines directly followed by a run of
 * added ones is read as those lines having been edited, and each pair gets
 * the differing part of the line highlighted.
 */
function renderLines(container: HTMLElement, lines: DiffLine[]): void {
    const partner = new Map<number, number>();
    for (let index = 0; index < lines.length; ) {
        if (lines[index].type !== 'removed') {
            index++;
            continue;
        }
        const removedStart = index;
        while (index < lines.length && lines[index].type === 'removed') {
            index++;
        }
        const addedStart = index;
        while (index < lines.length && lines[index].type === 'added') {
            index++;
        }
        const pairs = Math.min(addedStart - removedStart, index - addedStart);
        for (let k = 0; k < pairs; k++) {
            partner.set(removedStart + k, addedStart + k);
            partner.set(addedStart + k, removedStart + k);
        }
    }

    lines.forEach((line, index) => {
        const row = container.createDiv({ cls: `proton-drive-sync-diff-line mod-${line.type}` });
        row.createSpan({ cls: 'proton-drive-sync-diff-no', text: line.type === 'added' ? '' : String(line.oldNo) });
        row.createSpan({ cls: 'proton-drive-sync-diff-no', text: line.type === 'removed' ? '' : String(line.newNo) });
        row.createSpan({
            cls: 'proton-drive-sync-diff-sign',
            text: line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ',
        });
        const text = row.createSpan({ cls: 'proton-drive-sync-diff-text' });

        const other = partner.get(index);
        if (other === undefined || line.type === 'context') {
            text.setText(line.text);
            return;
        }
        const [oldLine, newLine] = line.type === 'removed' ? [line.text, lines[other].text] : [lines[other].text, line.text];
        const range = changedRange(oldLine, newLine);
        const [start, end] = line.type === 'removed' ? range.old : range.new;
        text.appendText(line.text.slice(0, start));
        if (end > start) {
            text.createSpan({ cls: 'proton-drive-sync-diff-change', text: line.text.slice(start, end) });
        }
        text.appendText(line.text.slice(end));
    });
}
