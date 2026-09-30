/**
 * Node 20 cannot strip TypeScript, so the tests are transpiled with the same
 * bundler the plugin uses and handed to `node --test`.
 *
 * Only the pure modules under `src/sync` are covered here: they hold the sync
 * decisions and the merge, and they are written to be reachable without an
 * Obsidian app object or a Proton session. Anything that needs a real vault or
 * a real Drive is left to manual testing against a scratch vault.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import esbuild from 'esbuild';

const outDir = mkdtempSync(path.join(tmpdir(), 'pds-tests-'));

try {
    const entryPoints = readdirSync('tests')
        .filter((file) => file.endsWith('.test.ts'))
        .map((file) => path.join('tests', file));

    if (entryPoints.length === 0) {
        console.error('No test files found.');
        process.exit(1);
    }

    await esbuild.build({
        entryPoints,
        bundle: true,
        format: 'cjs',
        platform: 'node',
        target: 'node20',
        outdir: outDir,
        outExtension: { '.js': '.cjs' },
        sourcemap: 'inline',
        logLevel: 'warning',
        // The real module only exists inside the app.
        alias: { obsidian: path.resolve('tests/stubs/obsidian.ts') },
        // The plugin schedules through `window.setTimeout` for popout-window
        // compatibility. Node has no `window`; a minimal one forwards to the
        // globals at call time, so anything that swaps them still sees calls.
        banner: {
            js:
                'globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), ' +
                'clearTimeout: (t) => clearTimeout(t) };',
        },
    });

    // The compiled files are listed one by one: how `--test` treats a
    // directory argument differs between Node versions, and on Node 24 it is
    // loaded as a single module and fails.
    const compiled = readdirSync(outDir)
        .filter((file) => file.endsWith('.test.cjs'))
        .map((file) => path.join(outDir, file));
    const result = spawnSync(process.execPath, ['--test', ...compiled], { stdio: 'inherit' });
    process.exit(result.status ?? 1);
} finally {
    rmSync(outDir, { recursive: true, force: true });
}
