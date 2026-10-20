import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PAGE_SIZE, pageOf } from '../src/ui/pager';

describe('pageOf', () => {
    const items = Array.from({ length: 23 }, (_, index) => index);

    it('shows ten to a page', () => {
        assert.equal(PAGE_SIZE, 10);
        assert.deepEqual(pageOf(items, 0), { items: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], page: 0, pages: 3 });
        assert.deepEqual(pageOf(items, 2).items, [20, 21, 22]);
    });

    it('keeps the page within the list as it shrinks', () => {
        assert.equal(pageOf(items.slice(0, 15), 2).page, 1);
        assert.equal(pageOf(items, -1).page, 0);
        assert.deepEqual(pageOf([], 3), { items: [], page: 0, pages: 1 });
    });
});
