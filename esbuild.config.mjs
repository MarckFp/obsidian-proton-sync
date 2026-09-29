import esbuild from 'esbuild';
import process from 'node:process';
import builtins from 'builtin-modules';
import { existsSync, readFileSync } from 'node:fs';

const production = process.argv[2] === 'production';

const { version } = JSON.parse(readFileSync('./package.json', 'utf8'));

/*
 * `@protontech/crypto` imports `openpgp/lightweight`, a build that fetches the
 * argon2 WASM blob over the network at runtime. That cannot work inside a
 * bundled Obsidian plugin, so both specifiers are pinned to the full browser
 * build of Proton's OpenPGP fork, which has everything inlined and pulls in no
 * Node built-ins. Proton's own CLI patches the package for the same reason.
 *
 * Resolved by walking to the file rather than by `require.resolve`, because
 * neither package exports the path: `openpgp` publishes only `.` and
 * `./lightweight`, and pointing esbuild at either of those would land back on
 * the build being avoided.
 */
function resolveOpenPgpBrowserBuild() {
    const candidates = [
        'node_modules/openpgp/dist/openpgp.min.mjs',
        'node_modules/@protontech/crypto/node_modules/openpgp/dist/openpgp.min.mjs',
    ];
    for (const candidate of candidates) {
        if (existsSync(candidate)) {
            return './' + candidate;
        }
    }
    throw new Error(
        'Could not find the OpenPGP browser build. Run `npm install`, and check that ' +
            '@protontech/crypto still aliases `openpgp` to @protontech/openpgp.',
    );
}

const openpgpFullBuild = resolveOpenPgpBrowserBuild();

const context = await esbuild.context({
    entryPoints: ['src/main.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'chrome120',
    outfile: 'main.js',
    sourcemap: production ? false : 'inline',
    minify: production,
    treeShaking: true,
    logLevel: 'info',
    alias: {
        openpgp: openpgpFullBuild,
        'openpgp/lightweight': openpgpFullBuild,
    },
    define: {
        __PLUGIN_VERSION__: JSON.stringify(version),
    },
    external: [
        'obsidian',
        'electron',
        '@codemirror/autocomplete',
        '@codemirror/collab',
        '@codemirror/commands',
        '@codemirror/language',
        '@codemirror/lint',
        '@codemirror/search',
        '@codemirror/state',
        '@codemirror/view',
        '@lezer/common',
        '@lezer/highlight',
        '@lezer/lr',
        ...builtins,
        ...builtins.map((name) => `node:${name}`),
    ],
});

if (production) {
    await context.rebuild();
    process.exit(0);
} else {
    await context.watch();
}
