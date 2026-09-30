import { App, debounce, Notice, Platform, PluginSettingTab, type SettingDefinitionItem } from 'obsidian';

import type ProtonDriveSyncPlugin from '../main';
import { MIN_POLL_SECONDS } from '../settings';
import { checkExcludePatterns } from '../sync/paths';
import type { ConflictPolicy } from '../sync/types';
import type { LogLevel } from '../util/logger';
import { ConflictsModal } from './conflictsModal';
import { FolderPickerModal } from './folderPickerModal';
import { SignInModal } from './signInModal';

export const CONFLICT_POLICIES: Record<ConflictPolicy, string> = {
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

    /**
     * Declarative, so every setting is reachable from Obsidian's settings
     * search. Rebuilt on each open and on `update()`, which is why values that
     * only feed a description (sign-in state, folder, conflict count) are read
     * here rather than cached.
     */
    override getSettingDefinitions(): SettingDefinitionItem[] {
        return [
            this.accountGroup(),
            this.folderGroup(),
            this.syncingGroup(),
            this.conflictsGroup(),
            this.scopeGroup(),
            this.mobileGroup(),
            this.advancedGroup(),
            this.logGroup(),
        ];
    }

    override getControlValue(key: string): unknown {
        if (key === 'excludePatterns') {
            return this.plugin.settings.excludePatterns.join('\n');
        }
        return (this.plugin.settings as Record<string, unknown>)[key];
    }

    override async setControlValue(key: string, value: unknown): Promise<void> {
        if (key === 'paused') {
            await this.plugin.setPaused(Boolean(value));
            // Resuming can be declined at the first-sync preview, leaving the
            // plugin paused after all; show what actually happened.
            this.update();
            return;
        }
        if (key === 'excludePatterns') {
            this.plugin.settings.excludePatterns = String(value)
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean);
            this.saveExclusions();
            return;
        }
        (this.plugin.settings as Record<string, unknown>)[key] = value;
        // Through the plugin rather than straight to disk, so the engine and
        // the logger pick the change up.
        await this.plugin.saveSettings();
        if (key === 'conflictPolicy') {
            // The policy's description and the copies toggle depend on it.
            this.update();
        }
    }

    /**
     * Saved once typing pauses. A changed exclusion list starts a full sync,
     * and saving on every keystroke would queue one per character.
     */
    private readonly saveExclusions = debounce(() => void this.plugin.saveSettings(), 1000, true);

    // -- account -----------------------------------------------------------

    private accountGroup(): SettingDefinitionItem {
        const signedIn = this.plugin.session.isSignedIn();
        const email = this.plugin.session.accountEmail;

        return {
            type: 'group',
            heading: 'Account',
            items: [
                {
                    name: 'Proton account',
                    desc: signedIn
                        ? `Signed in as ${email ?? 'your Proton account'}.`
                        : 'Sign in through Proton in your browser. This plugin never sees your password.',
                    aliases: ['sign in', 'sign out', 'login', 'logout'],
                    render: (setting) => {
                        setting.addButton((button) => {
                            if (signedIn) {
                                button.setButtonText('Sign out').onClick(async () => {
                                    await this.plugin.session.signOut();
                                    await this.plugin.reconnect();
                                    this.update();
                                });
                                return;
                            }
                            button
                                .setButtonText('Sign in')
                                .setCta()
                                .onClick(() => {
                                    new SignInModal(this.app, this.plugin, () => {
                                        void this.plugin.onSignedIn().then(() => this.update());
                                    }).open();
                                });
                        });
                    },
                },
            ],
        };
    }

    // -- folder ------------------------------------------------------------

    private folderGroup(): SettingDefinitionItem {
        const { remoteFolderPath, remoteFolderUid } = this.plugin.settings;

        return {
            type: 'group',
            heading: 'Drive folder',
            items: [
                {
                    name: 'Folder for this vault',
                    desc: remoteFolderUid
                        ? `Syncing with "${remoteFolderPath ?? 'a folder in your Drive'}". ` +
                          'The vault root maps onto this folder.'
                        : 'Choose the folder in your Drive that this vault maps onto. ' +
                          'Use a folder of its own — everything in it is treated as part of the vault.',
                    aliases: ['remote folder'],
                    render: (setting) => {
                        setting.addButton((button) =>
                            button
                                .setButtonText(remoteFolderUid ? 'Change' : 'Choose')
                                .setCta()
                                .setDisabled(!this.plugin.session.isSignedIn())
                                .onClick(() => {
                                    if (!this.plugin.session.isSignedIn()) {
                                        new Notice('Sign in first.');
                                        return;
                                    }
                                    new FolderPickerModal(this.app, this.plugin.session.getClient(), (folder) => {
                                        void this.plugin.setRemoteFolder(folder).then(() => this.update());
                                    }).open();
                                }),
                        );
                    },
                },
            ],
        };
    }

    // -- behaviour ---------------------------------------------------------

    private syncingGroup(): SettingDefinitionItem {
        return {
            type: 'group',
            heading: 'Syncing',
            items: [
                {
                    name: 'Pause syncing',
                    desc:
                        'Hold all syncing on this device. Anything changed in the meantime, here or elsewhere, ' +
                        'is synced when you resume.',
                    aliases: ['resume', 'stop'],
                    control: { type: 'toggle', key: 'paused' },
                },
                {
                    name: 'Sync automatically',
                    desc: 'Upload changes as you make them, and pull in changes from other devices.',
                    control: { type: 'toggle', key: 'autoSync' },
                },
                {
                    name: 'Sync on startup',
                    desc: 'Compare the whole vault against Drive when Obsidian opens.',
                    control: { type: 'toggle', key: 'syncOnStartup' },
                },
                {
                    name: 'Wait after an edit',
                    desc: 'How long a file must be untouched before it is uploaded, in milliseconds.',
                    aliases: ['debounce', 'delay'],
                    control: {
                        type: 'number',
                        key: 'uploadDebounceMs',
                        min: 0,
                        validate: (value) =>
                            Number.isFinite(value) && value >= 0 ? undefined : 'Enter zero or more milliseconds.',
                    },
                },
                {
                    name: 'Check Drive every',
                    desc:
                        `Seconds between checks for changes from other devices (minimum ${MIN_POLL_SECONDS}). ` +
                        'Proton Drive has no push channel, so this interval is the delay before a change made ' +
                        'elsewhere appears here. Proton rate-limits per account, and its guidelines ask ' +
                        'third-party clients not to poll aggressively — lower this only if you need to.',
                    aliases: ['poll', 'interval'],
                    control: {
                        type: 'number',
                        key: 'remotePollSeconds',
                        min: MIN_POLL_SECONDS,
                        validate: (value) =>
                            Number.isFinite(value) && value >= MIN_POLL_SECONDS
                                ? undefined
                                : `Enter at least ${MIN_POLL_SECONDS} seconds.`,
                    },
                },
                {
                    name: 'Sync now',
                    desc: 'Compare everything against Drive right away.',
                    render: (setting) => {
                        setting.addButton((button) =>
                            button.setButtonText('Sync now').onClick(async () => {
                                if (!this.plugin.isConfigured()) {
                                    new Notice('Proton Drive Sync: sign in and choose a Drive folder first.');
                                    return;
                                }
                                await this.plugin.engine.syncNow();
                                new Notice('Proton Drive Sync: finished.');
                            }),
                        );
                    },
                },
            ],
        };
    }

    // -- conflicts ---------------------------------------------------------

    private conflictsGroup(): SettingDefinitionItem {
        const policy = this.plugin.settings.conflictPolicy;
        const conflicts = this.plugin.state.conflicts().length;

        return {
            type: 'group',
            heading: 'Conflicts',
            items: [
                {
                    name: 'When a file changes in two places',
                    desc: CONFLICT_POLICY_HELP[policy],
                    aliases: ['conflict policy', 'merge'],
                    control: { type: 'dropdown', key: 'conflictPolicy', options: CONFLICT_POLICIES },
                },
                {
                    name: 'Keep a copy of the version that loses',
                    desc: 'Strongly recommended. With this off, the losing version is discarded.',
                    visible: () => {
                        const current = this.plugin.settings.conflictPolicy;
                        return current === 'prefer-local' || current === 'prefer-remote' || current === 'prefer-newest';
                    },
                    control: { type: 'toggle', key: 'keepConflictCopies' },
                },
                {
                    name: `${conflicts} file${conflicts === 1 ? '' : 's'} waiting on a decision`,
                    visible: conflicts > 0,
                    render: (setting) => {
                        setting.addButton((button) =>
                            button
                                .setButtonText('Review')
                                .setCta()
                                .onClick(() => new ConflictsModal(this.app, this.plugin).open()),
                        );
                    },
                },
            ],
        };
    }

    // -- scope -------------------------------------------------------------

    private scopeGroup(): SettingDefinitionItem {
        return {
            type: 'group',
            heading: 'What gets synced',
            items: [
                {
                    name: 'Sync Obsidian settings',
                    desc:
                        `Include the ${this.app.vault.configDir} folder — appearance, hotkeys, installed plugins. ` +
                        'Pane layouts, caches and this plugin’s sign-in are always left out, because they belong ' +
                        'to each device. Changes there are picked up at every check for Drive changes.',
                    aliases: ['config folder'],
                    control: { type: 'toggle', key: 'syncObsidianConfig' },
                },
                {
                    name: 'Exclude',
                    desc:
                        'One glob per line, matched against vault-relative paths. ' +
                        'For example: Private/ or **/*.pdf',
                    aliases: ['ignore', 'glob'],
                    control: {
                        type: 'textarea',
                        key: 'excludePatterns',
                        placeholder: 'Private/\n**/*.pdf',
                        validate: (value) => checkExcludePatterns(value.split('\n')),
                    },
                },
                {
                    name: 'Skip files larger than',
                    desc: 'In megabytes, in either direction. 0 means no limit.',
                    aliases: ['max file size'],
                    control: {
                        type: 'number',
                        key: 'maxFileSizeMb',
                        min: 0,
                        validate: (value) =>
                            Number.isFinite(value) && value >= 0 ? undefined : 'Enter zero or more megabytes.',
                    },
                },
            ],
        };
    }

    // -- mobile ------------------------------------------------------------

    private mobileGroup(): SettingDefinitionItem {
        const note = Platform.isMobileApp ? '' : ' Has no effect on this device, which is not a phone or tablet.';
        return {
            type: 'group',
            heading: 'On phones and tablets',
            items: [
                {
                    name: 'Sync on Wi-Fi only',
                    desc:
                        'Hold syncing while on mobile data and pick up when back on Wi-Fi. Only Android tells ' +
                        'apps which kind of connection they are on; on iOS this has no effect.' +
                        note,
                    aliases: ['cellular', 'mobile data', 'metered'],
                    control: { type: 'toggle', key: 'wifiOnly' },
                },
                {
                    name: 'Leave large files for other devices',
                    desc:
                        'Files larger than this, in megabytes, are neither uploaded nor downloaded here and ' +
                        'stay on whichever side has them, to be synced by a computer. 0 means no limit.' +
                        note,
                    aliases: ['max file size', 'attachments'],
                    control: {
                        type: 'number',
                        key: 'mobileMaxFileSizeMb',
                        min: 0,
                        validate: (value) =>
                            Number.isFinite(value) && value >= 0 ? undefined : 'Enter zero or more megabytes.',
                    },
                },
            ],
        };
    }

    // -- advanced ----------------------------------------------------------

    private advancedGroup(): SettingDefinitionItem {
        return {
            type: 'group',
            heading: 'Advanced',
            items: [
                {
                    name: 'Device name',
                    desc: 'Used in conflict copy filenames, so you can tell which device a version came from.',
                    control: { type: 'text', key: 'deviceName' },
                },
                {
                    name: 'Simultaneous transfers',
                    desc: 'Kept low on purpose: Proton rate-limits per account.',
                    aliases: ['concurrency'],
                    control: { type: 'slider', key: 'transferConcurrency', min: 1, max: 8, step: 1 },
                },
                {
                    name: 'Log level',
                    control: { type: 'dropdown', key: 'logLevel', options: LOG_LEVELS },
                },
                {
                    name: 'Rebuild sync state',
                    desc:
                        'Forgets what this device knows about the last sync and compares everything from scratch. ' +
                        'Nothing is deleted, but files that differ will be treated as conflicts, because there is ' +
                        'no longer a common version to compare against. Use this only if the sync is stuck.',
                    aliases: ['reset'],
                    render: (setting) => {
                        setting.addButton((button) =>
                            button
                                .setButtonText('Rebuild')
                                .setDestructive()
                                .onClick(async () => {
                                    await this.plugin.rebuildState();
                                    new Notice('Proton Drive Sync: sync state rebuilt.');
                                }),
                        );
                    },
                },
            ],
        };
    }

    private logGroup(): SettingDefinitionItem {
        return {
            type: 'group',
            heading: 'Recent activity',
            items: [
                {
                    name: 'Sync log',
                    desc: 'The last 50 entries, newest at the bottom.',
                    render: (setting) => {
                        setting.addButton((button) =>
                            button
                                .setButtonText('Copy log')
                                .setTooltip('Copy the full recent log, for a bug report')
                                .onClick(() => void this.plugin.copyLog()),
                        );
                        const log = setting.descEl.createEl('pre', { cls: 'proton-drive-sync-log' });
                        const entries = this.plugin.logger.getEntries().slice(-50);
                        log.setText(
                            entries.length === 0
                                ? 'Nothing logged yet.'
                                : entries
                                      .map(
                                          (entry) =>
                                              `${new Date(entry.time).toLocaleTimeString()} ` +
                                              `${entry.level.toUpperCase().padEnd(5)} ${entry.message}`,
                                      )
                                      .join('\n'),
                        );
                    },
                },
            ],
        };
    }
}
