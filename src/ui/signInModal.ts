import { App, Modal, Notice, Setting } from 'obsidian';

import type ProtonDriveSyncPlugin from '../main';

/**
 * Walks the user through Proton's browser sign-in.
 *
 * The plugin never sees the password. Proton's session-fork flow hands the user
 * to a real account.proton.me page and returns a forked session afterwards,
 * which means two-factor codes, security keys and SSO all keep working without
 * this plugin implementing any of them - and a third-party plugin never handles
 * the credential that unlocks the user's whole account.
 */
export class SignInModal extends Modal {
    private abortController = new AbortController();
    private finished = false;

    constructor(
        app: App,
        private readonly plugin: ProtonDriveSyncPlugin,
        private readonly onSignedIn: () => void,
    ) {
        super(app);
    }

    override onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: 'Sign in to Proton' });

        const status = contentEl.createEl('p', {
            text: 'Opening Proton in your browser…',
        });

        void this.begin(contentEl, status);
    }

    override onClose(): void {
        this.contentEl.empty();
        if (!this.finished) {
            this.abortController.abort();
        }
    }

    private async begin(contentEl: HTMLElement, status: HTMLElement): Promise<void> {
        let handle;
        try {
            handle = await this.plugin.session.beginWebSignIn(this.abortController.signal);
        } catch (error) {
            status.setText(`Could not start sign-in: ${message(error)}`);
            return;
        }

        status.setText(
            'Approve this device in the Proton page that just opened, then come back here. ' +
                'This window will close by itself.',
        );

        // The URL is shown as well as opened, because the browser may not be
        // the one the user is signed into, and a link they can copy is the
        // difference between a solvable problem and a dead end.
        new Setting(contentEl)
            .setName('Sign-in link')
            .setDesc('Open this in a browser where you are signed in to Proton.')
            .addButton((button) =>
                button
                    .setButtonText('Open again')
                    .setCta()
                    .onClick(() => window.open(handle.url, '_blank')),
            )
            .addButton((button) =>
                button.setButtonText('Copy link').onClick(async () => {
                    await navigator.clipboard.writeText(handle.url);
                    new Notice('Sign-in link copied.');
                }),
            );

        window.open(handle.url, '_blank');

        try {
            const email = await handle.completion;
            this.finished = true;
            new Notice(`Signed in to Proton Drive as ${email}.`);
            this.onSignedIn();
            this.close();
        } catch (error) {
            if (this.abortController.signal.aborted) {
                return;
            }
            status.setText(`Sign-in failed: ${message(error)}`);
        }
    }
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
