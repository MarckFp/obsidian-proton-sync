import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';

import { LARGE_FILE_BYTES, VaultIO } from '../src/sync/vault';
import { Logger } from '../src/util/logger';
import { diskVault, exposeNodeRequire } from './support/diskAdapter';

const SILENT = new Logger('error');

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
        chunks.push(read.value);
    }
    return Buffer.concat(chunks);
}

describe('VaultIO on desktop', () => {
    const disk = diskVault();
    let vault: VaultIO;

    before(() => {
        exposeNodeRequire();
        vault = new VaultIO(disk.app, SILENT);
    });
    after(() => disk.cleanup());

    it('streams a large file up in chunks, with the digest of what is sent', async () => {
        const bytes = Buffer.alloc(LARGE_FILE_BYTES + 12_345, 7);
        bytes.write('video', 0);
        writeFileSync(disk.full('clip.mp4'), bytes);

        const { source, local } = await vault.openUpload('clip.mp4');

        assert.equal(source.replay, false, 'streamed, not buffered');
        assert.equal(source.mediaType, 'video/mp4');
        assert.equal(source.size, bytes.byteLength);
        assert.equal(source.sha1, createHash('sha1').update(bytes).digest('hex'));
        assert.equal(local.hash, source.sha1);
        assert.ok((await readAll(source.stream())).equals(bytes));
        assert.equal((await vault.getState('clip.mp4'))?.hash, source.sha1);
    });

    it('buffers a small file, so an upload can be retried from it', async () => {
        writeFileSync(disk.full('note.md'), 'hello');
        const { source } = await vault.openUpload('note.md');
        assert.equal(source.replay, true);
        assert.equal((await readAll(source.stream())).toString(), 'hello');
        assert.equal((await readAll(source.stream())).toString(), 'hello');
    });

    it('lands a download only once complete, with the requested mtime', async () => {
        const file = await vault.openDownload('media/movie.mkv');
        assert.ok(file);
        const writer = file.sink.getWriter();
        await writer.write(new TextEncoder().encode('part one, '));
        assert.equal(existsSync(disk.full('media/movie.mkv')), false, 'nothing at the target mid-download');
        await writer.write(new TextEncoder().encode('part two'));
        await writer.close();

        const state = await file.commit(1_700_000_000_000);

        assert.equal(readFileSync(disk.full('media/movie.mkv'), 'utf8'), 'part one, part two');
        assert.equal(state.hash, createHash('sha1').update('part one, part two').digest('hex'));
        assert.equal(Math.round(statSync(disk.full('media/movie.mkv')).mtimeMs), 1_700_000_000_000);
        assert.deepEqual(readdirSync(disk.full('media')), ['movie.mkv'], 'temp file gone');
    });

    it('leaves nothing behind when a download is abandoned', async () => {
        writeFileSync(disk.full('keep.pdf'), 'original');
        const file = await vault.openDownload('keep.pdf');
        const writer = file!.sink.getWriter();
        await writer.write(new TextEncoder().encode('partial'));
        await file!.abort();

        assert.equal(readFileSync(disk.full('keep.pdf'), 'utf8'), 'original');
        assert.equal(
            readdirSync(disk.root).some((name) => name.endsWith('.tmp')),
            false,
        );
    });
});
