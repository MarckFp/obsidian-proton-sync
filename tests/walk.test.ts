import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { walkConcurrently } from '../src/sync/drive';

type Folder = { name: string; children: Folder[] };

const tree: Folder = {
    name: 'root',
    children: [
        { name: 'a', children: [{ name: 'a1', children: [] }, { name: 'a2', children: [] }] },
        { name: 'b', children: [{ name: 'b1', children: [{ name: 'b1x', children: [] }] }] },
        { name: 'c', children: [] },
    ],
};

describe('walkConcurrently', () => {
    it('visits every folder once, with no more than the limit in flight', async () => {
        const visited: string[] = [];
        let active = 0;
        let peak = 0;
        await walkConcurrently(tree, 2, async (folder, found) => {
            active++;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 2));
            visited.push(folder.name);
            folder.children.forEach(found);
            active--;
        });
        assert.deepEqual(visited.sort(), ['a', 'a1', 'a2', 'b', 'b1', 'b1x', 'c', 'root']);
        assert.equal(peak, 2);
    });

    it('fails with the first error', async () => {
        await assert.rejects(
            walkConcurrently(tree, 3, async (folder, found) => {
                if (folder.name === 'b') {
                    throw new Error('listing failed');
                }
                folder.children.forEach(found);
            }),
            /listing failed/,
        );
    });
});
