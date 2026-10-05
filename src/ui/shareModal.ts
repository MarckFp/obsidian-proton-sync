import { type App, Modal, Notice, Setting, type TextComponent } from 'obsidian';

import type { ShareLink } from '../sync/drive';
import { basename } from '../sync/paths';

/** What the dialog needs: the note's link on Drive, and ways to make or remove one. */
export type ShareHost = {
    load(): Promise<ShareLink | null>;
    create(options: { password?: string; expiration?: Date }): Promise<ShareLink>;
    remove(): Promise<void>;
};

/** Choices for how long a new link works. */
export const EXPIRY_CHOICES: { label: string; days: number | null }[] = [
    { label: 'Never', days: null },
    { label: '1 day', days: 1 },
    { label: '7 days', days: 7 },
    { label: '30 days', days: 30 },
];

/** The expiry date for a choice of days, counted from `now`. */
export function expiryFor(days: number | null, now = Date.now()): Date | undefined {
    return days === null ? undefined : new Date(now + days * 24 * 60 * 60 * 1000);
}

/**
 * A note's public link on Proton Drive: the one it has, with Copy and Stop
 * sharing, or a form to make one, read-only, with an optional password and
 * expiry. The link is copied to the clipboard when made or on Copy, and never
 * at any other time.
 *
 * The link opens the file as it is on Drive at the time, in Proton's web
 * viewer; anyone who has it can open it, so the dialog says so before it is
 * made. The decryption key is in the link's `#` part, which browsers do not
 * send to the server, so Proton cannot read the note through it either.
 */
export class ShareModal extends Modal {
    constructor(
        app: App,
        private readonly path: string,
        private readonly host: ShareHost,
    ) {
        super(app);
    }

    override onOpen(): void {
        this.setTitle(`Share ${basename(this.path)}`);
        this.contentEl.createEl('p', { cls: 'proton-drive-sync-muted', text: 'Looking for a link…' });
        void this.refresh();
    }

    override onClose(): void {
        this.contentEl.empty();
    }

    private async refresh(): Promise<void> {
        let link: ShareLink | null;
        try {
            link = await this.host.load();
        } catch (error) {
            this.contentEl.empty();
            this.contentEl.createEl('p', { text: `Could not check for a link: ${message(error)}` });
            return;
        }
        this.contentEl.empty();
        if (link) {
            this.renderLink(link);
        } else {
            this.renderCreate();
        }
    }

    private renderLink(link: ShareLink): void {
        const { contentEl } = this;
        contentEl.createEl('p', { text: 'Anyone with this link can open the note as it is on Proton Drive.' });
        contentEl.createEl('input', {
            cls: 'proton-drive-sync-share-url',
            attr: { type: 'text', readonly: 'true', value: link.url },
        });
        const facts = [
            link.hasPassword ? 'Protected with a password' : 'No password',
            link.expiration ? `expires ${link.expiration.toLocaleString()}` : 'does not expire',
            `opened ${link.downloads} time${link.downloads === 1 ? '' : 's'}`,
        ];
        contentEl.createEl('p', { cls: 'proton-drive-sync-muted', text: facts.join(' · ') });

        new Setting(contentEl)
            .addButton((button) =>
                button
                    .setButtonText('Stop sharing')
                    .setDestructive()
                    .onClick(async () => {
                        button.setDisabled(true);
                        try {
                            await this.host.remove();
                            new Notice(`"${basename(this.path)}" is no longer shared.`);
                            this.close();
                        } catch (error) {
                            new Notice(`Could not stop sharing: ${message(error)}`);
                            button.setDisabled(false);
                        }
                    }),
            )
            .addButton((button) =>
                button
                    .setButtonText('Copy link')
                    .setCta()
                    .onClick(async () => {
                        await copy(link.url);
                        this.close();
                    }),
            );
    }

    private renderCreate(): void {
        const { contentEl } = this;
        contentEl.createEl('p', {
            text:
                'Make a public link to this note on Proton Drive. Anyone with the link can open it, read-only, ' +
                'as it is on Drive when they open it, until you stop sharing.',
        });

        let password = '';
        let days: number | null = null;
        const passwordSetting = new Setting(contentEl)
            .setName('Password')
            .setDesc('Optional. Whoever opens the link must type it.');
        let field!: TextComponent;
        passwordSetting.addText((text) => {
            field = text;
            text.inputEl.type = 'password';
            text.inputEl.autocomplete = 'new-password';
            text.onChange((value) => (password = value));
        });
        passwordSetting.addExtraButton((button) => {
            const show = (visible: boolean) => {
                field.inputEl.type = visible ? 'text' : 'password';
                button.setIcon(visible ? 'eye-off' : 'eye').setTooltip(visible ? 'Hide password' : 'Show password');
            };
            show(false);
            button.onClick(() => show(field.inputEl.type === 'password'));
        });
        new Setting(contentEl).setName('Expires').addDropdown((dropdown) => {
            for (const [index, choice] of EXPIRY_CHOICES.entries()) {
                dropdown.addOption(String(index), choice.label);
            }
            dropdown.onChange((value) => (days = EXPIRY_CHOICES[Number(value)]?.days ?? null));
        });

        new Setting(contentEl)
            .addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
            .addButton((button) =>
                button
                    .setButtonText('Create and copy link')
                    .setCta()
                    .onClick(async () => {
                        button.setDisabled(true);
                        try {
                            const expiration = expiryFor(days);
                            const link = await this.host.create({
                                ...(password !== '' && { password }),
                                ...(expiration && { expiration }),
                            });
                            await copy(link.url);
                            this.close();
                        } catch (error) {
                            new Notice(`Could not make a link: ${message(error)}`);
                            button.setDisabled(false);
                        }
                    }),
            );
    }
}

async function copy(url: string): Promise<void> {
    try {
        await navigator.clipboard.writeText(url);
        new Notice('Share link copied.');
    } catch {
        new Notice(`Could not copy the link; it is ${url}`);
    }
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
