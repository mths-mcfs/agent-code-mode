import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitCents } from '../src/lib/split.js';

const same = (actual, expected) => {
  assert.equal(actual.length, expected.length);
  // Over `expected`, not `actual.forEach`, which skips holes: an empty slot is not a 0 share.
  expected.forEach((e, i) => assert.ok(i in actual && Object.is(actual[i], e), `share ${i}: got ${!(i in actual) ? 'an empty slot' : Object.is(actual[i], -0) ? '-0' : actual[i]}, expected ${e}`));
};

test('largest remainders, ties to the lower index', () => {
  same(splitCents(10, [1, 3]), [3, 7]);
  same(splitCents(7, [1, 1, 1, 1]), [2, 2, 2, 1]);
  same(splitCents(3, [1, 2, 1, 2]), [1, 1, 0, 1]);
  same(splitCents(100, [3, 3, 1]), [43, 43, 14]);
  same(splitCents(1, [1, 1, 1]), [1, 0, 0]);
  same(splitCents(2, [1, 2, 2]), [0, 1, 1]);
});

test('sums exactly and keeps zero weights at zero', () => {
  same(splitCents(5, [0, 1, 0]), [0, 5, 0]);
  const shares = splitCents(99_999, [17, 1, 1, 400, 3]);
  assert.equal(shares.reduce((a, b) => a + b, 0), 99_999);
  shares.forEach((s) => assert.ok(Number.isInteger(s)));
});

test('negative totals mirror positive ones and never give -0', () => {
  same(splitCents(-100, [1, 1, 1]), [-34, -33, -33]);
  same(splitCents(-1, [1, 1]), [-1, 0]);
  same(splitCents(0, [1, 2]), [0, 0]);
  same(splitCents(-5, [0, 1]), [0, -5]);
});

test('all-zero weights', () => {
  same(splitCents(0, [0, 0]), [0, 0]);
  assert.throws(() => splitCents(1, [0, 0]), RangeError);
  assert.throws(() => splitCents(-1, [0]), RangeError);
});

test('invalid input throws RangeError', () => {
  for (const [total, weights] of [
    [1.5, [1]],
    [Number.NaN, [1]],
    [2 ** 53, [1]],
    ['10', [1]],
    [10, []],
    [10, [1, -1]],
    [10, [1.5, 1]],
    [10, [Number.POSITIVE_INFINITY]],
    [10, [Number.NaN]],
  ]) {
    assert.throws(() => splitCents(total, weights), RangeError, `${String(total)} / ${JSON.stringify(weights)}`);
  }
});

test('exact for the largest safe totals', () => {
  const max = Number.MAX_SAFE_INTEGER;
  same(splitCents(max, [1, 2]), [3002399751580330, 6004799503160661]);
  same(splitCents(-max, [1, 2]), [-3002399751580330, -6004799503160661]);
  same(splitCents(10, [max, 1]), [10, 0]);
  // Products past 2^53: floating point loses the cents here.
  same(splitCents(max, [2, 3, 5]), [1801439850948198, 2702159776422297, 4503599627370496]);
  same(splitCents(max - 1, [7, 11]), [3502799710177052, 5504399544563938]);
  same(splitCents(max, [max, max - 1]), [4503599627370496, 4503599627370495]);
});

test('does not change the weights array', () => {
  const weights = [3, 1, 2];
  splitCents(60, weights);
  assert.deepEqual(weights, [3, 1, 2]);
});

test('object weights give an object with the same keys, ties in key order', () => {
  const out = splitCents(100, { rent: 1, food: 1, fun: 1 });
  assert.deepEqual(Object.keys(out), ['rent', 'food', 'fun']);
  assert.deepEqual(out, { rent: 34, food: 33, fun: 33 });
  // Integer-like keys come first in Object.keys order, and that order breaks the ties.
  const mixed = splitCents(2, { b: 1, a: 1, 10: 1, 2: 1 });
  assert.deepEqual(Object.keys(mixed), ['2', '10', 'b', 'a']);
  assert.deepEqual(mixed, { 2: 1, 10: 1, b: 0, a: 0 });
  assert.ok(Object.is(splitCents(-1, { x: 1, y: 1 }).y, 0));
  assert.deepEqual(splitCents(0, { x: 0 }), { x: 0 });
  assert.throws(() => splitCents(1, {}), RangeError);
  assert.throws(() => splitCents(1, { x: -1 }), RangeError);
  assert.throws(() => splitCents(1, { x: 0, y: 0 }), RangeError);
});
