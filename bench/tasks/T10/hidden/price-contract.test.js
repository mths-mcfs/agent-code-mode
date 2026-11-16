import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPrice } from '../src/lib/price.js';
import * as api from '../src/index.js';
import { priceLabel, plainLabel } from '../src/catalog/labels.js';
import { csv, csvRow } from '../src/catalog/export.js';
import { priceTable, priceDelta } from '../src/catalog/table.js';
import { summaryLine, totalsByCurrency } from '../src/catalog/summary.js';
import { receiptLines, receiptTotal } from '../src/catalog/receipt.js';
import { banner, euro } from '../src/catalog/promo.js';

// The formatter before the change: every output must stay exactly what it gave.
const SYMBOLS = { USD: '$', EUR: '€', GBP: '£' };
function before(cents, currency = 'USD', withSymbol = true) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const amount = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  if (!withSymbol) return `${sign}${amount} ${currency}`;
  return `${sign}${SYMBOLS[currency] ?? `${currency} `}${amount}`;
}

const AMOUNTS = [0, 5, 199, 100000, -250, -7];
const CURRENCIES = [undefined, 'USD', 'EUR', 'GBP', 'JPY'];
const SYMBOL_FLAGS = [undefined, true, false];

test('src/lib/price.js takes an options object', () => {
  for (const cents of AMOUNTS) {
    assert.equal(formatPrice(cents), before(cents));
    assert.equal(formatPrice(cents, {}), before(cents));
    for (const currency of CURRENCIES) {
      for (const symbol of SYMBOL_FLAGS) assert.equal(formatPrice(cents, { currency, symbol }), before(cents, currency, symbol));
    }
  }
});

test('src/index.js keeps the positional form and accepts the options form', () => {
  for (const cents of AMOUNTS) {
    assert.equal(api.formatPrice(cents), before(cents));
    for (const currency of CURRENCIES) {
      for (const symbol of SYMBOL_FLAGS) {
        assert.equal(api.formatPrice(cents, currency, symbol), before(cents, currency, symbol));
        assert.equal(api.formatPrice(cents, { currency, symbol }), before(cents, currency, symbol));
      }
    }
  }
});

const ITEMS = [
  { sku: 'SKU-APPLE', name: 'Apples', cents: 199, currency: 'GBP' },
  { sku: 'SKU-BREAD', name: 'Bread', cents: 350 },
  { sku: 'SKU-CHEESE', name: 'Cheese', cents: 1205, currency: 'EUR' },
  { sku: 'SKU-DATES', name: 'Dates', cents: -40, currency: 'JPY' },
];

test('catalog outputs are unchanged', () => {
  for (const item of ITEMS) {
    assert.equal(priceLabel(item), `${item.name} ${before(item.cents, item.currency)}`);
    assert.equal(plainLabel(item), `${item.name} ${before(item.cents, item.currency, false)}`);
    assert.equal(csvRow(item), [item.sku, item.name, before(item.cents, undefined, false)].join(','));
  }
  assert.equal(csv(ITEMS).split('\n').length, ITEMS.length + 1);
  const rows = [
    { name: 'Apples', cents: 199 },
    { name: 'Bread', cents: 350, currency: 'EUR' },
    { name: 'Cheese', cents: 1205, currency: 'GBP', showSymbol: false },
    { name: 'Dates', cents: 99, showSymbol: true },
    { name: 'Eggs', cents: 12, currency: 'JPY', showSymbol: undefined },
  ];
  assert.equal(priceTable(rows), rows.map((r) => `${r.name.padEnd(12)} ${before(r.cents, r.currency, r.showSymbol)}`).join('\n'));
  assert.equal(priceDelta(rows[1], rows[0]), before(199 - 350, 'EUR'));
  assert.equal(priceDelta(rows[0], rows[2]), before(1205 - 199));
  assert.equal(summaryLine(ITEMS), `Total (4 items): ${before(199 + 350 + 1205 - 40)}`);
  assert.equal(summaryLine(ITEMS, 'EUR'), `Total (4 items): ${before(199 + 350 + 1205 - 40, 'EUR')}`);
  assert.deepEqual(totalsByCurrency(ITEMS), [before(1205, 'EUR', false), before(199, 'GBP', false), before(-40, 'JPY', false), before(350, 'USD', false)]);
});

test('aliased and namespace callers are unchanged', () => {
  const lines = [{ qty: 2, name: 'Apples', cents: 199 }, { qty: 1, name: 'Honey', cents: 1250 }];
  assert.deepEqual(receiptLines(lines), ['2 x Apples  3.98 USD', '1 x Honey  12.50 USD']);
  assert.deepEqual(receiptLines(lines, 'GBP'), ['2 x Apples  3.98 GBP', '1 x Honey  12.50 GBP']);
  assert.equal(receiptTotal(lines), `TOTAL ${before(1648)}`);
  assert.equal(receiptTotal(lines, 'EUR'), `TOTAL ${before(1648, 'EUR')}`);
  assert.equal(euro(5), before(5, 'EUR'));
  assert.equal(banner({ cents: 900, wasCents: 1200 }), `Now only ${before(900, 'EUR')} (was ${before(1200, 'EUR', true)})`);
  assert.equal(api.banner({ cents: -1, wasCents: 0 }), `Now only ${before(-1, 'EUR')} (was ${before(0, 'EUR')})`);
});
