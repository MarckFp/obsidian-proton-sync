import { App, Modal, Notice, Setting } from 'obsidian';
import { MemberRole, NodeType, type NodeEntity, type ProtonDriveClient } from '@protontech/drive-sdk';

import { accessRole, canWrite, iterateChildNodes, resolveNodes, sharedWithOthers } from '../sync/drive';
import type { Logger } from '../util/logger';

/** The folder the user picked, and whose it is. */
export type ChosenFolder = {
    uid: string;
    path: string;
    /** Used together with others: shared with this account, or shared by it. */
    shared: boolean;
    /** Owner's address when the folder is in someone else's Drive; null when it is the user's own. */
    sharedBy: string | null;
};

type Entry = { uid: string; name: string; detail?: string };

/**
 * One step of the breadcrumb. `shared-list` is the "Shared with me" level,
 * which is a list of folders from other people's Drives rather than a folder
 * of its own: nothing can be created in it, and it cannot be chosen.
 */
type Level = { kind: 'folder'; uid: string; name: string } | { kind: 'shared-list'; name: string };

const SHARED_WITH_ME = 'Shared with me';

/**
 * Browses the user's Drive so they can pick the folder the vault maps onto,
 * or create one.
 *
 * Deliberately a browser rather than a path box. A vault is bound to a node
 * uid, not a path, so that renaming the folder in Drive does not detach the
 * sync - but that means the user cannot type the answer, and picking the wrong
 * folder is the one configuration mistake that is expensive to undo.
 *
 * It starts at two places: the user's own My files, and the folders other
 * people shared with them, so that a vault can be shared by sharing its folder
 * in Proton Drive.
 */
export class FolderPickerModal extends Modal {
    /** Empty while showing the two starting places. */
    private stack: Level[] = [];
    private entries: Entry[] = [];
    private loading = false;
    /** The last listing failed, so an empty list says nothing about the folder. */
    private failed = false;
    private myFiles: NodeEntity | null = null;

    constructor(
        app: App,
        private readonly client: ProtonDriveClient,
        private readonly onChoose: (folder: ChosenFolder) => void,
        private readonly logger: Logger,
    ) {
        super(app);
    }

    override onOpen(): void {
        void this.openRoot();
    }

    override onClose(): void {
        this.contentEl.empty();
    }

    private async openRoot(): Promise<void> {
        this.contentEl.empty();
        this.contentEl.createEl('p', { text: 'Loading your Drive…' });
        try {
            this.myFiles = await this.client.getMyFilesRootFolder();
            this.stack = [];
            this.render();
        } catch (error) {
            this.contentEl.empty();
            this.contentEl.createEl('p', { text: `Could not open Drive: ${message(error)}` });
        }
    }

    private get current(): Level | undefined {
        return this.stack[this.stack.length - 1];
    }

    private get currentPath(): string {
        return this.stack.map((level) => level.name).join(' / ');
    }

    /** Whether the breadcrumb runs through "Shared with me". */
    private get inShared(): boolean {
        return this.stack[0]?.kind === 'shared-list';
    }

    private enter(level: Level): void {
        this.stack.push(level);
        void this.load();
    }

    private up(): void {
        this.stack.pop();
        if (this.stack.length === 0) {
            this.render();
            return;
        }
        void this.load();
    }

    private async load(): Promise<void> {
        const level = this.current;
        if (!level) {
            return;
        }
        this.loading = true;
        this.failed = false;
        this.render();

        const entries: Entry[] = [];
        try {
            if (level.kind === 'shared-list') {
                entries.push(...(await this.sharedFolders()));
            } else {
                for await (const child of iterateChildNodes(this.client, level.uid, { type: NodeType.Folder })) {
                    if (child.type === NodeType.Folder && child.trashTime === undefined && child.name.ok) {
                        entries.push({ uid: child.uid, name: child.name.value });
                    }
                }
            }
            entries.sort((a, b) => a.name.localeCompare(b.name));
            this.entries = entries;
        } catch (error) {
            new Notice(`Could not list that folder: ${message(error)}`);
            this.entries = [];
            this.failed = true;
        } finally {
            this.loading = false;
            this.render();
        }
    }

    /**
     * Folders shared with this account. A shared file cannot hold a vault, and
     * a name that cannot be decrypted cannot be shown, so both are left out.
     * Only shares already accepted are listed: an invitation is accepted in
     * Proton Drive first.
     */
    private async sharedFolders(): Promise<Entry[]> {
        const uids: string[] = [];
        for await (const uid of this.client.iterateSharedWithMeNodeUids()) {
            uids.push(uid);
        }
        const entries: Entry[] = [];
        for await (const node of resolveNodes(this.client, uids)) {
            if (node.type === NodeType.Folder && node.trashTime === undefined && node.name.ok) {
                const role = node.membership?.role ?? node.directRole;
                const owner = node.ownedBy.email ?? 'someone';
                entries.push({ uid: node.uid, name: node.name.value, detail: `${owner} · ${roleLabel(role)}` });
            }
        }
        return entries;
    }

    private render(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: 'Choose a Drive folder' });

        if (this.stack.length === 0) {
            this.renderPlaces();
            return;
        }

        contentEl.createEl('p', {
            cls: 'proton-drive-sync-breadcrumb',
            text: this.currentPath,
        });

        if (this.loading) {
            contentEl.createEl('p', { text: 'Loading…' });
            return;
        }

        new Setting(contentEl).setName('..').setDesc('Go up').addButton((button) =>
            button.setButtonText('Open').onClick(() => this.up()),
        );

        for (const entry of this.entries) {
            const row = new Setting(contentEl).setName(entry.name);
            if (entry.detail) {
                row.setDesc(entry.detail);
            }
            row.addButton((button) =>
                button.setButtonText('Open').onClick(() => this.enter({ kind: 'folder', uid: entry.uid, name: entry.name })),
            );
        }

        const current = this.current;
        if (this.failed) {
            contentEl.createEl('p', { text: 'Could not list this folder. Go up and open it again to retry.' });
        }
        if (current?.kind !== 'folder') {
            if (this.entries.length === 0 && !this.failed) {
                contentEl.createEl('p', {
                    text: 'Nothing is shared with you yet. Folders appear here once you accept the invitation in Proton Drive.',
                });
            }
            return;
        }

        if (this.entries.length === 0 && !this.failed) {
            contentEl.createEl('p', { text: 'No subfolders here.' });
        }

        new Setting(contentEl)
            .setName('New subfolder')
            .setDesc('Create a folder here and use it for this vault.')
            .addText((text) => {
                text.setPlaceholder('Obsidian vault');
                text.inputEl.addEventListener('keydown', (event) => {
                    if (event.key === 'Enter') {
                        void this.createAndChoose(text.getValue());
                    }
                });
            })
            .addButton((button) =>
                button.setButtonText('Create').onClick(async () => {
                    const input = this.contentEl.querySelector<HTMLInputElement>('input[type="text"]');
                    await this.createAndChoose(input?.value ?? '');
                }),
            );

        new Setting(contentEl).addButton((button) =>
            button
                .setButtonText(`Use "${current.name}"`)
                .setCta()
                .onClick(() => void this.choose(current.uid, this.currentPath)),
        );
    }

    private renderPlaces(): void {
        const { contentEl } = this;
        const myFiles = this.myFiles;
        if (myFiles) {
            new Setting(contentEl)
                .setName('My files')
                .setDesc('Your own Drive.')
                .addButton((button) =>
                    button.setButtonText('Open').onClick(() => this.enter({ kind: 'folder', uid: myFiles.uid, name: 'My files' })),
                );
        }
        new Setting(contentEl)
            .setName(SHARED_WITH_ME)
            .setDesc('Folders other people shared with you. A shared folder makes a vault you can use together.')
            .addButton((button) =>
                button.setButtonText('Open').onClick(() => this.enter({ kind: 'shared-list', name: SHARED_WITH_ME })),
            );
    }

    /**
     * Hand the folder over, once it is known that this account may write to
     * it. A vault syncs both ways, so a folder shared for viewing only would
     * fail on every upload; better to say so now than in a stream of errors.
     */
    private async choose(uid: string, path: string): Promise<void> {
        try {
            const [node, role, shared] = await Promise.all([
                this.client.getNode(uid),
                accessRole(this.client, uid),
                sharedWithOthers(this.client, uid).catch((error: unknown) => {
                    // Sharing metadata may be unreadable even when the folder
                    // itself is usable. Match the engine's conservative fallback:
                    // allow notes to sync, but keep plugin code out of config sync.
                    this.logger.warn(`Could not check whether the chosen folder is shared; treating it as shared: ${message(error)}`);
                    return true;
                }),
            ]);
            if (!canWrite(role)) {
                new Notice('This folder is shared with you for viewing only. Syncing a vault needs editor access; ask its owner.');
                return;
            }
            const foreign = this.inShared || (this.myFiles !== null && node.treeEventScopeId !== this.myFiles.treeEventScopeId);
            this.onChoose({
                uid,
                path,
                shared,
                sharedBy: foreign ? (node.ownedBy.email ?? 'someone') : null,
            });
            this.close();
        } catch (error) {
            this.logger.warn(`Could not check the chosen folder's node or access: ${message(error)}`);
            new Notice(`Could not check that folder: ${message(error)}`);
        }
    }

    private async createAndChoose(name: string): Promise<void> {
        const current = this.current;
        const trimmed = name.trim();
        if (!trimmed) {
            new Notice('Give the folder a name first.');
            return;
        }
        if (current?.kind !== 'folder') {
            return;
        }
        try {
            const folder = await this.client.createFolder(current.uid, trimmed);
            await this.choose(folder.uid, `${this.currentPath} / ${trimmed}`);
        } catch (error) {
            new Notice(`Could not create that folder: ${message(error)}`);
        }
    }
}

function roleLabel(role: MemberRole): string {
    switch (role) {
        case MemberRole.Admin:
            return 'admin';
        case MemberRole.Editor:
            return 'can edit';
        case MemberRole.Viewer:
            return 'view only';
        default:
            return 'access inherited';
    }
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
