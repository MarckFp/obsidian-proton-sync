import { type App, Modal, Notice, Setting, SuggestModal, TFile } from 'obsidian';

import type ProtonDriveSyncPlugin from '../main';
import { MAX_MERGE_BYTES } from '../sync/conflicts';
import type { NoteVersion } from '../sync/engine';
import { isTextPath } from '../sync/media';
import { basename, conflictCopyOriginal, parentPath } from '../sync/paths';
import { DiffModal } from './diffModal';

/**
 * Show a conflict waiting on a decision as a diff of this device's version
 * against the one on Drive, with the three ways out underneath.
 */
export function compareWithDrive(plugin: ProtonDriveSyncPlugin, path: string, onResolved: () => void): void {
    if (!isTextPath(path)) {
        new Notice('Only text files can be compared.');
        return;
    }
    const resolve = (policy: 'keep-both' | 'prefer-local' | 'prefer-remote') => async () => {
        await plugin.engine.resolveConflict(path, policy);
        new Notice(`Resolved "${path}".`);
        onResolved();
    };

    new DiffModal(plugin.app, {
        title: basename(path),
        oldLabel: 'This device',
        newLabel: 'Proton Drive',
        load: async () => {
            const [oldText, remote] = await Promise.all([
                readIfExists(plugin.app, path),
                plugin.engine.readRemoteVersion(path, MAX_MERGE_BYTES),
            ]);
            return { oldText, newText: remote === null ? '' : new TextDecoder().decode(remote) };
        },
        actions: [
            { label: 'Keep this device’s version', keeps: 'removed', run: resolve('prefer-local') },
            { label: 'Keep both', run: resolve('keep-both') },
            { label: 'Keep the Drive version', keeps: 'added', run: resolve('prefer-remote') },
        ],
    }).open();
}

/**
 * Show a note against one of its conflict copies, with the choice of keeping
 * the note as it is or taking the copy's content, either way retiring the
 * copy. The copy goes to the trash Obsidian is configured to use, so a wrong
 * choice can be undone from there.
 */
export function compareWithConflictCopy(app: App, originalPath: string, copyPath: string): void {
    new DiffModal(app, {
        title: basename(originalPath),
        oldLabel: basename(originalPath),
        newLabel: basename(copyPath),
        load: async () => ({
            oldText: await readIfExists(app, originalPath),
            newText: await readIfExists(app, copyPath),
        }),
        actions: [
            {
                label: 'Keep the note, delete the copy',
                keeps: 'removed',
                run: async () => {
                    await trash(app, copyPath);
                    new Notice(`Kept "${basename(originalPath)}".`);
                },
            },
            {
                label: 'Replace the note with the copy',
                keeps: 'added',
                run: async () => {
                    const original = app.vault.getFileByPath(originalPath);
                    const copy = app.vault.getFileByPath(copyPath);
                    if (!original || !copy) {
                        throw new Error('one of the files no longer exists');
                    }
                    await app.vault.modify(original, await app.vault.read(copy));
                    await trash(app, copyPath);
                    new Notice(`Replaced "${basename(originalPath)}" with the copy.`);
                },
            },
        ],
    }).open();
}

/**
 * The conflict copy and note pair for `file`, whichever of the two it is.
 * Returns the pairs to choose between: one when `file` is a copy, one per
 * copy when it is a note with several.
 */
export function conflictPairsFor(app: App, file: TFile): { original: string; copy: string }[] {
    if (!isTextPath(file.path)) {
        return [];
    }
    const original = conflictCopyOriginal(file.path);
    if (original !== null) {
        return app.vault.getFileByPath(original) ? [{ original, copy: file.path }] : [];
    }
    const folder = parentPath(file.path);
    return app.vault
        .getFiles()
        .filter((candidate) => parentPath(candidate.path) === folder && conflictCopyOriginal(candidate.path) === file.path)
        .sort((a, b) => b.stat.mtime - a.stat.mtime)
        .map((copy) => ({ original: file.path, copy: copy.path }));
}

/** Compare `file` with its conflict copy, asking which one first if there are several. */
export function compareConflictCopyOf(app: App, file: TFile): void {
    const pairs = conflictPairsFor(app, file);
    if (pairs.length === 0) {
        new Notice('This note has no conflict copy.');
    } else if (pairs.length === 1) {
        compareWithConflictCopy(app, pairs[0].original, pairs[0].copy);
    } else {
        new ConflictCopyPicker(app, pairs).open();
    }
}

class ConflictCopyPicker extends SuggestModal<{ original: string; copy: string }> {
    constructor(
        app: App,
        private readonly pairs: { original: string; copy: string }[],
    ) {
        super(app);
        this.setPlaceholder('Which conflict copy?');
    }

    override getSuggestions(query: string): { original: string; copy: string }[] {
        const needle = query.toLowerCase();
        return this.pairs.filter((pair) => pair.copy.toLowerCase().includes(needle));
    }

    override renderSuggestion(pair: { original: string; copy: string }, el: HTMLElement): void {
        el.setText(basename(pair.copy));
    }

    override onChooseSuggestion(pair: { original: string; copy: string }): void {
        compareWithConflictCopy(this.app, pair.original, pair.copy);
    }
}

/**
 * Show a note against one of its earlier versions on Drive, with the choice
 * to bring that version back. Lines only in the note as it is now are red
 * with `-`, lines only in the earlier version green with `+`, so the green
 * "Restore" button keeps the green side, as in every other comparison here.
 *
 * Restoring writes that version into the note, and the sync uploads it as a
 * new version: the one it replaces stays in Drive's history, so a restore can
 * itself be undone from the same list.
 */
export function compareWithVersion(plugin: ProtonDriveSyncPlugin, path: string, version: NoteVersion): void {
    const when = new Date(version.created).toLocaleString();
    const restore = async (data: ArrayBuffer) => {
        await plugin.restoreVersion(path, data);
        new Notice(`Restored the version of "${basename(path)}" from ${when}. It syncs as a new version.`);
    };
    const unsynced = plugin.hasUnsyncedChanges(path)
        ? 'This note has changes that are not on Drive yet. Restoring replaces them, and they are not in the history.'
        : undefined;

    if (!isTextPath(path) || (version.size ?? 0) > MAX_MERGE_BYTES) {
        new RestoreModal(plugin.app, basename(path), when, unsynced, async () =>
            restore(await plugin.engine.readVersion(version.uid)),
        ).open();
        return;
    }

    let versionData: ArrayBuffer | null = null;
    new DiffModal(plugin.app, {
        title: `${basename(path)}: version from ${when}`,
        oldLabel: 'This note now',
        newLabel: `Version from ${when}`,
        ...(unsynced !== undefined && { warning: unsynced }),
        load: async () => {
            versionData = await plugin.engine.readVersion(version.uid);
            return { oldText: await readIfExists(plugin.app, path), newText: new TextDecoder().decode(versionData) };
        },
        actions: [
            {
                label: 'Restore this version',
                keeps: 'added',
                run: async () => {
                    await restore(versionData ?? (await plugin.engine.readVersion(version.uid)));
                },
            },
        ],
    }).open();
}

/** Confirmation for restoring a version that cannot be shown as a diff, such as an image. */
class RestoreModal extends Modal {
    constructor(
        app: App,
        private readonly name: string,
        private readonly when: string,
        private readonly warning: string | undefined,
        private readonly restore: () => Promise<void>,
    ) {
        super(app);
    }

    override onOpen(): void {
        this.setTitle(`Restore ${this.name}?`);
        this.contentEl.createEl('p', {
            text:
                `Replace "${this.name}" with its version from ${this.when}. The version it replaces stays in ` +
                'Drive’s history, so this can be undone the same way.',
        });
        if (this.warning) {
            this.contentEl.createEl('p', { cls: 'proton-drive-sync-pin-warning', text: this.warning });
        }
        new Setting(this.contentEl)
            .addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
            .addButton((button) =>
                button
                    .setButtonText('Restore')
                    .setCta()
                    .onClick(async () => {
                        button.setDisabled(true);
                        try {
                            await this.restore();
                            this.close();
                        } catch (error) {
                            new Notice(`Could not restore: ${error instanceof Error ? error.message : String(error)}`);
                            button.setDisabled(false);
                        }
                    }),
            );
    }

    override onClose(): void {
        this.contentEl.empty();
    }
}

async function readIfExists(app: App, path: string): Promise<string> {
    return (await app.vault.adapter.exists(path)) ? app.vault.adapter.read(path) : '';
}

async function trash(app: App, path: string): Promise<void> {
    const file = app.vault.getAbstractFileByPath(path);
    if (file) {
        await app.fileManager.trashFile(file);
    }
}
