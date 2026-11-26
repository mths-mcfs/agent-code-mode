import { applyVolumeDiscount } from './discounts.js';
import { lineItems, lineTotal } from './lines.js';
import { taxCents } from './tax.js';

/** Builds the invoice of one order: discounted lines, subtotal, tax and total, all in cents. */
export function buildInvoice(order, region = 'domestic') {
  const lines = applyVolumeDiscount(lineItems(order));
  const subtotalCents = lines.reduce((sum, line) => sum + lineTotal(line), 0);
  const tax = taxCents(subtotalCents, region);
  return { orderId: order.id, region, lines, subtotalCents, taxCents: tax, totalCents: subtotalCents + tax };
}
