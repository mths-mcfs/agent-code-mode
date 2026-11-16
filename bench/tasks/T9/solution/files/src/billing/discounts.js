import { withUnitPrice } from './lines.js';

/** Volume discount: 10% off the unit price of every line with at least VOLUME_MIN_QTY units (rounded to the cent). */

export const VOLUME_MIN_QTY = 5;
export const VOLUME_DISCOUNT_PERCENT = 10;

export function discountedUnitPrice(unitPriceCents) {
  return Math.round((unitPriceCents * (100 - VOLUME_DISCOUNT_PERCENT)) / 100);
}

export function applyVolumeDiscount(lines) {
  return lines.map((line) => (line.qty >= VOLUME_MIN_QTY ? withUnitPrice(line, discountedUnitPrice(line.unitPriceCents)) : line));
}
