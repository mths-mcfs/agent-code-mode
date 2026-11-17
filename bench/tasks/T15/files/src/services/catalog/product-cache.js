import { legacyFetch } from '../../lib/legacy-http.js';
import { legacyFetch as cacheFetch, legacyStore } from '../../vendor/cache/legacy.js';
import { API } from '../config.js';

/** Product by id, read through the in-memory cache (5 minutes). */
export async function getCachedProduct(id) {
  const key = `product:${id}`;
  const hit = cacheFetch(key);
  if (hit !== undefined) return hit;
  const res = await legacyFetch(`${API}/products/${id}`, { timeout: 2 });
  legacyStore(key, res.data, 300);
  return res.data;
}
