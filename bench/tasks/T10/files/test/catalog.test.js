import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPrice, priceLabel, plainLabel, csvRow, priceTable, summaryLine } from '../src/index.js';

test('public formatPrice keeps the positional form', () => {
  assert.equal(formatPrice(123456), '$1234.56');
  assert.equal(formatPrice(250, 'EUR'), '€2.50');
  assert.equal(formatPrice(250, 'EUR', false), '2.50 EUR');
});

test('catalog labels and exports', () => {
  const item = { sku: 'SKU-APPLE', name: 'Apples', cents: 199, currency: 'GBP' };
  assert.equal(priceLabel(item), 'Apples £1.99');
  assert.equal(plainLabel(item), 'Apples 1.99 GBP');
  assert.equal(csvRow(item), 'SKU-APPLE,Apples,1.99 USD');
  assert.equal(priceTable([{ name: 'Apples', cents: 199 }]), 'Apples       $1.99');
  assert.equal(summaryLine([item, item]), 'Total (2 items): $3.98');
});
