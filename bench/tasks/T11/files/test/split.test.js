import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitCents } from '../src/lib/split.js';

test('splits 100 cents three ways', () => {
  assert.deepEqual(splitCents(100, [1, 1, 1]), [34, 33, 33]);
});
