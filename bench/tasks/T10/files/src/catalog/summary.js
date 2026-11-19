import { formatPrice } from '../lib/price.js';

/** One-line total of items (all in one currency; USD when none is given). */
export function summaryLine(items, currency) {
  const total = items.reduce((sum, item) => sum + item.cents, 0);
  return `Total (${items.length} items): ${formatPrice(total, currency)}`;
}

/** Totals per currency, plain (no symbols), sorted by currency code. */
export function totalsByCurrency(items) {
  const totals = new Map();
  for (const item of items) totals.set(item.currency ?? 'USD', (totals.get(item.currency ?? 'USD') ?? 0) + item.cents);
  return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([cur, cents]) => formatPrice(cents, cur, false));
}
