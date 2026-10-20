import { ButtonComponent } from 'obsidian';

/** Rows per page in the versions and recently deleted dialogs. */
export const PAGE_SIZE = 10;

/** One page of `items`, with `page` brought within range: the list may have shrunk since it was chosen. */
export function pageOf<T>(items: readonly T[], page: number, size = PAGE_SIZE): { items: T[]; page: number; pages: number } {
    const pages = Math.max(1, Math.ceil(items.length / size));
    const current = Math.min(Math.max(page, 0), pages - 1);
    return { items: items.slice(current * size, (current + 1) * size), page: current, pages };
}

/** "Newer", "Page 2 of 5" and "Older" under a list, newest first, when it has more than one page. */
export function renderPager(container: HTMLElement, page: number, pages: number, go: (page: number) => void): void {
    if (pages <= 1) {
        return;
    }
    const pager = container.createDiv({ cls: 'proton-drive-sync-pager' });
    new ButtonComponent(pager)
        .setButtonText('Newer')
        .setDisabled(page === 0)
        .onClick(() => go(page - 1));
    pager.createSpan({ cls: 'proton-drive-sync-muted', text: `Page ${page + 1} of ${pages}` });
    new ButtonComponent(pager)
        .setButtonText('Older')
        .setDisabled(page >= pages - 1)
        .onClick(() => go(page + 1));
}
