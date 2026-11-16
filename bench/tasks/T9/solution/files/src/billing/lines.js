import { normalizeSku } from '../lib/sku.js';

/** The billable lines of an order, with normalized SKUs. */
export function lineItems(order) {
  return order.items.map((item) => {
    item.sku = normalizeSku(item.sku);
    return item;
  });
}

/** The line at another unit price. */
export function withUnitPrice(line, unitPriceCents) {
  return { ...line, unitPriceCents };
}

export function lineTotal(line) {
  return line.qty * line.unitPriceCents;
}
