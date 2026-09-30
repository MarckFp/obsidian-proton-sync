import esbuild from 'esbuild';
import process from 'node:process';
import { builtinModules as builtins } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const production = process.argv[2] === 'production';

// The manifest is what Obsidian reads and what the release workflow stamps, so
// the version sent to Proton comes from there rather than from package.json.
const { version } = JSON.parse(readFileSync('./manifest.json', 'utf8'));

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

/*
 * A licence notice at the top of main.js, which is the file users actually
 * receive. It names this plugin's licence and every third-party package that
 * ended up in the bundle, read from the build's own metafile so the list can
 * never drift from what is really inside. `/*!` marks it as a legal comment,
 * which minifiers keep.
 */
const licenseBanner = {
    name: 'license-banner',
    setup(build) {
        build.onEnd(async (result) => {
            if (result.errors.length > 0 || !result.metafile) {
                return;
            }
            const { license, author, homepage } = JSON.parse(readFileSync('package.json', 'utf8'));
            const packages = new Map();
            for (const input of Object.keys(result.metafile.inputs)) {
                const match = input.match(/^(.*node_modules\/((?:@[^/]+\/)?[^/]+))\//);
                if (!match || packages.has(match[2])) {
                    continue;
                }
                const pkg = JSON.parse(readFileSync(`${match[1]}/package.json`, 'utf8'));
                packages.set(match[2], `${pkg.name}@${pkg.version} (${pkg.license ?? 'see package'})`);
            }
            const lines = [
                `Proton Drive Sync for Obsidian v${version}`,
                `Copyright (C) 2026 ${author}. Licensed under ${license}; see LICENSE at:`,
                homepage ?? '',
                '',
                'This file bundles the following third-party packages, under their own licences:',
                ...[...packages.values()].sort().map((entry) => `  ${entry}`),
            ];
            const banner = `/*!\n${lines.map((line) => ` * ${line}`.trimEnd()).join('\n')}\n */\n`;
            const outfile = build.initialOptions.outfile;
            writeFileSync(outfile, banner + readFileSync(outfile, 'utf8'));
        });
    },
};

/*
 * `bcryptjs`, which `@protontech/crypto` uses for SRP, imports Node's `crypto`
 * at the top of its module as a fallback for Web Crypto, and asks browser
 * builds to leave it out. Left in, it becomes a `require("crypto")` that runs
 * when the plugin loads, and Obsidian mobile, which has no Node, refuses to
 * load the plugin at all. Web Crypto exists everywhere Obsidian runs, so the
 * fallback is never needed: static imports of `crypto` resolve to an empty
 * module. The plugin's own desktop-only use of Node's crypto, in
 * `src/sync/vault.ts`, goes through `window.require` at runtime and is not
 * affected.
 */
const noNodeCrypto = {
    name: 'no-node-crypto',
    setup(build) {
        build.onResolve({ filter: /^(node:)?crypto$/ }, () => ({ path: 'crypto', namespace: 'no-node-crypto' }));
        build.onLoad({ filter: /.*/, namespace: 'no-node-crypto' }, () => ({
            contents: 'module.exports = {};',
            loader: 'js',
        }));
    },
};

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
    plugins: [noNodeCrypto, licenseBanner],
    metafile: true,
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
