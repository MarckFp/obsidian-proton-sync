import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';

/*
 * The checks Obsidian's plugin review runs, so they fail CI here instead of
 * turning up as warnings on a submission. Only `src` is linted: it is what
 * ships in main.js and what the review looks at.
 */
export default defineConfig([
    {
        ignores: ['main.js', 'node_modules/**', 'tests/**', 'scripts/**', 'esbuild.config.mjs', 'eslint.config.mjs'],
    },
    ...obsidianmd.configs.recommended,
    {
        files: ['src/**/*.ts'],
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            // TypeScript already reports undefined names, and knows about
            // ambient declarations such as `__PLUGIN_VERSION__` that this
            // rule cannot see.
            'no-undef': 'off',
            'obsidianmd/ui/sentence-case': [
                'warn',
                { brands: ['Obsidian', 'Proton', 'Proton Drive', 'Proton Drive Sync', 'Drive', 'Wi-Fi', 'Android', 'iOS'] },
            ],
        },
    },
    {
        // Vendored from Proton's SDK repository, which uses `ky`. Every
        // request it makes still goes through Obsidian's `requestUrl`, via the
        // `fetch` option it is given; see src/proton/account/VENDORED.md.
        files: ['src/proton/account/**/*.ts'],
        rules: {
            '@typescript-eslint/no-restricted-imports': 'off',
        },
    },
]);
