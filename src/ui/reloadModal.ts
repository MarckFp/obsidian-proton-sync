import { App, Modal, Setting } from 'obsidian';

/**
 * After a first sync brought Obsidian settings down from Drive: say what
 * arrived and ask for a reload.
 *
 * A dialog rather than a notice because the reload is not optional in effect.
 * Obsidian reads its settings, and loads plugins, themes and CSS snippets, only
 * at startup, so until it reloads the vault looks and behaves like a fresh one
 * even though everything is already on disk.
 */
export class ReloadModal extends Modal {
    constructor(
        app: App,
        private readonly paths: string[],
        private readonly reload: () => void,
    ) {
        super(app);
    }

    override onOpen(): void {
        const { contentEl } = this;
        this.setTitle('Reload to apply your settings');

        contentEl.createEl('p', {
            text:
                'Your Obsidian settings have been downloaded from Proton Drive. Obsidian only loads them when ' +
                'it starts, so reload it to see them in effect.',
        });

        const arrived = summarise(this.paths, this.app.vault.configDir);
        if (arrived.length > 0) {
            const list = contentEl.createEl('ul');
            for (const line of arrived) {
                list.createEl('li', { text: line });
            }
        }

        contentEl.createEl('p', {
            cls: 'proton-drive-sync-muted',
            text:
                'Your notes keep syncing in the meantime, and reloading now is safe: the sync picks up where it ' +
                'left off. It is also quicker now than once every note has arrived. Until you reload, settings ' +
                'changes on this device are not uploaded, so the defaults it is still running on cannot replace ' +
                'yours on Drive. To reload later, run "Reload app without saving" from the command palette, or ' +
                'restart Obsidian.',
        });

        new Setting(contentEl)
            .addButton((button) => button.setButtonText('Later').onClick(() => this.close()))
            .addButton((button) =>
                button
                    .setButtonText('Reload now')
                    .setCta()
                    .onClick(() => {
                        this.close();
                        this.reload();
                    }),
            );
    }

    override onClose(): void {
        this.contentEl.empty();
    }
}

/** "3 community plugins", "1 theme"…: what the downloaded settings files amount to. */
export function summarise(paths: string[], configDir: string): string[] {
    const plugins = new Set<string>();
    const themes = new Set<string>();
    let snippets = 0;
    let other = 0;
    for (const path of paths) {
        const inside = path.slice(configDir.length + 1).split('/');
        if (inside[0] === 'plugins' && inside.length > 2) {
            plugins.add(inside[1]);
        } else if (inside[0] === 'themes' && inside.length > 2) {
            themes.add(inside[1]);
        } else if (inside[0] === 'snippets' && inside.length === 2 && inside[1].endsWith('.css')) {
            snippets++;
        } else {
            other++;
        }
    }
    const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    return [
        plugins.size > 0 ? count(plugins.size, 'community plugin', 'community plugins') : '',
        themes.size > 0 ? count(themes.size, 'theme', 'themes') : '',
        snippets > 0 ? count(snippets, 'CSS snippet', 'CSS snippets') : '',
        other > 0 ? count(other, 'settings file', 'settings files') : '',
    ].filter(Boolean);
}
