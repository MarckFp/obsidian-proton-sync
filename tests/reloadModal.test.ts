import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { summarise } from '../src/ui/reloadModal';

describe('summarise', () => {
    it('counts plugins, themes and snippets by folder, and the rest as settings files', () => {
        assert.deepEqual(
            summarise(
                [
                    '.obsidian/plugins/dataview/main.js',
                    '.obsidian/plugins/dataview/manifest.json',
                    '.obsidian/plugins/calendar/main.js',
                    '.obsidian/themes/Minimal/theme.css',
                    '.obsidian/snippets/wide.css',
                    '.obsidian/app.json',
                    '.obsidian/community-plugins.json',
                ],
                '.obsidian',
            ),
            ['2 community plugins', '1 theme', '1 CSS snippet', '2 settings files'],
        );
    });

    it('follows a config folder with another name', () => {
        assert.deepEqual(summarise(['.config/snippets/a.css'], '.config'), ['1 CSS snippet']);
    });
});
