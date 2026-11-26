import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInvoice } from '../src/billing/invoice.js';
import { quoteTotal } from '../src/billing/quote.js';
import { buildStatement } from '../src/billing/statement.js';

test('invoice applies the volume discount and the regional tax', () => {
  const order = { id: 'ORD-1', items: [{ sku: 'SKU-APPLE', qty: 5, unitPriceCents: 155 }, { sku: 'SKU-BREAD', qty: 1, unitPriceCents: 300 }] };
  const invoice = buildInvoice(order, 'nearby');
  assert.equal(invoice.subtotalCents, 5 * 140 + 300);
  assert.equal(invoice.taxCents, 100);
  assert.equal(invoice.totalCents, 1100);
});

test('quote totals a cart', () => {
  assert.equal(quoteTotal([{ sku: 'SKU-EGGS', qty: 2, unitPriceCents: 250 }], 'domestic'), 540);
});

test('statement lists the invoices of small orders', () => {
  const orders = [
    { id: 'ORD-2', items: [{ sku: 'SKU-HONEY', qty: 1, unitPriceCents: 1000 }] },
    { id: 'ORD-3', items: [{ sku: 'SKU-DATES', qty: 2, unitPriceCents: 450 }] },
  ];
  const statement = buildStatement(orders, 'international');
  assert.deepEqual(statement.invoices.map((i) => i.totalCents), [1000, 900]);
  assert.equal(statement.totalCents, 1900);
});
