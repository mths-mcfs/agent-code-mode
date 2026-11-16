import { formatPrice } from '../lib/price.js';

/** Text table of rows { name, cents, currency?, showSymbol? }. */
export function priceTable(rows) {
  return rows.map((row) => `${row.name.padEnd(12)} ${formatPrice(row.cents, { currency: row.currency, symbol: row.showSymbol })}`).join('\n');
}

/** Price difference between two rows, in the first row's currency. */
export function priceDelta(a, b) {
  return formatPrice(b.cents - a.cents, { currency: a.currency });
}
