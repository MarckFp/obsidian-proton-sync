/**
 * A vault adapter over a real temporary directory, with `getFullPath`, which is
 * what lets `VaultIO` take its streaming path on desktop.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { App } from 'obsidian';

export function diskVault() {
    const root = mkdtempSync(path.join(tmpdir(), 'pds-vault-'));
    const full = (vaultPath: string) => path.join(root, ...vaultPath.split('/'));
    const adapter = {
        getFullPath: full,
        async stat(vaultPath: string) {
            try {
                const stat = await fs.stat(full(vaultPath));
                return { type: stat.isFile() ? 'file' : 'folder', size: stat.size, mtime: Math.round(stat.mtimeMs) };
            } catch {
                return null;
            }
        },
        async exists(vaultPath: string) {
            return (await adapter.stat(vaultPath)) !== null;
        },
        async readBinary(vaultPath: string) {
            const data = await fs.readFile(full(vaultPath));
            return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        },
        async writeBinary(vaultPath: string, data: ArrayBuffer) {
            await fs.writeFile(full(vaultPath), new Uint8Array(data));
        },
        async mkdir(vaultPath: string) {
            mkdirSync(full(vaultPath), { recursive: true });
        },
        async list(vaultPath: string) {
            const entries = await fs.readdir(full(vaultPath), { withFileTypes: true });
            const prefix = vaultPath === '' ? '' : `${vaultPath}/`;
            return {
                files: entries.filter((entry) => entry.isFile()).map((entry) => prefix + entry.name),
                folders: entries.filter((entry) => entry.isDirectory()).map((entry) => prefix + entry.name),
            };
        },
    };
    return {
        root,
        full,
        app: { vault: { adapter } } as unknown as App,
        cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
}

/** Node's `require`, where the plugin expects to find it on desktop. */
export function exposeNodeRequire(): void {
    Object.assign((globalThis as { window: object }).window, { require });
}
