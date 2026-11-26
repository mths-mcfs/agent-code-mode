import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyVolumeDiscount } from '../src/billing/discounts.js';
import { buildInvoice } from '../src/billing/invoice.js';
import { quoteTotal } from '../src/billing/quote.js';
import { buildStatement, CREDIT_LIMIT_CENTS } from '../src/billing/statement.js';

const bulk = () => ({
  id: 'ORD-B',
  items: [
    { sku: 'SKU-APPLE', qty: 6, unitPriceCents: 1999 },
    { sku: 'SKU-FLOUR', qty: 2, unitPriceCents: 450 },
    { sku: 'SKU-EGGS', qty: 12, unitPriceCents: 35 },
  ],
});
const small = () => ({ id: 'ORD-S', items: [{ sku: 'SKU-HONEY', qty: 1, unitPriceCents: 1200 }] });

test('a bulk invoice has the documented totals', () => {
  const inv = buildInvoice(bulk(), 'domestic');
  // 6 * 1799 + 2 * 450 + 12 * 32 = 10794 + 900 + 384
  assert.equal(inv.subtotalCents, 12078);
  assert.equal(inv.taxCents, 966);
  assert.equal(inv.totalCents, 13044);
});

test('building an invoice twice from the same order gives the same invoice', () => {
  const order = bulk();
  const first = buildInvoice(order, 'nearby');
  const second = buildInvoice(order, 'nearby');
  assert.equal(second.totalCents, first.totalCents);
  assert.deepEqual(second, first);
});

test('building an invoice leaves the order unchanged', () => {
  const order = bulk();
  const before = structuredClone(order);
  buildInvoice(order, 'domestic');
  assert.deepEqual(order, before);
});

test('statement invoices match invoices built on their own', () => {
  const orders = [bulk(), small(), { ...bulk(), id: 'ORD-C' }];
  const alone = orders.map((o) => buildInvoice(structuredClone(o), 'nearby').totalCents);
  const statement = buildStatement(orders, 'nearby');
  assert.deepEqual(statement.invoices.map((i) => i.totalCents), alone);
  assert.equal(statement.totalCents, alone.reduce((a, b) => a + b, 0));
  // And an invoice built after the statement is still the same.
  assert.equal(buildInvoice(orders[0], 'nearby').totalCents, alone[0]);
});

test('statement still stops at the credit limit', () => {
  const big = (id) => ({ id, items: [{ sku: 'SKU-CHEESE', qty: 10, unitPriceCents: 20000 }] });
  const one = buildInvoice(big('X'), 'international').totalCents;
  assert.equal(one, 180000);
  const statement = buildStatement([big('O1'), big('O2'), big('O3'), big('O4')], 'international');
  assert.equal(statement.invoices.length, Math.floor(CREDIT_LIMIT_CENTS / one));
  assert.equal(statement.totalCents, statement.invoices.length * one);
});

test('quoting the same cart twice gives the same total and leaves the cart unchanged', () => {
  const cart = [{ sku: 'SKU-GRAPES', qty: 5, unitPriceCents: 999 }];
  const before = structuredClone(cart);
  const first = quoteTotal(cart, 'domestic');
  assert.equal(first, 5 * 899 + Math.floor((5 * 899 * 800 + 5000) / 10000));
  assert.equal(quoteTotal(cart, 'domestic'), first);
  assert.deepEqual(cart, before);
});

test('applyVolumeDiscount does not modify the lines it is given', () => {
  const lines = [{ sku: 'SKU-APPLE', qty: 5, unitPriceCents: 155 }, { sku: 'SKU-BREAD', qty: 4, unitPriceCents: 300 }];
  const before = structuredClone(lines);
  const out = applyVolumeDiscount(lines);
  assert.deepEqual(lines, before);
  assert.deepEqual(out.map((l) => l.unitPriceCents), [140, 300]);
});
