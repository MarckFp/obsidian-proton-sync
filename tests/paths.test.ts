import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PathFilter, ancestorPaths, conflictCopyPath, splitExtension } from '../src/sync/paths';

describe('PathFilter — built-in exclusions', () => {
    const filter = new PathFilter([], true);

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

describe('PathFilter — .obsidian toggle', () => {
    it('excludes the whole config directory when config sync is off', () => {
        const filter = new PathFilter([], false);
        assert.equal(filter.isExcluded('.obsidian'), true);
        assert.equal(filter.isExcluded('.obsidian/appearance.json'), true);
        assert.equal(filter.isExcluded('.obsidian/plugins/dataview/main.js'), true);
    });
});

describe('PathFilter — user patterns', () => {
    it('matches a bare folder name and everything below it', () => {
        const filter = new PathFilter(['Private/'], true);
        assert.equal(filter.isExcluded('Private'), true);
        assert.equal(filter.isExcluded('Private/secret.md'), true);
        assert.equal(filter.isExcluded('Private/deep/secret.md'), true);
        assert.equal(filter.isExcluded('Public/secret.md'), false);
    });

    it('matches an extension glob at one level only', () => {
        const filter = new PathFilter(['*.pdf'], true);
        assert.equal(filter.isExcluded('manual.pdf'), true);
        assert.equal(filter.isExcluded('docs/manual.pdf'), false);
    });

    it('matches an extension glob at any depth with a double star', () => {
        const filter = new PathFilter(['**/*.pdf'], true);
        assert.equal(filter.isExcluded('docs/deep/manual.pdf'), true);
    });

    it('does not treat pattern punctuation as a regular expression', () => {
        const filter = new PathFilter(['notes (old)/**'], true);
        assert.equal(filter.isExcluded('notes (old)/a.md'), true);
        assert.equal(filter.isExcluded('notesXold/a.md'), false);
    });

    it('excludes a file whose parent folder is excluded', () => {
        const filter = new PathFilter(['Archive/'], true);
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
