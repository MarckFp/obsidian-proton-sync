import { App, debounce, Notice, PluginSettingTab, Setting } from 'obsidian';

import type ProtonDriveSyncPlugin from '../main';
import { MIN_POLL_SECONDS } from '../settings';
import type { ConflictPolicy } from '../sync/types';
import type { LogLevel } from '../util/logger';
import { ConflictsModal } from './conflictsModal';
import { FolderPickerModal } from './folderPickerModal';
import { SignInModal } from './signInModal';

const CONFLICT_POLICIES: Record<ConflictPolicy, string> = {
    'keep-both': 'Keep both versions (recommended)',
    merge: 'Merge the changes, keep both if they overlap',
    'prefer-newest': 'Keep whichever was edited last',
    'prefer-local': 'Keep this device’s version',
    'prefer-remote': 'Keep the Drive version',
    manual: 'Ask me each time',
};

const CONFLICT_POLICY_HELP: Record<ConflictPolicy, string> = {
    'keep-both':
        'This device’s version keeps its filename; the other is saved beside it as a conflict copy. ' +
        'Both are synced everywhere, so nothing is lost.',
    merge:
        'Combines edits made to different parts of a note, the usual case when a device has been offline. ' +
        'Needs the previous version, which is fetched from Drive’s revision history. ' +
        'Falls back to keeping both when the edits overlap, when the file is not text, or when the ' +
        'previous revision is no longer available.',
    'prefer-newest':
        'Uses the modification times. Files uploaded by clients that recorded no modification time fall ' +
        'back to keeping both.',
    'prefer-local': 'The Drive version is saved as a conflict copy unless you turn copies off below.',
    'prefer-remote': 'This device’s version is saved as a conflict copy unless you turn copies off below.',
    manual: 'Nothing is written until you choose. Conflicted files are skipped by the sync in the meantime.',
};

const LOG_LEVELS: Record<LogLevel, string> = {
    debug: 'Debug (verbose)',
    info: 'Info',
    warn: 'Warnings',
    error: 'Errors only',
};

export class ProtonDriveSyncSettingsTab extends PluginSettingTab {
    constructor(
        app: App,
        private readonly plugin: ProtonDriveSyncPlugin,
    ) {
        super(app, plugin);
    }

    override display(): void {
        const { containerEl } = this;
        containerEl.empty();

        this.renderAccount(containerEl);
        this.renderFolder(containerEl);
        this.renderSyncBehaviour(containerEl);
        this.renderConflicts(containerEl);
        this.renderScope(containerEl);
        this.renderAdvanced(containerEl);
    }

    // -- account -----------------------------------------------------------

    private renderAccount(containerEl: HTMLElement): void {
        new Setting(containerEl).setName('Account').setHeading();

        const signedIn = this.plugin.session.isSignedIn();
        const email = this.plugin.session.accountEmail;

        new Setting(containerEl)
            .setName('Proton account')
            .setDesc(
                signedIn
                    ? `Signed in as ${email ?? 'your Proton account'}.`
                    : 'Sign in through Proton in your browser. This plugin never sees your password.',
            )
            .addButton((button) => {
                if (signedIn) {
                    button.setButtonText('Sign out').onClick(async () => {
                        await this.plugin.session.signOut();
                        await this.plugin.reconnect();
                        this.display();
                    });
                    return;
                }
                button
                    .setButtonText('Sign in')
                    .setCta()
                    .onClick(() => {
                        new SignInModal(this.app, this.plugin, () => {
                            void this.plugin.onSignedIn().then(() => this.display());
                        }).open();
                    });
            });
    }

    // -- folder ------------------------------------------------------------

    private renderFolder(containerEl: HTMLElement): void {
        new Setting(containerEl).setName('Drive folder').setHeading();

        const { remoteFolderPath, remoteFolderUid } = this.plugin.settings;

        new Setting(containerEl)
            .setName('Folder for this vault')
            .setDesc(
                remoteFolderUid
                    ? `Syncing with "${remoteFolderPath ?? 'a folder in your Drive'}". ` +
                          'The vault root maps onto this folder.'
                    : 'Choose the folder in your Drive that this vault maps onto. ' +
                          'Use a folder of its own — everything in it is treated as part of the vault.',
            )
            .addButton((button) =>
                button
                    .setButtonText(remoteFolderUid ? 'Change' : 'Choose')
                    .setCta()
                    .setDisabled(!this.plugin.session.isSignedIn())
                    .onClick(() => {
                        if (!this.plugin.session.isSignedIn()) {
                            new Notice('Sign in first.');
                            return;
                        }
                        new FolderPickerModal(this.app, this.plugin.session.getClient(), async (folder) => {
                            await this.plugin.setRemoteFolder(folder);
                            this.display();
                        }).open();
                    }),
            );
    }

    // -- behaviour ---------------------------------------------------------

    private renderSyncBehaviour(containerEl: HTMLElement): void {
        new Setting(containerEl).setName('Syncing').setHeading();

        new Setting(containerEl)
            .setName('Sync automatically')
            .setDesc('Upload changes as you make them, and pull in changes from other devices.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.autoSync).onChange(async (value) => {
                    this.plugin.settings.autoSync = value;
                    await this.plugin.saveSettings();
                }),
            );

        new Setting(containerEl)
            .setName('Sync on startup')
            .setDesc('Compare the whole vault against Drive when Obsidian opens.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.syncOnStartup).onChange(async (value) => {
                    this.plugin.settings.syncOnStartup = value;
                    await this.plugin.saveSettings();
                }),
            );

        new Setting(containerEl)
            .setName('Wait after an edit')
            .setDesc('How long a file must be untouched before it is uploaded, in milliseconds.')
            .addText((text) =>
                text
                    .setValue(String(this.plugin.settings.uploadDebounceMs))
                    .onChange(async (value) => {
                        const parsed = Number(value);
                        if (Number.isFinite(parsed) && parsed >= 0) {
                            this.plugin.settings.uploadDebounceMs = parsed;
                            await this.plugin.saveSettings();
                        }
                    }),
            );

        new Setting(containerEl)
            .setName('Check Drive every')
            .setDesc(
                `Seconds between checks for changes from other devices (minimum ${MIN_POLL_SECONDS}). ` +
                    'Proton Drive has no push channel, so this interval is the delay before a change made ' +
                    'elsewhere appears here. Proton rate-limits per account, and its guidelines ask ' +
                    'third-party clients not to poll aggressively — lower this only if you need to.',
            )
            .addText((text) =>
                text.setValue(String(this.plugin.settings.remotePollSeconds)).onChange(async (value) => {
                    const parsed = Number(value);
                    if (Number.isFinite(parsed) && parsed >= MIN_POLL_SECONDS) {
                        this.plugin.settings.remotePollSeconds = parsed;
                        await this.plugin.saveSettings();
                    }
                }),
            );

        new Setting(containerEl)
            .setName('Sync now')
            .setDesc('Compare everything against Drive right away.')
            .addButton((button) =>
                button.setButtonText('Sync now').onClick(async () => {
                    if (!this.plugin.isConfigured()) {
                        new Notice('Proton Drive Sync: sign in and choose a Drive folder first.');
                        return;
                    }
                    await this.plugin.engine.syncNow();
                    new Notice('Proton Drive Sync: finished.');
                }),
            );
    }

    // -- conflicts ---------------------------------------------------------

    private renderConflicts(containerEl: HTMLElement): void {
        new Setting(containerEl).setName('Conflicts').setHeading();

        const policy = this.plugin.settings.conflictPolicy;

        new Setting(containerEl)
            .setName('When a file changes in two places')
            .setDesc(CONFLICT_POLICY_HELP[policy])
            .addDropdown((dropdown) => {
                for (const [value, label] of Object.entries(CONFLICT_POLICIES)) {
                    dropdown.addOption(value, label);
                }
                dropdown.setValue(policy).onChange(async (value) => {
                    this.plugin.settings.conflictPolicy = value as ConflictPolicy;
                    await this.plugin.saveSettings();
                    this.display();
                });
            });

        if (policy === 'prefer-local' || policy === 'prefer-remote' || policy === 'prefer-newest') {
            new Setting(containerEl)
                .setName('Keep a copy of the version that loses')
                .setDesc('Strongly recommended. With this off, the losing version is discarded.')
                .addToggle((toggle) =>
                    toggle.setValue(this.plugin.settings.keepConflictCopies).onChange(async (value) => {
                        this.plugin.settings.keepConflictCopies = value;
                        await this.plugin.saveSettings();
                    }),
                );
        }

        const conflicts = this.plugin.state.conflicts().length;
        if (conflicts > 0) {
            new Setting(containerEl)
                .setName(`${conflicts} file${conflicts === 1 ? '' : 's'} waiting on a decision`)
                .addButton((button) =>
                    button
                        .setButtonText('Review')
                        .setCta()
                        .onClick(() => new ConflictsModal(this.app, this.plugin).open()),
                );
        }
    }

    // -- scope -------------------------------------------------------------

    /**
     * Saved once typing pauses. A changed exclusion list starts a full sync,
     * and saving on every keystroke would queue one per character.
     */
    private readonly saveExclusions = debounce(() => void this.plugin.saveSettings(), 1000, true);

    private renderScope(containerEl: HTMLElement): void {
        new Setting(containerEl).setName('What gets synced').setHeading();

        new Setting(containerEl)
            .setName('Sync Obsidian settings')
            .setDesc(
                `Include the ${this.app.vault.configDir} folder — appearance, hotkeys, installed plugins. ` +
                    'Pane layouts, caches and this plugin’s sign-in are always left out, because they belong ' +
                    'to each device. Changes there are picked up at every check for Drive changes.',
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.syncObsidianConfig).onChange(async (value) => {
                    this.plugin.settings.syncObsidianConfig = value;
                    await this.plugin.saveSettings();
                }),
            );

        new Setting(containerEl)
            .setName('Exclude')
            .setDesc(
                'One glob per line, matched against vault-relative paths. ' +
                    'For example: Private/ or **/*.pdf',
            )
            .addTextArea((text) =>
                text
                    .setValue(this.plugin.settings.excludePatterns.join('\n'))
                    .setPlaceholder('Private/\n**/*.pdf')
                    .onChange((value) => {
                        this.plugin.settings.excludePatterns = value
                            .split('\n')
                            .map((line) => line.trim())
                            .filter(Boolean);
                        this.saveExclusions();
                    }),
            );

        new Setting(containerEl)
            .setName('Skip files larger than')
            .setDesc('In megabytes. 0 means no limit.')
            .addText((text) =>
                text.setValue(String(this.plugin.settings.maxFileSizeMb)).onChange(async (value) => {
                    const parsed = Number(value);
                    if (Number.isFinite(parsed) && parsed >= 0) {
                        this.plugin.settings.maxFileSizeMb = parsed;
                        await this.plugin.saveSettings();
                    }
                }),
            );
    }

    // -- advanced ----------------------------------------------------------

    private renderAdvanced(containerEl: HTMLElement): void {
        new Setting(containerEl).setName('Advanced').setHeading();

        new Setting(containerEl)
            .setName('Device name')
            .setDesc('Used in conflict copy filenames, so you can tell which device a version came from.')
            .addText((text) =>
                text.setValue(this.plugin.settings.deviceName).onChange(async (value) => {
                    this.plugin.settings.deviceName = value;
                    await this.plugin.saveSettings();
                }),
            );

        new Setting(containerEl)
            .setName('Simultaneous transfers')
            .setDesc('Kept low on purpose: Proton rate-limits per account.')
            .addSlider((slider) =>
                slider
                    .setLimits(1, 8, 1)
                    .setDynamicTooltip()
                    .setValue(this.plugin.settings.transferConcurrency)
                    .onChange(async (value) => {
                        this.plugin.settings.transferConcurrency = value;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl).setName('Log level').addDropdown((dropdown) => {
            for (const [value, label] of Object.entries(LOG_LEVELS)) {
                dropdown.addOption(value, label);
            }
            dropdown.setValue(this.plugin.settings.logLevel).onChange(async (value) => {
                this.plugin.settings.logLevel = value as LogLevel;
                await this.plugin.saveSettings();
            });
        });

        new Setting(containerEl)
            .setName('Rebuild sync state')
            .setDesc(
                'Forgets what this device knows about the last sync and compares everything from scratch. ' +
                    'Nothing is deleted, but files that differ will be treated as conflicts, because there is ' +
                    'no longer a common version to compare against. Use this only if the sync is stuck.',
            )
            .addButton((button) =>
                button
                    .setButtonText('Rebuild')
                    .setWarning()
                    .onClick(async () => {
                        await this.plugin.rebuildState();
                        new Notice('Proton Drive Sync: sync state rebuilt.');
                    }),
            );

        this.renderLog(containerEl);
    }

    private renderLog(containerEl: HTMLElement): void {
        new Setting(containerEl).setName('Recent activity').setHeading();

        const log = containerEl.createEl('pre', { cls: 'proton-drive-sync-log' });
        const entries = this.plugin.logger.getEntries().slice(-50);

        if (entries.length === 0) {
            log.setText('Nothing logged yet.');
            return;
        }

        log.setText(
            entries
                .map(
                    (entry) =>
                        `${new Date(entry.time).toLocaleTimeString()} ${entry.level.toUpperCase().padEnd(5)} ` +
                        `${entry.message}`,
                )
                .join('\n'),
        );
    }
}
