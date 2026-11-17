import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTransport } from '../src/lib/http.js';
import { listProducts } from '../src/services/catalog/products.js';
import { getCategory } from '../src/services/catalog/categories.js';
import { requestRefund } from '../src/services/orders/refunds.js';
import { cachedPrice } from '../src/services/catalog/price-cache.js';
import { findBannedCalls } from '../src/tools/lint-legacy.js';

/** Answers every call with `response` and records what was sent. */
function fakeTransport(response) {
  const sent = [];
  const previous = setTransport(async (req) => {
    sent.push(req);
    return response;
  });
  return { sent, restore: () => setTransport(previous) };
}

test('listProducts sends the page as query parameters', async () => {
  const http = fakeTransport({ status: 200, body: { items: [{ id: 'p1' }] } });
  try {
    assert.deepEqual(await listProducts({ page: 2 }), [{ id: 'p1' }]);
    assert.equal(http.sent[0].url, 'https://api.acme.test/v2/products');
    assert.deepEqual(http.sent[0].query, { page: '2', per_page: '20' });
  } finally {
    http.restore();
  }
});

test('getCategory returns null for an unknown slug', async () => {
  const http = fakeTransport({ status: 404, body: { error: 'not found' } });
  try {
    assert.equal(await getCategory('nope'), null);
  } finally {
    http.restore();
  }
});

test('requestRefund posts the amount and waits 20 seconds', async () => {
  const http = fakeTransport({ status: 201, body: { refundId: 'r-7' } });
  try {
    assert.equal(await requestRefund('o-1', 1500), 'r-7');
    assert.equal(http.sent[0].method, 'POST');
    assert.deepEqual(http.sent[0].body, { amount_cents: 1500 });
    assert.equal(http.sent[0].timeoutMs, 20000);
  } finally {
    http.restore();
  }
});

test('cachedPrice loads a price once', async () => {
  let loads = 0;
  const load = async () => {
    loads += 1;
    return 1299;
  };
  assert.equal(await cachedPrice('SKU-T15', load), 1299);
  assert.equal(await cachedPrice('SKU-T15', load), 1299);
  assert.equal(loads, 1);
});

test('the lint check finds the banned helpers in a source text', () => {
  const hits = findBannedCalls('const a = 1;\nawait legacyFetch(url);\n');
  assert.deepEqual(hits, [{ line: 2, call: 'legacyFetch' }]);
});
