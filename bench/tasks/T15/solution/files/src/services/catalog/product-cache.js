import { request } from '../../lib/http.js';
import { legacyFetch as cacheFetch, legacyStore } from '../../vendor/cache/legacy.js';
import { API } from '../config.js';

/** Product by id, read through the in-memory cache (5 minutes). */
export async function getCachedProduct(id) {
  const key = `product:${id}`;
  const hit = cacheFetch(key);
  if (hit !== undefined) return hit;
  const res = await request({ url: `${API}/products/${id}`, timeoutMs: 2000 });
  legacyStore(key, res.body, 300);
  return res.body;
}
