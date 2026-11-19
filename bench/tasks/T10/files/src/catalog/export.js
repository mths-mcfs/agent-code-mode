import { formatPrice } from '../lib/price.js';

/** CSV export: prices are always plain USD amounts. */
export function csvRow(item) {
  return [item.sku, item.name, formatPrice(item.cents, undefined, false)].join(',');
}

export function csv(items) {
  return ['sku,name,price', ...items.map(csvRow)].join('\n');
}
