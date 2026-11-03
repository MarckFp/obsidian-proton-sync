import type { App } from 'obsidian';

import type { Logger } from '../util/logger';

/**
 * A fingerprint of this plugin's own code.
 *
 * The plugin folder sits in the vault, and a vault can be writable by other
 * users or processes. Someone who can replace `main.js` runs code in this
 * process, with the OS user's keyring — no token needed. Recording the digest
 * with the version at install time makes that visible: a change to the code
 * *without* a version change is not an update, it is tampering.
 *
 * Best effort by design: whoever can write the file can rewrite the record too.
 * It catches a copy-paste, a careless `chmod`, and a half-finished experiment,
 * not a determined attacker.
 */
type SelfRecord = {
    version: string;
    digest: string;
};

const FILE = 'plugin-self.json';

async function digestOf(app: App, path: string): Promise<string | null> {
    try {
        const bytes = await app.vault.adapter.readBinary(path);
        const hash = await crypto.subtle.digest('SHA-256', bytes);
        return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    } catch {
        return null;
    }
}

export type IntegrityResult = 'first-run' | 'unchanged' | 'updated' | 'changed-without-update';

export async function checkSelf(
    app: App,
    folder: string,
    version: string,
    logger: Logger,
): Promise<IntegrityResult> {
    const codePath = `${folder}/main.js`;
    const recordPath = `${folder}/${FILE}`;
    const digest = await digestOf(app, codePath);
    if (!digest) {
        return 'first-run';
    }

    let record: SelfRecord | null = null;
    try {
        if (await app.vault.adapter.exists(recordPath)) {
            record = JSON.parse(await app.vault.adapter.read(recordPath)) as SelfRecord;
        }
    } catch {
        record = null;
    }

    if (!record || !record.digest) {
        await save(app, recordPath, { version, digest });
        return 'first-run';
    }
    if (record.digest === digest) {
        return 'unchanged';
    }
    if (record.version !== version) {
        // A new release: the code is expected to differ.
        await save(app, recordPath, { version, digest });
        return 'updated';
    }

    logger.warn(
        'This plugin\'s own code changed without a new version. If you did not replace it yourself, ' +
            'treat the stored Proton sign-in as exposed and sign out.',
    );
    return 'changed-without-update';
}

async function save(app: App, path: string, record: SelfRecord): Promise<void> {
    try {
        await app.vault.adapter.write(path, JSON.stringify(record, null, 2));
    } catch {
        // A read-only vault is not a security problem in itself.
    }
}
