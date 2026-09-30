import { App, Modal, Setting, TextComponent } from 'obsidian';

import { MIN_PIN_LENGTH } from '../proton/pinLock';

/** Wrong PINs allowed before each further try has to wait, doubling up to {@link MAX_WAIT_SECONDS}. */
const FREE_ATTEMPTS = 3;
const MAX_WAIT_SECONDS = 60;

const LOST_PIN_WARNING =
    'The PIN is not stored anywhere, not even on this device. If you forget it, it cannot be recovered: you ' +
    'will have to sign in to Proton again on this device and choose a new PIN. Your notes are not affected.';

export type UnlockOptions = {
    verify: (pin: string) => Promise<boolean>;
    /** Delete the locked session, for a forgotten PIN. */
    forget: () => Promise<void>;
    /** Wrong tries so far, kept by the caller so closing and reopening does not reset the wait. */
    failures: { count: number };
    onDone: (result: 'unlocked' | 'dismissed' | 'forgotten') => void;
};

/**
 * Asks for the PIN when the plugin starts, before anything can sync.
 *
 * After a few wrong tries, each further one waits, longer every time. That
 * slows someone guessing at the unlocked device; it cannot slow an attacker
 * who copied the encrypted session elsewhere, which is what the key
 * derivation's cost is for, and why a longer PIN is worth it.
 */
export class UnlockModal extends Modal {
    private settled = false;

    constructor(
        app: App,
        private readonly options: UnlockOptions,
    ) {
        super(app);
    }

    override onOpen(): void {
        const { contentEl } = this;
        this.setTitle('Unlock Proton Drive Sync');
        contentEl.createEl('p', {
            text: 'Your Proton sign-in on this device is protected with a PIN. Enter it to start syncing.',
        });

        let input!: TextComponent;
        const error = contentEl.createEl('p', { cls: 'proton-drive-sync-pin-error' });
        let unlockButton!: HTMLButtonElement;

        const submit = async () => {
            const wait = this.secondsToWait();
            if (wait > 0) {
                error.setText(`Too many wrong PINs. Try again in ${wait} seconds.`);
                return;
            }
            unlockButton.disabled = true;
            error.setText('Checking…');
            const ok = await this.options.verify(input.getValue());
            unlockButton.disabled = false;
            if (ok) {
                this.options.failures.count = 0;
                this.finish('unlocked');
                return;
            }
            this.options.failures.count++;
            input.setValue('');
            const next = this.secondsToWait();
            error.setText(next > 0 ? `Wrong PIN. Try again in ${next} seconds.` : 'Wrong PIN.');
        };

        const field = new Setting(contentEl).setName('PIN').addText((text) => {
            input = text;
            text.inputEl.type = 'password';
            text.inputEl.autocomplete = 'current-password';
            text.inputEl.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    void submit();
                }
            });
        });
        addRevealButton(field, input);

        new Setting(contentEl)
            .addButton((button) =>
                button
                    .setButtonText('Forgot PIN')
                    .setDestructive()
                    .onClick(() => this.confirmForget()),
            )
            .addButton((button) => button.setButtonText('Not now').onClick(() => this.finish('dismissed')))
            .addButton((button) => {
                unlockButton = button.buttonEl;
                button
                    .setButtonText('Unlock')
                    .setCta()
                    .onClick(() => void submit());
            });

        window.setTimeout(() => input.inputEl.focus(), 0);
    }

    override onClose(): void {
        this.contentEl.empty();
        this.finish('dismissed');
    }

    private confirmForget(): void {
        const { contentEl } = this;
        contentEl.empty();
        this.setTitle('Forgot your PIN?');
        contentEl.createEl('p', {
            text:
                'A forgotten PIN cannot be recovered. This deletes the locked Proton sign-in from this device; ' +
                'you then sign in again and can choose a new PIN. Your notes, here and on Drive, are not touched.',
        });
        contentEl.createEl('p', {
            cls: 'proton-drive-sync-muted',
            text:
                'The old session cannot be ended from here, because ending it needs the PIN. To end it now, go to ' +
                'account.proton.me → Security → Sessions and revoke "external-drive-obsidian_sync"; otherwise ' +
                'it expires on its own.',
        });
        new Setting(contentEl)
            .addButton((button) => button.setButtonText('Back').onClick(() => {
                contentEl.empty();
                this.onOpen();
            }))
            .addButton((button) =>
                button
                    .setButtonText('Delete sign-in')
                    .setDestructive()
                    .onClick(async () => {
                        await this.options.forget();
                        this.finish('forgotten');
                    }),
            );
    }

    private secondsToWait(): number {
        const extra = this.options.failures.count - FREE_ATTEMPTS + 1;
        return extra <= 0 ? 0 : Math.min(MAX_WAIT_SECONDS, 2 ** extra);
    }

    private finish(result: 'unlocked' | 'dismissed' | 'forgotten'): void {
        if (this.settled) {
            return;
        }
        this.settled = true;
        this.options.onDone(result);
        this.close();
    }
}

export type PinFormMode = 'set' | 'change' | 'remove' | 'confirm';

export type PinFormOptions = {
    mode: PinFormMode;
    /** For `confirm`: what entering the PIN is for, e.g. "sign out". */
    purpose?: string;
    verify: (pin: string) => Promise<boolean>;
    /** Carry out the change; the new PIN is given for `set` and `change`. */
    apply: (newPin: string | null) => Promise<void>;
    onDone?: (applied: boolean) => void;
};

const TITLES: Record<PinFormMode, string> = {
    set: 'Protect your sign-in with a PIN',
    change: 'Change your PIN',
    remove: 'Remove your PIN',
    confirm: 'Enter your PIN',
};

/**
 * Setting, changing, removing or confirming the PIN, in one form: the
 * current PIN when there is one, the new PIN twice when one is being chosen.
 */
export class PinFormModal extends Modal {
    private applied = false;

    constructor(
        app: App,
        private readonly options: PinFormOptions,
    ) {
        super(app);
    }

    override onOpen(): void {
        const { contentEl } = this;
        const { mode } = this.options;
        this.setTitle(TITLES[mode]);

        if (mode === 'set') {
            contentEl.createEl('p', {
                text:
                    'Obsidian will ask for this PIN every time it starts, and your Proton sign-in is stored ' +
                    'encrypted with it. Anyone using this device while it is unlocked then cannot take your sign-in ' +
                    'without the PIN.',
            });
        } else if (mode === 'remove') {
            contentEl.createEl('p', {
                text: 'Your Proton sign-in will be stored without a PIN again, protected only by this device.',
            });
        } else if (mode === 'confirm') {
            contentEl.createEl('p', { text: `Enter your PIN to ${this.options.purpose ?? 'continue'}.` });
        }
        if (mode === 'set' || mode === 'change') {
            contentEl.createEl('p', {
                cls: 'proton-drive-sync-muted',
                text:
                    `At least ${MIN_PIN_LENGTH} characters. Letters and numbers both work, and longer is ` +
                    'stronger: a short all-digit PIN can be guessed by someone who copies the encrypted sign-in.',
            });
            contentEl.createEl('p', { cls: 'proton-drive-sync-pin-warning', text: LOST_PIN_WARNING });
        }

        const needsCurrent = mode !== 'set';
        const needsNew = mode === 'set' || mode === 'change';
        const current = needsCurrent ? this.passwordField(needsNew ? 'Current PIN' : 'PIN', 'current-password') : null;
        const fresh = needsNew ? this.passwordField('New PIN', 'new-password') : null;
        const repeat = needsNew ? this.passwordField('Repeat new PIN', 'new-password') : null;
        const error = contentEl.createEl('p', { cls: 'proton-drive-sync-pin-error' });

        const submit = async (button: HTMLButtonElement) => {
            error.setText('');
            if (fresh && repeat) {
                if (fresh.getValue().length < MIN_PIN_LENGTH) {
                    error.setText(`The new PIN needs at least ${MIN_PIN_LENGTH} characters.`);
                    return;
                }
                if (fresh.getValue() !== repeat.getValue()) {
                    error.setText('The new PINs do not match.');
                    return;
                }
            }
            button.disabled = true;
            error.setText('Checking…');
            try {
                if (current && !(await this.options.verify(current.getValue()))) {
                    error.setText('Wrong PIN.');
                    current.setValue('');
                    return;
                }
                await this.options.apply(fresh ? fresh.getValue() : null);
                this.applied = true;
                this.close();
            } catch (failure) {
                error.setText(failure instanceof Error ? failure.message : String(failure));
            } finally {
                button.disabled = false;
            }
        };

        new Setting(contentEl)
            .addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
            .addButton((button) => {
                button.setButtonText(mode === 'remove' ? 'Remove PIN' : mode === 'confirm' ? 'Continue' : 'Save PIN');
                if (mode === 'remove') {
                    button.setDestructive();
                } else {
                    button.setCta();
                }
                button.onClick(() => void submit(button.buttonEl));
            });

        window.setTimeout(() => (current ?? fresh)?.inputEl.focus(), 0);
    }

    override onClose(): void {
        this.contentEl.empty();
        this.options.onDone?.(this.applied);
    }

    private passwordField(name: string, autocomplete: AutoFill): TextComponent {
        let field!: TextComponent;
        const setting = new Setting(this.contentEl).setName(name).addText((text) => {
            field = text;
            text.inputEl.type = 'password';
            text.inputEl.autocomplete = autocomplete;
        });
        addRevealButton(setting, field);
        return field;
    }
}

/**
 * An eye button that shows the PIN as typed, and hides it again. Hidden by
 * default, since the screen may be in view of others; a PIN mistyped where
 * it cannot be seen is otherwise only found out at the next unlock.
 */
function addRevealButton(setting: Setting, field: TextComponent): void {
    setting.addExtraButton((button) => {
        const show = (visible: boolean) => {
            field.inputEl.type = visible ? 'text' : 'password';
            button.setIcon(visible ? 'eye-off' : 'eye').setTooltip(visible ? 'Hide PIN' : 'Show PIN');
        };
        show(false);
        button.onClick(() => show(field.inputEl.type === 'password'));
    });
}
