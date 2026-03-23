const test = require('node:test');
const assert = require('node:assert/strict');

const { paginate } = require('../src/utils/pager');

test('paginate returns the requested page slice and metadata', () => {
  const result = paginate([1, 2, 3, 4, 5], 2, 2);

  assert.deepEqual(result, {
    items: [3, 4],
    page: 2,
    totalPages: 3,
    totalItems: 5,
    pageSize: 2
  });
});

test('paginate clamps pages below and above the valid range', () => {
  assert.equal(paginate([1, 2, 3], 0, 2).page, 1);
  assert.equal(paginate([1, 2, 3], 99, 2).page, 2);
});

test('paginate still reports one page for an empty collection', () => {
  const result = paginate([], 4, 10);
  assert.deepEqual(result, {
    items: [],
    page: 1,
    totalPages: 1,
    totalItems: 0,
    pageSize: 10
  });
});
