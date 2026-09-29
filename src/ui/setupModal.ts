import { App, Modal, Setting } from 'obsidian';

import type ProtonDriveSyncPlugin from '../main';
import { FolderPickerModal } from './folderPickerModal';
import { SignInModal } from './signInModal';

/**
 * First-run setup: sign in, pick the Drive folder, choose what to sync, start.
 *
 * Opens by itself the first time the plugin loads, so a new install does not
 * have to discover three separate settings in the right order before anything
 * happens. Shown once only: closing it, finished or not, marks setup as done,
 * and everything it sets can be changed later in the plugin settings or by
 * running the "Set up Proton Drive Sync" command.
 *
 * Nothing syncs until "Start syncing": choosing a folder is the step that
 * decides what the first sync compares against, and the user should get to
 * choose what is included before it runs.
 */
export class SetupModal extends Modal {
    private started = false;
    /** Sign-in or folder changed here, with syncing held back until the modal closes. */
    private changed = false;

    constructor(
        app: App,
        private readonly plugin: ProtonDriveSyncPlugin,
    ) {
        super(app);
    }

    override onOpen(): void {
        this.setTitle('Set up Proton Drive Sync');
        this.render();
    }

    override onClose(): void {
        this.contentEl.empty();
        void this.finish(this.started);
    }

    private render(): void {
        const { contentEl } = this;
        contentEl.empty();

        const signedIn = this.plugin.session.isSignedIn();
        const { remoteFolderUid, remoteFolderPath } = this.plugin.settings;

        contentEl.createEl('p', {
            text:
                'Keep this vault in sync with a folder in your Proton Drive, end-to-end encrypted. ' +
                'Three steps, and you can change any of them later in the plugin settings.',
        });

        new Setting(contentEl)
            .setName('1. Sign in to Proton')
            .setDesc(
                signedIn
                    ? `Signed in as ${this.plugin.session.accountEmail ?? 'your Proton account'}.`
                    : 'Opens Proton in your browser. This plugin never sees your password.',
            )
            .addButton((button) => {
                button.setButtonText(signedIn ? 'Signed in' : 'Sign in').setDisabled(signedIn);
                if (!signedIn) {
                    button.setCta().onClick(() => {
                        new SignInModal(this.app, this.plugin, () => {
                            this.changed = true;
                            void this.plugin.onSignedIn({ connect: false }).then(() => this.render());
                        }).open();
                    });
                }
            });

        new Setting(contentEl)
            .setName('2. Choose a Drive folder')
            .setDesc(
                remoteFolderUid
                    ? `This vault will sync with "${remoteFolderPath ?? 'the chosen folder'}".`
                    : 'Use a folder of its own. Everything in it is treated as part of this vault. ' +
                          'Pick an existing folder to pull in a vault synced from another device.',
            )
            .addButton((button) => {
                button
                    .setButtonText(remoteFolderUid ? 'Change' : 'Choose')
                    .setDisabled(!signedIn)
                    .onClick(() => {
                        new FolderPickerModal(this.app, this.plugin.session.getClient(), (folder) => {
                            this.changed = true;
                            void this.plugin.setRemoteFolder(folder, { connect: false }).then(() => this.render());
                        }).open();
                    });
                if (signedIn && !remoteFolderUid) {
                    button.setCta();
                }
            });

        new Setting(contentEl)
            .setName('3. Sync Obsidian settings too')
            .setDesc(
                `Includes the ${this.app.vault.configDir} folder: appearance, hotkeys, installed plugins and ` +
                    'their settings. Pane layouts and this plugin’s sign-in stay on each device. ' +
                    'On a device joining an existing vault, the settings from Drive are used; ' +
                    'restart Obsidian after the first sync to apply them.',
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.syncObsidianConfig).onChange(async (value) => {
                    this.plugin.settings.syncObsidianConfig = value;
                    await this.plugin.saveSettings();
                }),
            );

        new Setting(contentEl)
            .addButton((button) =>
                button.setButtonText('Skip for now').onClick(() => {
                    this.close();
                }),
            )
            .addButton((button) =>
                button
                    .setButtonText('Start syncing')
                    .setCta()
                    .setDisabled(!signedIn || !remoteFolderUid)
                    .onClick(() => {
                        this.started = true;
                        this.close();
                    }),
            );
    }

    private async finish(started: boolean): Promise<void> {
        this.plugin.settings.onboardingComplete = true;
        await this.plugin.saveSettings();
        // Also on "Skip": if the user got as far as choosing a folder, they
        // expect it to be used, not to find out after a restart that nothing
        // ran. Left alone when nothing changed, so opening setup to look at
        // it does not interrupt a sync in progress.
        if (this.changed) {
            await this.plugin.reconnect();
        }
        if (started && this.plugin.settings.remoteFolderUid) {
            this.plugin.notify('Syncing with Proton Drive. Progress is shown in the status bar.');
        }
    }
}
