import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { redactArgument, redactNames, setLogShowsNames, Logger } from '../src/util/logger';

describe('the log never carries note names by default', () => {
    it('replaces paths and file names with a stable token', () => {
        setLogShowsNames(false);
        const redacted = redactNames('Could not upload "Projekty/Trisula/Poznámky.md" and "Inbox/Meeting 10:30.md"');
        assert.ok(!redacted.includes('Trisula'), redacted);
        assert.ok(!redacted.includes('Meeting'), redacted);
        assert.match(redacted, /«file [0-9a-f]{6}»/);
        // The same name always gets the same token, so two lines still pair up.
        assert.equal(redactNames('a/b.md'), redactNames('a/b.md'));
        assert.notEqual(redactNames('a/b.md'), redactNames('a/c.md'));
    });

    it('keeps ordinary words and numbers that are not file names', () => {
        setLogShowsNames(false);
        assert.equal(redactNames('Syncing 120/4000'), 'Syncing 120/4000');
        // An address is not prose either: it is kept out of the log like a name.
        assert.ok(!redactNames('Signed in to Proton as someone@example.com').includes('someone@'));
    });

    it('replaces Drive node ids too: they identify a file across devices', () => {
        setLogShowsNames(false);
        const uid = 'w8SKm5oZxAhYYVfypUQRCf47jLomjutkpnfx2A-ogB7C6bWFDkPaIgk7IhtCKI_BjvIYAfyoEllHeQO1S6aVCQ==~ZD7EDo60rN9pWPQ3ovQR0cYTim';
        assert.equal(redactNames(`GET ${uid} 200`), 'GET «node» 200');
    });

    it('shows names again when the setting is on, for a bug report', () => {
        setLogShowsNames(true);
        assert.match(redactNames('Projekty/Trisula/Poznámky.md'), /Trisula/);
        setLogShowsNames(false);
    });

    it('leaves hosts and API paths alone: they name an endpoint, not a note', () => {
        setLogShowsNames(false);
        const line = 'GET https://drive-api.proton.me/drive/volumes/x/links 200 (351ms)';
        assert.equal(redactNames(line), line);
        assert.equal(redactNames('GET /drive/volumes/x/links 200'), 'GET /drive/volumes/x/links 200');
        assert.equal(redactNames('drive-api.proton.me'), 'drive-api.proton.me');
    });

    it('keeps the stack of an error, redacted, instead of throwing it away', () => {
        setLogShowsNames(false);
        const error = new Error('Could not upload a file');
        error.stack = 'Error: Could not upload a file\n    at upload (/vault/Tajné/poznámka.md:10:2)';
        const copy = redactArgument(error) as Error;
        assert.ok(copy instanceof Error);
        assert.equal(copy.stack?.includes('Tajné'), false, String(copy.stack));
        // The frame is what a bug report needs; only the name goes.
        assert.match(String(copy.stack), /at upload/);
    });

    it('redacts the strings inside a plain object, and keeps its shape', () => {
        setLogShowsNames(false);
        const copy = redactArgument({
            path: 'Tajné/poznámka.md',
            size: 12,
            nested: { name: 'Tajné/druhá.md' },
        }) as Record<string, unknown>;
        assert.equal(copy.size, 12);
        assert.equal(String(copy.path).includes('Tajné'), false, String(copy.path));
        const nested = copy.nested as Record<string, unknown>;
        assert.equal(String(nested.name).includes('Tajné'), false, String(nested.name));
    });

    it('redacts what reaches the buffer and the console alike', () => {
        setLogShowsNames(false);
        const lines: string[] = [];
        const original = console.warn;
        console.warn = (...args: unknown[]) => lines.push(args.map(String).join(' '));
        try {
            const logger = new Logger('warn');
            logger.warn('Could not sync "Tajné/poznámka.md"');
            const buffered = logger.getEntries().at(-1)?.message ?? '';
            assert.ok(!buffered.includes('Tajné'), buffered);
            assert.ok(!lines.join(' ').includes('Tajné'), lines.join(' '));
        } finally {
            console.warn = original;
        }
    });
});
