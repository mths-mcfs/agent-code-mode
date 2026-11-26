import { legacyFetch, legacyStore } from '../../vendor/cache/legacy.js';

/** Price of a SKU from the in-memory cache; `load` computes it on a miss. No HTTP here. */
export async function cachedPrice(sku, load) {
  const cached = legacyFetch(`price:${sku}`);
  if (cached !== undefined) return cached;
  const price = await load(sku);
  legacyStore(`price:${sku}`, price, 120);
  return price;
}
