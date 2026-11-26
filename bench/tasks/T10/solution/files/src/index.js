/** Public API of acme-orders. Code outside this repository imports from here. */
import { formatPrice as formatWithOptions } from './lib/price.js';

/** Accepts the options form and, for existing callers, the old positional form (cents, currency, withSymbol). */
export function formatPrice(cents, currencyOrOptions, withSymbol) {
  if (currencyOrOptions !== null && typeof currencyOrOptions === 'object') return formatWithOptions(cents, currencyOrOptions);
  return formatWithOptions(cents, { currency: currencyOrOptions, symbol: withSymbol });
}

export { priceLabel, plainLabel } from './catalog/labels.js';
export { csv, csvRow } from './catalog/export.js';
export { priceTable, priceDelta } from './catalog/table.js';
export { summaryLine, totalsByCurrency } from './catalog/summary.js';
export { receiptLines, receiptTotal } from './catalog/receipt.js';
export { banner } from './catalog/promo.js';
