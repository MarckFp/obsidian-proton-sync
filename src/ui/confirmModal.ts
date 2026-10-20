import { type App, Modal, Notice, Setting } from 'obsidian';

export type ConfirmOptions = {
    title: string;
    text: string;
    /** The label of the button that goes ahead. */
    action: string;
    run: () => Promise<void>;
};

/**
 * Ask before doing something: Cancel, or the button that does it. Closes once
 * it is done; if it fails, says why and stays open to try again.
 */
export class ConfirmModal extends Modal {
    constructor(
        app: App,
        private readonly options: ConfirmOptions,
    ) {
        super(app);
    }

    override onOpen(): void {
        this.setTitle(this.options.title);
        this.contentEl.createEl('p', { text: this.options.text });
        new Setting(this.contentEl)
            .addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
            .addButton((button) =>
                button
                    .setButtonText(this.options.action)
                    .setCta()
                    .onClick(async () => {
                        button.setDisabled(true);
                        try {
                            await this.options.run();
                            this.close();
                        } catch (error) {
                            new Notice(
                                `${this.options.action} failed: ${error instanceof Error ? error.message : String(error)}`,
                            );
                            button.setDisabled(false);
                        }
                    }),
            );
    }

    override onClose(): void {
        this.contentEl.empty();
    }
}
