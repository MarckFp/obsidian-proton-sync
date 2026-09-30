import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mediaTypeOf } from '../src/sync/media';
import {
    PathFilter,
    ancestorPaths,
    checkExcludePatterns,
    conflictCopyOriginal,
    conflictCopyPath,
    isWithin,
    replacePrefix,
    splitExtension,
} from '../src/sync/paths';

describe('PathFilter — built-in exclusions', () => {
    const filter = new PathFilter([], true, '.obsidian');

    it('excludes the workspace layout but keeps the rest of .obsidian', () => {
        assert.equal(filter.isExcluded('.obsidian/workspace.json'), true);
        assert.equal(filter.isExcluded('.obsidian/appearance.json'), false);
    });

    it('excludes the trash and git directories at any depth', () => {
        assert.equal(filter.isExcluded('.trash/old note.md'), true);
        assert.equal(filter.isExcluded('.git/objects/ab/cdef'), true);
    });

    it('excludes OS and editor droppings anywhere in the tree', () => {
        assert.equal(filter.isExcluded('.DS_Store'), true);
        assert.equal(filter.isExcluded('notes/.DS_Store'), true);
        assert.equal(filter.isExcluded('notes/~$draft.docx'), true);
        assert.equal(filter.isExcluded('notes/scratch.tmp'), true);
    });

    it('keeps ordinary notes and attachments', () => {
        assert.equal(filter.isExcluded('Daily/2026-09-18.md'), false);
        assert.equal(filter.isExcluded('attachments/diagram.png'), false);
    });
});

describe('PathFilter — the config folder', () => {
    const filter = new PathFilter([], true, '.obsidian', '.obsidian/plugins/proton-drive-sync');

    it('never syncs this plugin’s own folder: its per-device files or its code', () => {
        assert.equal(filter.isExcluded('.obsidian/plugins/proton-drive-sync/data.json'), true);
        assert.equal(filter.isExcluded('.obsidian/plugins/proton-drive-sync/sync-state.json'), true);
        assert.equal(filter.isExcludedWithAncestors('.obsidian/plugins/proton-drive-sync/main.js'), true);
    });

    it('still syncs other plugins, code and settings alike', () => {
        assert.equal(filter.isExcluded('.obsidian/plugins/dataview/main.js'), false);
        assert.equal(filter.isExcluded('.obsidian/plugins/dataview/data.json'), false);
    });

    it('follows a vault that keeps its config somewhere else', () => {
        const custom = new PathFilter([], true, '.config');
        assert.equal(custom.isExcluded('.config/workspace.json'), true);
        assert.equal(custom.isExcluded('.obsidian/workspace.json'), false);
        assert.equal(custom.isConfigPath('.config/app.json'), true);
        assert.equal(custom.isConfigPath('.configured/app.json'), false);
    });
});

describe('PathFilter — .obsidian toggle', () => {
    it('excludes the whole config directory when config sync is off', () => {
        const filter = new PathFilter([], false, '.obsidian');
        assert.equal(filter.isExcluded('.obsidian'), true);
        assert.equal(filter.isExcluded('.obsidian/appearance.json'), true);
        assert.equal(filter.isExcluded('.obsidian/plugins/dataview/main.js'), true);
    });
});

describe('PathFilter — user patterns', () => {
    it('matches a bare folder name and everything below it', () => {
        const filter = new PathFilter(['Private/'], true, '.obsidian');
        assert.equal(filter.isExcluded('Private'), true);
        assert.equal(filter.isExcluded('Private/secret.md'), true);
        assert.equal(filter.isExcluded('Private/deep/secret.md'), true);
        assert.equal(filter.isExcluded('Public/secret.md'), false);
    });

    it('matches an extension glob at one level only', () => {
        const filter = new PathFilter(['*.pdf'], true, '.obsidian');
        assert.equal(filter.isExcluded('manual.pdf'), true);
        assert.equal(filter.isExcluded('docs/manual.pdf'), false);
    });

    it('matches an extension glob at any depth with a double star', () => {
        const filter = new PathFilter(['**/*.pdf'], true, '.obsidian');
        assert.equal(filter.isExcluded('docs/deep/manual.pdf'), true);
    });

    it('does not treat pattern punctuation as a regular expression', () => {
        const filter = new PathFilter(['notes (old)/**'], true, '.obsidian');
        assert.equal(filter.isExcluded('notes (old)/a.md'), true);
        assert.equal(filter.isExcluded('notesXold/a.md'), false);
    });

    it('excludes a file whose parent folder is excluded', () => {
        const filter = new PathFilter(['Archive/'], true, '.obsidian');
        assert.equal(filter.isExcludedWithAncestors('Archive/2024/note.md'), true);
        assert.equal(filter.isExcludedWithAncestors('Active/2024/note.md'), false);
    });
});

describe('path helpers', () => {
    it('lists ancestors root first', () => {
        assert.deepEqual(ancestorPaths('a/b/c/note.md'), ['a', 'a/b', 'a/b/c']);
        assert.deepEqual(ancestorPaths('note.md'), []);
    });

    it('splits an extension without mangling dotfiles or folder dots', () => {
        assert.deepEqual(splitExtension('a/b/note.md'), { stem: 'a/b/note', extension: '.md' });
        assert.deepEqual(splitExtension('a/b/README'), { stem: 'a/b/README', extension: '' });
        assert.deepEqual(splitExtension('a.b/.gitignore'), { stem: 'a.b/.gitignore', extension: '' });
    });
});

describe('conflictCopyPath', () => {
    const when = new Date(2026, 8, 18, 14, 31);

    it('keeps the extension so Obsidian still treats the copy as a note', () => {
        assert.equal(
            conflictCopyPath('Daily/2026-09-18.md', 'laptop', when),
            'Daily/2026-09-18 (conflict 2026-09-18 1431 from laptop).md',
        );
    });

    it('omits the device when none is configured', () => {
        assert.equal(conflictCopyPath('note.md', '', when), 'note (conflict 2026-09-18 1431).md');
    });

    it('strips characters that are illegal in filenames', () => {
        assert.equal(
            conflictCopyPath('note.md', 'work/laptop:1', when),
            'note (conflict 2026-09-18 1431 from work-laptop-1).md',
        );
    });
});

describe('isWithin / replacePrefix', () => {
    it('matches a folder and what is inside it, not siblings sharing a prefix', () => {
        assert.equal(isWithin('Projects', 'Projects'), true);
        assert.equal(isWithin('Projects/a.md', 'Projects'), true);
        assert.equal(isWithin('Projects old/a.md', 'Projects'), false);
    });

    it('re-roots a path under a renamed folder', () => {
        assert.equal(replacePrefix('Projects/2026/a.md', 'Projects', 'Work'), 'Work/2026/a.md');
        assert.equal(replacePrefix('Projects', 'Projects', 'Work'), 'Work');
    });
});

describe('mediaTypeOf', () => {
    it('gives Drive a real type for common attachments', () => {
        assert.equal(mediaTypeOf('assets/Photo.JPG'), 'image/jpeg');
        assert.equal(mediaTypeOf('clips/demo.mov'), 'video/quicktime');
        assert.equal(mediaTypeOf('audio/memo.m4a'), 'audio/mp4');
        assert.equal(mediaTypeOf('docs/report.pdf'), 'application/pdf');
    });

    it('falls back to a generic type for unknown or missing extensions', () => {
        assert.equal(mediaTypeOf('data/blob.xyz'), 'application/octet-stream');
        assert.equal(mediaTypeOf('Makefile'), 'application/octet-stream');
        assert.equal(mediaTypeOf('.hidden'), 'application/octet-stream');
    });
});

describe('conflictCopyOriginal', () => {
    it('finds the note a conflict copy was made from', () => {
        const copy = conflictCopyPath('Notes/Plan.md', 'laptop', new Date(2026, 8, 30, 14, 5));
        assert.equal(conflictCopyOriginal(copy), 'Notes/Plan.md');
    });

    it('copes with a numbered copy and a device name with parentheses', () => {
        assert.equal(conflictCopyOriginal('Plan (conflict 2026-09-30 1405 from Work (old)) 2.md'), 'Plan.md');
    });

    it('works without a device name or an extension', () => {
        assert.equal(conflictCopyOriginal('Folder/README (conflict 2026-09-30 1405)'), 'Folder/README');
    });

    it('returns null for an ordinary file', () => {
        assert.equal(conflictCopyOriginal('Notes/Plan (draft).md'), null);
        assert.equal(conflictCopyOriginal('(conflict 2026-09-30 1405).md'), null);
    });
});

describe('checkExcludePatterns', () => {
    it('accepts ordinary patterns', () => {
        assert.equal(checkExcludePatterns(['Private/', '**/*.pdf', '']), undefined);
    });

    it('explains patterns that would not match what they look like', () => {
        assert.match(checkExcludePatterns(['Private\\Notes'])!, /use \//);
        assert.match(checkExcludePatterns(['/Private'])!, /leading \//);
        assert.match(checkExcludePatterns(['./Private'])!, /\.\//);
        assert.match(checkExcludePatterns(['**'])!, /whole vault/);
    });
});
