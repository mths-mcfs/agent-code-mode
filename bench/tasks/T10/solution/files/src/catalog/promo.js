import * as price from '../lib/price.js';

/** Banner prices for the euro store. */
export const euro = (cents) => price.formatPrice(cents, { currency: 'EUR' });

export function banner(item) {
  return `Now only ${euro(item.cents)} (was ${price.formatPrice(item.wasCents, { currency: 'EUR', symbol: true })})`;
}
