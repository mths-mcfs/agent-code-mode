import { applyVolumeDiscount } from './discounts.js';
import { lineTotal } from './lines.js';
import { taxCents } from './tax.js';

/** Total of a cart quote (lines of { sku, qty, unitPriceCents }), tax included. */
export function quoteTotal(lines, region = 'domestic') {
  const subtotal = applyVolumeDiscount(lines).reduce((sum, line) => sum + lineTotal(line), 0);
  return subtotal + taxCents(subtotal, region);
}
