import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTransport } from '../src/lib/http.js';

// What each service function must send and return after the migration. Written by hand from the
// contract in src/lib/http.js and the MIGRATION notes of src/lib/legacy-http.js: `sent` is what the
// transport receives (after `request` applied its defaults), one entry per call, in order.
const API = 'https://api.acme.test/v2';
const AUTH = 'https://auth.acme.test';
const TAX = 'https://tax.acme.test';
const CARRIER = 'https://carrier.acme.test/api';
const NOTIFY = 'https://notify.acme.test';
const JSON_TYPE = { 'content-type': 'application/json' };

/** A request as the transport sees it, with the defaults of `request` filled in. */
const req = (method, url, extra = {}) => ({ method, url, headers: {}, query: {}, body: undefined, timeoutMs: 30000, ...extra });
const ok = (body, status = 200) => ({ status, body });

/**
 * One case: `fn(...args)` with the transport answering `replies` in order. Exactly one of:
 * `returns` (the resolved value), `httpError` (rejects with the HttpError of that status).
 * `network: true` adds a second run where the transport throws: the same error must come out.
 */
const CASES = {
  'catalog/products.js': [
    { fn: 'getProduct', args: ['p-1'], replies: [ok({ id: 'p-1', name: 'Mug' })], sent: [req('GET', `${API}/products/p-1`)], returns: { id: 'p-1', name: 'Mug' } },
    { fn: 'getProduct', args: ['p-404'], replies: [ok({ error: 'gone' }, 404)], sent: [req('GET', `${API}/products/p-404`)], httpError: 404 },
    { fn: 'listProducts', args: [], replies: [ok({ items: ['a', 'b'] })], sent: [req('GET', `${API}/products`, { query: { page: '1', per_page: '20' } })], returns: ['a', 'b'] },
    { fn: 'listProducts', args: [{ page: 3, perPage: 5 }], replies: [ok({ items: [] })], sent: [req('GET', `${API}/products`, { query: { page: '3', per_page: '5' } })], returns: [] },
  ],
  'catalog/search.js': [
    { fn: 'searchProducts', args: ['red mug'], replies: [ok({ hits: [1, 2] })], sent: [req('GET', `${API}/search`, { query: { q: 'red mug', limit: '10' }, timeoutMs: 3000 })], returns: [1, 2] },
    { fn: 'searchProducts', args: ['x', 2], replies: [ok({ error: 'down' }, 503)], sent: [req('GET', `${API}/search`, { query: { q: 'x', limit: '2' }, timeoutMs: 3000 })], httpError: 503 },
  ],
  'catalog/categories.js': [
    { fn: 'listCategories', args: [], replies: [ok(['mugs', 'pens'])], sent: [req('GET', `${API}/categories`)], returns: ['mugs', 'pens'] },
    { fn: 'listCategories', args: [], replies: [ok(null, 500)], sent: [req('GET', `${API}/categories`)], httpError: 500 },
    { fn: 'getCategory', args: ['mugs'], replies: [ok({ slug: 'mugs' })], sent: [req('GET', `${API}/categories/mugs`)], returns: { slug: 'mugs' }, network: true },
    { fn: 'getCategory', args: ['nope'], replies: [ok({ error: 'not found' }, 404)], sent: [req('GET', `${API}/categories/nope`)], returns: null },
  ],
  'catalog/inventory.js': [
    { fn: 'getStock', args: ['AB/1'], replies: [ok({ available: 7 })], sent: [req('GET', `${API}/inventory/AB%2F1`, { headers: { accept: 'application/json' } })], returns: 7 },
    { fn: 'reserveStock', args: ['SKU-9', 2], replies: [ok({ reserved: 2 }, 201)], sent: [req('POST', `${API}/inventory/SKU-9/reserve`, { headers: JSON_TYPE, body: { qty: 2 } })], returns: { reserved: 2 } },
    { fn: 'reserveStock', args: ['SKU-9', 99], replies: [ok({ error: 'short' }, 409)], sent: [req('POST', `${API}/inventory/SKU-9/reserve`, { headers: JSON_TYPE, body: { qty: 99 } })], httpError: 409 },
  ],
  'catalog/reviews.js': [
    { fn: 'listReviews', args: ['p-1'], replies: [ok({ items: ['r1'] })], sent: [req('GET', `${API}/reviews`, { query: { product: 'p-1' } })], returns: { items: ['r1'], next: null } },
    { fn: 'listReviews', args: ['p-1', { rating: 0, cursor: 'c2' }], replies: [ok({ items: [], next: 'c3' })], sent: [req('GET', `${API}/reviews`, { query: { product: 'p-1', rating: '0', cursor: 'c2' } })], returns: { items: [], next: 'c3' } },
    { fn: 'postReview', args: ['p-1', { rating: 5, text: 'Great', ignored: true }], replies: [ok({}, 201)], sent: [req('POST', `${API}/reviews`, { headers: JSON_TYPE, body: { product: 'p-1', rating: 5, text: 'Great' } })], returns: true, network: true },
    { fn: 'postReview', args: ['p-1', { rating: 1, text: 'Hm' }], replies: [ok({}, 202)], sent: [req('POST', `${API}/reviews`, { headers: JSON_TYPE, body: { product: 'p-1', rating: 1, text: 'Hm' } })], returns: false },
    { fn: 'postReview', args: ['p-1', { rating: 9, text: '' }], replies: [ok({ error: 'invalid' }, 422)], sent: [req('POST', `${API}/reviews`, { headers: JSON_TYPE, body: { product: 'p-1', rating: 9, text: '' } })], returns: false },
  ],
  'catalog/product-cache.js': [
    { fn: 'getCachedProduct', args: ['pc-1'], replies: [ok({ id: 'pc-1' })], sent: [req('GET', `${API}/products/pc-1`, { timeoutMs: 2000 })], returns: { id: 'pc-1' } },
    // The second read is served by the vendored cache: nothing is sent.
    { fn: 'getCachedProduct', args: ['pc-1'], replies: [], sent: [], returns: { id: 'pc-1' } },
    { fn: 'getCachedProduct', args: ['pc-2'], replies: [ok(null, 500)], sent: [req('GET', `${API}/products/pc-2`, { timeoutMs: 2000 })], httpError: 500 },
  ],
  'orders/create.js': [
    {
      fn: 'createOrder',
      args: [{ clientRef: 'ref-1', lines: [{ sku: 'A', qty: 1 }] }],
      replies: [ok({ id: 'o-1', status: 'new', extra: 1 }, 201)],
      sent: [req('POST', `${API}/orders`, { headers: { 'idempotency-key': 'ref-1', ...JSON_TYPE }, body: { clientRef: 'ref-1', lines: [{ sku: 'A', qty: 1 }] } })],
      returns: { id: 'o-1', status: 'new' },
    },
    { fn: 'createOrder', args: [{ clientRef: 'ref-2' }], replies: [ok({ error: 'bad' }, 400)], sent: [req('POST', `${API}/orders`, { headers: { 'idempotency-key': 'ref-2', ...JSON_TYPE }, body: { clientRef: 'ref-2' } })], httpError: 400 },
  ],
  'orders/lookup.js': [
    { fn: 'findOrder', args: ['o-1'], replies: [ok({ id: 'o-1' })], sent: [req('GET', `${API}/orders/o-1`)], returns: { id: 'o-1' }, network: true },
    { fn: 'findOrder', args: ['o-0'], replies: [ok({ error: 'not found' }, 404)], sent: [req('GET', `${API}/orders/o-0`)], returns: null },
    { fn: 'listOrdersFor', args: ['c-1'], replies: [ok({ orders: ['o-1'] })], sent: [req('GET', `${API}/orders`, { query: { customer: 'c-1' } })], returns: ['o-1'] },
    { fn: 'listOrdersFor', args: ['c-1', 'paid'], replies: [ok({ orders: [] })], sent: [req('GET', `${API}/orders`, { query: { customer: 'c-1', status: 'paid' } })], returns: [] },
  ],
  'orders/cancel.js': [
    { fn: 'cancelOrder', args: ['o-1', 'changed mind'], replies: [ok(null, 204)], sent: [req('DELETE', `${API}/orders/o-1`, { query: { reason: 'changed mind' } })], returns: { cancelled: true }, network: true },
    { fn: 'cancelOrder', args: ['o-2'], replies: [ok({ error: 'already shipped' }, 409)], sent: [req('DELETE', `${API}/orders/o-2`)], returns: { cancelled: false, reason: 'already shipped' } },
  ],
  'orders/refunds.js': [
    { fn: 'requestRefund', args: ['o-1', 250], replies: [ok({ refundId: 'rf-1' }, 201)], sent: [req('POST', `${API}/orders/o-1/refunds`, { headers: JSON_TYPE, body: { amount_cents: 250 }, timeoutMs: 20000 })], returns: 'rf-1' },
    { fn: 'requestRefund', args: ['o-1', 0], replies: [ok({ error: 'zero' }, 422)], sent: [req('POST', `${API}/orders/o-1/refunds`, { headers: JSON_TYPE, body: { amount_cents: 0 }, timeoutMs: 20000 })], httpError: 422 },
  ],
  'orders/export.js': [
    {
      fn: 'exportOrders',
      args: ['status=paid'],
      replies: [ok('id,total\no-1,10\n')],
      sent: [req('POST', `${API}/orders/export`, { headers: { 'content-type': 'text/plain', accept: 'text/csv' }, body: 'status=paid', timeoutMs: 120000 })],
      returns: 'id,total\no-1,10\n',
    },
  ],
  'orders/notes.js': [
    { fn: 'listNotes', args: ['o-1'], replies: [ok({ notes: ['n1'] })], sent: [req('GET', `${API}/orders/o-1/notes`, { query: { order: 'newest' } })], returns: ['n1'] },
    { fn: 'addNote', args: ['o-1', 'call back', 'sam'], replies: [ok({ id: 'n2' }, 201)], sent: [req('POST', `${API}/orders/o-1/notes`, { headers: JSON_TYPE, body: { text: 'call back', author: 'sam' } })], returns: { id: 'n2' } },
    { fn: 'addNote', args: ['o-9', 't', 'a'], replies: [ok(null, 404)], sent: [req('POST', `${API}/orders/o-9/notes`, { headers: JSON_TYPE, body: { text: 't', author: 'a' } })], httpError: 404 },
  ],
  'billing/invoices.js': [
    { fn: 'getInvoice', args: ['inv-1'], replies: [ok({ id: 'inv-1' })], sent: [req('GET', `${API}/invoices/inv-1`, { headers: { accept: 'application/json' } })], returns: { id: 'inv-1' } },
    { fn: 'listInvoices', args: ['c-1'], replies: [ok({ invoices: [1] })], sent: [req('GET', `${API}/invoices`, { query: { customer: 'c-1' } })], returns: [1] },
    { fn: 'listInvoices', args: ['c-1', { from: '2026-01-01' }], replies: [ok({ invoices: [] })], sent: [req('GET', `${API}/invoices`, { query: { customer: 'c-1', from: '2026-01-01' } })], returns: [] },
    { fn: 'listInvoices', args: ['c-1', { from: '2026-01-01', to: '2026-02-01' }], replies: [ok(null, 500)], sent: [req('GET', `${API}/invoices`, { query: { customer: 'c-1', from: '2026-01-01', to: '2026-02-01' } })], httpError: 500 },
  ],
  'billing/payments.js': [
    {
      fn: 'capturePayment',
      args: ['pay-1', 990],
      replies: [ok({ receipt: 'rc-1' })],
      sent: [req('POST', `${API}/payments/pay-1/capture`, { headers: { 'x-billing-version': '3', ...JSON_TYPE }, body: { amount_cents: 990 }, timeoutMs: 15000 })],
      returns: { captured: true, receipt: 'rc-1' },
      network: true,
    },
    {
      fn: 'capturePayment',
      args: ['pay-2', 5],
      replies: [ok({ code: 'insufficient_funds' }, 402)],
      sent: [req('POST', `${API}/payments/pay-2/capture`, { headers: { 'x-billing-version': '3', ...JSON_TYPE }, body: { amount_cents: 5 }, timeoutMs: 15000 })],
      returns: { captured: false, declineCode: 'insufficient_funds' },
    },
    { fn: 'voidPayment', args: ['pay-1'], replies: [ok(null, 204)], sent: [req('DELETE', `${API}/payments/pay-1`, { headers: { 'x-billing-version': '3' }, timeoutMs: 15000 })], returns: true, network: true },
    { fn: 'voidPayment', args: ['pay-1'], replies: [ok({ pending: true }, 202)], sent: [req('DELETE', `${API}/payments/pay-1`, { headers: { 'x-billing-version': '3' }, timeoutMs: 15000 })], returns: false },
    { fn: 'voidPayment', args: ['pay-0'], replies: [ok({ error: 'not found' }, 404)], sent: [req('DELETE', `${API}/payments/pay-0`, { headers: { 'x-billing-version': '3' }, timeoutMs: 15000 })], returns: false },
  ],
  'billing/subscriptions.js': [
    { fn: 'changePlan', args: ['sub-1', 'pro'], replies: [ok({ id: 'sub-1', plan: 'pro' })], sent: [req('PATCH', `${API}/subscriptions/sub-1`, { headers: JSON_TYPE, body: { plan: 'pro' } })], returns: { id: 'sub-1', plan: 'pro' } },
    { fn: 'pauseSubscription', args: ['sub-1', 14], replies: [ok({ resumesAt: '2026-03-01' })], sent: [req('POST', `${API}/subscriptions/sub-1/pause`, { headers: JSON_TYPE, body: { days: 14 }, timeoutMs: 10000 })], returns: '2026-03-01' },
    { fn: 'pauseSubscription', args: ['sub-0', 1], replies: [ok(null, 404)], sent: [req('POST', `${API}/subscriptions/sub-0/pause`, { headers: JSON_TYPE, body: { days: 1 }, timeoutMs: 10000 })], httpError: 404 },
  ],
  'billing/tax.js': [
    { fn: 'quoteTax', args: [{ country: 'DE', net: 1000 }], replies: [ok({ tax_cents: 190 })], sent: [req('POST', `${TAX}/quote`, { headers: JSON_TYPE, body: { country: 'DE', net: 1000 }, timeoutMs: 2500 })], returns: 190, network: true },
    { fn: 'quoteTax', args: [{ country: 'DE' }], replies: [ok({ error: 'overloaded' }, 503)], sent: [req('POST', `${TAX}/quote`, { headers: JSON_TYPE, body: { country: 'DE' }, timeoutMs: 2500 })], returns: null },
    { fn: 'quoteTax', args: [{ country: 'FR' }], replies: [ok({ tax_cents: 1 }, 202)], sent: [req('POST', `${TAX}/quote`, { headers: JSON_TYPE, body: { country: 'FR' }, timeoutMs: 2500 })], returns: null },
  ],
  'billing/credits.js': [
    { fn: 'getBalance', args: ['c-1'], replies: [ok({ balance_cents: 420 })], sent: [req('GET', `${API}/credits/c-1`, { headers: { 'cache-control': 'no-cache' }, query: { currency: 'USD' } })], returns: 420 },
    { fn: 'getBalance', args: ['c-1', 'EUR'], replies: [ok(null, 403)], sent: [req('GET', `${API}/credits/c-1`, { headers: { 'cache-control': 'no-cache' }, query: { currency: 'EUR' } })], httpError: 403 },
  ],
  'billing/dunning.js': [
    { fn: 'sendReminder', args: ['inv-1'], replies: [ok({}, 201)], sent: [req('POST', `${API}/invoices/inv-1/reminders`, { headers: JSON_TYPE, body: { channel: 'email' } })], returns: 201, network: true },
    { fn: 'sendReminder', args: ['inv-1', { channel: 'sms', method: 'put' }], replies: [ok({}, 200)], sent: [req('PUT', `${API}/invoices/inv-1/reminders`, { headers: JSON_TYPE, body: { channel: 'sms' } })], returns: 200 },
    { fn: 'sendReminder', args: ['inv-0'], replies: [ok({ error: 'not found' }, 404)], sent: [req('POST', `${API}/invoices/inv-0/reminders`, { headers: JSON_TYPE, body: { channel: 'email' } })], returns: 404 },
  ],
  'users/profile.js': [
    { fn: 'getProfile', args: ['u-1'], replies: [ok({ id: 'u-1' })], sent: [req('GET', `${API}/users/u-1`)], returns: { id: 'u-1' }, network: true },
    { fn: 'getProfile', args: ['u-0'], replies: [ok({ error: 'not found' }, 404)], sent: [req('GET', `${API}/users/u-0`)], returns: null },
    { fn: 'updateProfile', args: ['u-1', { name: 'Kim' }], replies: [ok({ id: 'u-1', name: 'Kim' })], sent: [req('PATCH', `${API}/users/u-1`, { headers: JSON_TYPE, body: { name: 'Kim' } })], returns: { id: 'u-1', name: 'Kim' } },
    { fn: 'updateProfile', args: ['u-1', { name: '' }], replies: [ok({ error: 'invalid' }, 422)], sent: [req('PATCH', `${API}/users/u-1`, { headers: JSON_TYPE, body: { name: '' } })], httpError: 422 },
  ],
  'users/auth.js': [
    { fn: 'login', args: ['kim@example.test', 'pw'], replies: [ok({ token: 'tok-1' })], sent: [req('POST', `${AUTH}/login`, { headers: JSON_TYPE, body: { email: 'kim@example.test', password: 'pw' }, timeoutMs: 5000 })], returns: { ok: true, token: 'tok-1' }, network: true },
    { fn: 'login', args: ['kim@example.test', 'no'], replies: [ok({ error: 'bad credentials' }, 401)], sent: [req('POST', `${AUTH}/login`, { headers: JSON_TYPE, body: { email: 'kim@example.test', password: 'no' }, timeoutMs: 5000 })], returns: { ok: false } },
  ],
  'users/preferences.js': [
    { fn: 'getPreferences', args: ['u-1'], replies: [ok({ theme: 'dark' })], sent: [req('GET', `${API}/users/u-1/preferences`)], returns: { theme: 'dark' } },
    { fn: 'getPreferences', args: ['u-0'], replies: [ok(null, 404)], sent: [req('GET', `${API}/users/u-0/preferences`)], httpError: 404 },
    { fn: 'setPreference', args: ['u-1', 'theme', 'light'], replies: [ok(null, 204)], sent: [req('PUT', `${API}/users/u-1/preferences/theme`, { headers: JSON_TYPE, body: { value: 'light' } })], returns: true, network: true },
    { fn: 'setPreference', args: ['u-1', 'nope', 1], replies: [ok({ error: 'unknown key' }, 400)], sent: [req('PUT', `${API}/users/u-1/preferences/nope`, { headers: JSON_TYPE, body: { value: 1 } })], returns: false },
  ],
  'users/avatars.js': [
    { fn: 'uploadAvatar', args: ['u-1', 'aGVsbG8=', 'image/png'], replies: [ok({ url: 'https://cdn.acme.test/u-1.png' }, 201)], sent: [req('PUT', `${API}/users/u-1/avatar`, { headers: { 'content-type': 'image/png', 'x-encoding': 'base64' }, body: 'aGVsbG8=' })], returns: 'https://cdn.acme.test/u-1.png' },
    { fn: 'uploadAvatar', args: ['u-1', 'eA==', 'text/plain'], replies: [ok({ error: 'type' }, 415)], sent: [req('PUT', `${API}/users/u-1/avatar`, { headers: { 'content-type': 'text/plain', 'x-encoding': 'base64' }, body: 'eA==' })], httpError: 415 },
  ],
  'users/invites.js': [
    { fn: 'sendInvite', args: ['lee@example.test'], replies: [ok({ id: 'inv-9' }, 201)], sent: [req('POST', `${API}/invites`, { headers: JSON_TYPE, body: { email: 'lee@example.test', role: 'member' }, timeoutMs: 8000 })], returns: 'inv-9' },
    { fn: 'sendInvite', args: ['lee@example.test', 'admin'], replies: [ok(null, 409)], sent: [req('POST', `${API}/invites`, { headers: JSON_TYPE, body: { email: 'lee@example.test', role: 'admin' }, timeoutMs: 8000 })], httpError: 409 },
  ],
  'users/search.js': [
    { fn: 'findUsers', args: ['kim'], replies: [ok({ users: ['u-1'] })], sent: [req('GET', `${API}/users/search`, { query: { q: 'kim', limit: '10' } })], returns: ['u-1'] },
    { fn: 'findUsers', args: ['kim', { token: 'tok', limit: 3 }], replies: [ok({ users: [] })], sent: [req('GET', `${API}/users/search`, { headers: { authorization: 'Bearer tok' }, query: { q: 'kim', limit: '3' } })], returns: [] },
  ],
  'shipping/rates.js': [
    { fn: 'getRates', args: [{ country: 'NL', zip: '1011' }, 750], replies: [ok({ rates: [{ id: 'std' }] })], sent: [req('GET', `${CARRIER}/rates`, { query: { country: 'NL', zip: '1011', weight_g: '750' }, timeoutMs: 4000 })], returns: [{ id: 'std' }] },
    { fn: 'getRates', args: [{ country: 'US' }, 10], replies: [ok(null, 502)], sent: [req('GET', `${CARRIER}/rates`, { query: { country: 'US', weight_g: '10' }, timeoutMs: 4000 })], httpError: 502 },
  ],
  'shipping/labels.js': [
    { fn: 'createLabel', args: [{ id: 's-1', weightGrams: 300 }], replies: [ok({ id: 'l-1', pdf: 'https://carrier.acme.test/l-1.pdf' }, 201)], sent: [req('POST', `${CARRIER}/labels`, { headers: { 'x-carrier': 'acme-post', ...JSON_TYPE }, body: { shipment: 's-1', weight_g: 300 } })], returns: { labelId: 'l-1', url: 'https://carrier.acme.test/l-1.pdf' } },
    { fn: 'createLabel', args: [{ id: 's-2', weightGrams: 1 }, 'fastship'], replies: [ok(null, 400)], sent: [req('POST', `${CARRIER}/labels`, { headers: { 'x-carrier': 'fastship', ...JSON_TYPE }, body: { shipment: 's-2', weight_g: 1 } })], httpError: 400 },
  ],
  'shipping/tracking.js': [
    { fn: 'track', args: ['TRK1'], replies: [ok({ state: 'in_transit' })], sent: [req('GET', `${CARRIER}/tracking/TRK1`, { query: { events: 'last' } })], returns: { found: true, state: 'in_transit' }, network: true },
    { fn: 'track', args: ['TRK0'], replies: [ok({ error: 'unknown' }, 404)], sent: [req('GET', `${CARRIER}/tracking/TRK0`, { query: { events: 'last' } })], returns: { found: false } },
  ],
  'shipping/pickups.js': [
    { fn: 'schedulePickup', args: ['addr-1', '2026-02-03'], replies: [ok({ pickupId: 'pk-1' }, 201)], sent: [req('POST', `${CARRIER}/pickups`, { headers: JSON_TYPE, body: { address: 'addr-1', date: '2026-02-03' } })], returns: 'pk-1' },
    { fn: 'schedulePickup', args: ['addr-1', 'never'], replies: [ok({ error: 'date' }, 422)], sent: [req('POST', `${CARRIER}/pickups`, { headers: JSON_TYPE, body: { address: 'addr-1', date: 'never' } })], httpError: 422 },
    { fn: 'cancelPickup', args: ['pk-1'], replies: [ok(null, 204)], sent: [req('DELETE', `${CARRIER}/pickups/pk-1`)], returns: true, network: true },
    { fn: 'cancelPickup', args: ['pk-0'], replies: [ok({ error: 'not found' }, 404)], sent: [req('DELETE', `${CARRIER}/pickups/pk-0`)], returns: false },
  ],
  'shipping/zones.js': [
    { fn: 'listZones', args: [], replies: [ok(['z1', 'z2'])], sent: [req('GET', `${CARRIER}/zones`)], returns: ['z1', 'z2'] },
    { fn: 'zoneFor', args: ['90210'], replies: [ok({ zone: 'z8' })], sent: [req('GET', `${CARRIER}/zones/lookup`, { query: { zip: '90210', country: 'US' }, timeoutMs: 1500 })], returns: 'z8' },
    { fn: 'zoneFor', args: ['0000', 'NL'], replies: [ok(null, 404)], sent: [req('GET', `${CARRIER}/zones/lookup`, { query: { zip: '0000', country: 'NL' }, timeoutMs: 1500 })], httpError: 404 },
  ],
  'shipping/customs.js': [
    { fn: 'declare', args: ['s-1', [{ hs: '6912', qty: 2 }]], replies: [ok({ declarationId: 'd-1' }, 201)], sent: [req('POST', `${CARRIER}/customs/s-1`, { headers: { 'x-request-source': 'customs', ...JSON_TYPE }, body: { items: [{ hs: '6912', qty: 2 }] }, timeoutMs: 12000 })], returns: 'd-1' },
    { fn: 'declare', args: ['s-1', [], { timeoutSeconds: 40 }], replies: [ok({ declarationId: 'd-2' })], sent: [req('POST', `${CARRIER}/customs/s-1`, { headers: { 'x-request-source': 'customs', ...JSON_TYPE }, body: { items: [] }, timeoutMs: 40000 })], returns: 'd-2' },
  ],
  'notifications/email.js': [
    { fn: 'sendEmail', args: ['kim@example.test', 'welcome'], replies: [ok({ messageId: 'm-1' }, 202)], sent: [req('POST', `${NOTIFY}/email`, { headers: JSON_TYPE, body: { to: 'kim@example.test', template: 'welcome', vars: {} } })], returns: 'm-1' },
    { fn: 'sendEmail', args: ['bad', 'welcome', { a: 1 }], replies: [ok({ error: 'address' }, 400)], sent: [req('POST', `${NOTIFY}/email`, { headers: JSON_TYPE, body: { to: 'bad', template: 'welcome', vars: { a: 1 } } })], httpError: 400 },
  ],
  'notifications/sms.js': [
    { fn: 'sendSms', args: ['+15550100', 'hi'], replies: [ok({ id: 'sms-1' }, 201)], sent: [req('POST', `${NOTIFY}/sms`, { headers: JSON_TYPE, body: { number: '+15550100', text: 'hi' }, timeoutMs: 3000 })], returns: { queued: true, id: 'sms-1' }, network: true },
    { fn: 'sendSms', args: ['+15550100', 'again'], replies: [ok({ retry_after: 30 }, 429)], sent: [req('POST', `${NOTIFY}/sms`, { headers: JSON_TYPE, body: { number: '+15550100', text: 'again' }, timeoutMs: 3000 })], returns: { queued: false, retryAfter: 30 } },
  ],
  'notifications/webhooks.js': [
    {
      fn: 'deliver',
      args: [{ url: 'https://hooks.example.test/a', secret: 's3' }, { type: 'order.paid' }],
      replies: [ok('ok')],
      sent: [req('POST', 'https://hooks.example.test/a', { headers: { 'x-signature': 'sha1=s3', ...JSON_TYPE }, body: { type: 'order.paid' } })],
      returns: { delivered: true, status: 200 },
      network: true,
    },
    {
      fn: 'deliver',
      args: [{ url: 'https://hooks.example.test/b', secret: 'k', method: 'put', timeoutSeconds: 4 }, { type: 'ping' }],
      replies: [ok(null, 204)],
      sent: [req('PUT', 'https://hooks.example.test/b', { headers: { 'x-signature': 'sha1=k', ...JSON_TYPE }, body: { type: 'ping' }, timeoutMs: 4000 })],
      returns: { delivered: true, status: 204 },
    },
    {
      fn: 'deliver',
      args: [{ url: 'https://hooks.example.test/c', secret: 'k' }, { type: 'ping' }],
      replies: [ok('boom', 500)],
      sent: [req('POST', 'https://hooks.example.test/c', { headers: { 'x-signature': 'sha1=k', ...JSON_TYPE }, body: { type: 'ping' } })],
      returns: { delivered: false, status: 500 },
    },
  ],
  'notifications/templates.js': [
    { fn: 'getTemplate', args: ['welcome'], replies: [ok({ subject: 'Hi' })], sent: [req('GET', `${NOTIFY}/templates/welcome`, { query: { locale: 'en' } })], returns: { subject: 'Hi' } },
    { fn: 'getTemplate', args: ['nope', 'pt'], replies: [ok(null, 404)], sent: [req('GET', `${NOTIFY}/templates/nope`, { query: { locale: 'pt' } })], httpError: 404 },
    { fn: 'renderTemplate', args: ['welcome', { name: 'Kim' }], replies: [ok({ html: '<p>Hi Kim</p>' })], sent: [req('POST', `${NOTIFY}/templates/welcome/render`, { headers: JSON_TYPE, body: { name: 'Kim' } })], returns: '<p>Hi Kim</p>' },
  ],
  'notifications/push.js': [
    { fn: 'sendPush', args: ['dev-1', { title: 'Hi' }], replies: [ok({ accepted: true }, 202)], sent: [req('POST', `${NOTIFY}/push`, { headers: JSON_TYPE, body: { device: 'dev-1', payload: { title: 'Hi' } } })], returns: true },
    { fn: 'sendPush', args: ['dev-1', {}, { ttl: 0, priority: 'high' }], replies: [ok({ accepted: false })], sent: [req('POST', `${NOTIFY}/push`, { headers: { 'x-ttl': '0', 'x-priority': 'high', ...JSON_TYPE }, body: { device: 'dev-1', payload: {} } })], returns: false },
    { fn: 'sendPush', args: ['dev-0', {}], replies: [ok(null, 410)], sent: [req('POST', `${NOTIFY}/push`, { headers: JSON_TYPE, body: { device: 'dev-0', payload: {} } })], httpError: 410 },
  ],
  'notifications/digest.js': [
    {
      fn: 'buildDigest',
      args: ['u-1'],
      replies: [ok({ locale: 'en', lastDigestAt: '2026-01-05' }), ok({ events: ['e1'] })],
      sent: [req('GET', `${NOTIFY}/digest/u-1/settings`), req('GET', `${API}/activity`, { query: { user: 'u-1', since: '2026-01-05' }, timeoutMs: 6000 })],
      returns: { locale: 'en', events: ['e1'] },
    },
    { fn: 'buildDigest', args: ['u-0'], replies: [ok(null, 404)], sent: [req('GET', `${NOTIFY}/digest/u-0/settings`)], httpError: 404 },
    {
      fn: 'buildDigest',
      args: ['u-2'],
      replies: [ok({ locale: 'pt' }), ok({ error: 'down' }, 503)],
      sent: [req('GET', `${NOTIFY}/digest/u-2/settings`), req('GET', `${API}/activity`, { query: { user: 'u-2' }, timeoutMs: 6000 })],
      httpError: 503,
    },
  ],
};

/** Runs `fn` with a transport that answers from `replies` (or throws `fail`), and returns what was sent. */
async function withTransport(replies, fail, fn) {
  const sent = [];
  const queue = [...replies];
  const previous = setTransport(async (r) => {
    sent.push(r);
    if (fail !== undefined) throw fail;
    const reply = queue.shift();
    if (reply === undefined) throw new Error(`unexpected extra request: ${r.method} ${r.url}`);
    return reply;
  });
  try {
    return { outcome: await fn().then((value) => ({ value }), (error) => ({ error })), sent };
  } finally {
    setTransport(previous);
  }
}

const describeCase = (c) => `${c.fn}(${c.args.map((a) => JSON.stringify(a)).join(', ')})`;

for (const [file, cases] of Object.entries(CASES)) {
  test(`behaviour: ${file}`, async () => {
    const mod = await import(`../src/services/${file}`);
    for (const c of cases) {
      const label = describeCase(c);
      assert.equal(typeof mod[c.fn], 'function', `${file} exports ${c.fn}`);
      const { outcome, sent } = await withTransport(c.replies, undefined, async () => mod[c.fn](...structuredClone(c.args)));
      assert.deepEqual(sent, c.sent, `${label}: requests sent`);
      if (c.httpError !== undefined) {
        assert.ok(outcome.error !== undefined, `${label}: rejects for status ${c.httpError}`);
        assert.equal(outcome.error.name, 'HttpError', `${label}: rejects with the HttpError of request (got ${outcome.error})`);
        assert.equal(outcome.error.status, c.httpError, `${label}: HttpError status`);
      } else {
        if (outcome.error !== undefined) assert.fail(`${label}: rejected with ${outcome.error}`);
        assert.deepEqual(outcome.value, c.returns, `${label}: result`);
      }
      if (c.network === true) {
        const down = new Error('network down');
        const failed = await withTransport([], down, async () => mod[c.fn](...structuredClone(c.args)));
        assert.equal(failed.outcome.error, down, `${label}: an error that is not an HttpError propagates`);
      }
    }
  });
}
