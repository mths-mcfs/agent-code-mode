import { formatPrice } from '../lib/price.js';

/** Shelf label: the price with its symbol. */
export function priceLabel(item) {
  return `${item.name} ${formatPrice(item.cents, { currency: item.currency })}`;
}

/** Label for screen readers and plain-text receipts: no symbol, currency code after the amount. */
export function plainLabel(item) {
  return `${item.name} ${formatPrice(item.cents, { currency: item.currency, symbol: false })}`;
}
