import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PathBatcher } from '../src/util/debounce';

describe('PathBatcher — renames', () => {
    it('carries a pending path, and everything inside a pending folder, to the new name', () => {
        let delivered: string[] = [];
        const batcher = new PathBatcher(10_000, 10_000, (paths) => {
            delivered = paths;
        });
        batcher.add('Untitled.md');
        batcher.add('Projects/a.md');
        batcher.add('Projects old/b.md');

        batcher.rename('Untitled.md', 'Idea.md');
        batcher.rename('Projects', 'Work');
        batcher.flush();

        assert.deepEqual(delivered.sort(), ['Idea.md', 'Projects old/b.md', 'Work/a.md']);
    });
});
