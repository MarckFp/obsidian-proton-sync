import { type ButtonComponent, setIcon } from 'obsidian';

/**
 * Show an icon and a label on a button, side by side: Obsidian's `setIcon`
 * and `setButtonText` each replace what the other put there. Leaves the
 * button alone when it already shows them, so it can run on every status
 * update without redrawing under a finger.
 */
export function labelButton(button: ButtonComponent, icon: string, text: string): ButtonComponent {
    const el = button.buttonEl;
    if (el.dataset.icon === icon && el.dataset.label === text) {
        return button;
    }
    el.dataset.icon = icon;
    el.dataset.label = text;
    el.empty();
    el.addClass('proton-drive-sync-labelled');
    setIcon(el.createSpan({ cls: 'proton-drive-sync-button-icon' }), icon);
    el.createSpan({ cls: 'proton-drive-sync-button-text', text });
    return button;
}
