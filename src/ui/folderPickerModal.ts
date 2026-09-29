import { App, Modal, Notice, Setting } from 'obsidian';
import { NodeType, type ProtonDriveClient } from '@protontech/drive-sdk';

type Entry = { uid: string; name: string };

/**
 * Browses the user's Drive so they can pick the folder the vault maps onto,
 * or create one.
 *
 * Deliberately a browser rather than a path box. A vault is bound to a node
 * uid, not a path, so that renaming the folder in Drive does not detach the
 * sync - but that means the user cannot type the answer, and picking the wrong
 * folder is the one configuration mistake that is expensive to undo.
 */
export class FolderPickerModal extends Modal {
    private stack: { uid: string; name: string }[] = [];
    private entries: Entry[] = [];
    private loading = false;

    constructor(
        app: App,
        private readonly client: ProtonDriveClient,
        private readonly onChoose: (folder: { uid: string; path: string }) => void,
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
            const root = await this.client.getMyFilesRootFolder();
            this.stack = [{ uid: root.uid, name: 'My files' }];
            await this.load();
        } catch (error) {
            this.contentEl.empty();
            this.contentEl.createEl('p', { text: `Could not open Drive: ${message(error)}` });
        }
    }

    private get current(): { uid: string; name: string } {
        return this.stack[this.stack.length - 1]!;
    }

    private get currentPath(): string {
        return this.stack.map((entry) => entry.name).join(' / ');
    }

    private async load(): Promise<void> {
        this.loading = true;
        this.render();

        const entries: Entry[] = [];
        try {
            for await (const child of this.client.iterateFolderChildren(this.current.uid)) {
                if (child.type === NodeType.Folder && child.trashTime === undefined && child.name.ok) {
                    entries.push({ uid: child.uid, name: child.name.value });
                }
            }
            entries.sort((a, b) => a.name.localeCompare(b.name));
            this.entries = entries;
        } catch (error) {
            new Notice(`Could not list that folder: ${message(error)}`);
            this.entries = [];
        } finally {
            this.loading = false;
            this.render();
        }
    }

    private render(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: 'Choose a Drive folder' });
        contentEl.createEl('p', {
            cls: 'proton-drive-sync-breadcrumb',
            text: this.currentPath,
        });

        if (this.loading) {
            contentEl.createEl('p', { text: 'Loading…' });
            return;
        }

        if (this.stack.length > 1) {
            new Setting(contentEl).setName('..').setDesc('Go up').addButton((button) =>
                button.setButtonText('Open').onClick(() => {
                    this.stack.pop();
                    void this.load();
                }),
            );
        }

        for (const entry of this.entries) {
            new Setting(contentEl).setName(entry.name).addButton((button) =>
                button.setButtonText('Open').onClick(() => {
                    this.stack.push(entry);
                    void this.load();
                }),
            );
        }

        if (this.entries.length === 0) {
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
                .setButtonText(`Use "${this.current.name}"`)
                .setCta()
                .onClick(() => {
                    this.onChoose({ uid: this.current.uid, path: this.currentPath });
                    this.close();
                }),
        );
    }

    private async createAndChoose(name: string): Promise<void> {
        const trimmed = name.trim();
        if (!trimmed) {
            new Notice('Give the folder a name first.');
            return;
        }
        try {
            const folder = await this.client.createFolder(this.current.uid, trimmed);
            this.onChoose({ uid: folder.uid, path: `${this.currentPath} / ${trimmed}` });
            this.close();
        } catch (error) {
            new Notice(`Could not create that folder: ${message(error)}`);
        }
    }
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
