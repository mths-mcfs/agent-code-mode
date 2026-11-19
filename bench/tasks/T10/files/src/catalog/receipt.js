import { formatPrice as money } from '../lib/price.js';

/** Receipt lines: "<qty> x <name>  <line total>", plain amounts in the receipt currency. */
export function receiptLines(lines, currency = 'USD') {
  return lines.map((l) => `${l.qty} x ${l.name}  ${money(l.qty * l.cents, currency, false)}`);
}

export function receiptTotal(lines, currency) {
  return `TOTAL ${money(lines.reduce((s, l) => s + l.qty * l.cents, 0), currency)}`;
}
