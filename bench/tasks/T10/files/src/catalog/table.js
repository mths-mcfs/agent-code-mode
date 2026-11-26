import { formatPrice } from '../lib/price.js';

const fmt = (cents, ...rest) => formatPrice(cents, ...rest);

/** Text table of rows { name, cents, currency?, showSymbol? }. */
export function priceTable(rows) {
  return rows.map((row) => `${row.name.padEnd(12)} ${fmt(row.cents, row.currency, row.showSymbol)}`).join('\n');
}

/** Price difference between two rows, in the first row's currency. */
export function priceDelta(a, b) {
  return fmt(b.cents - a.cents, a.currency);
}
