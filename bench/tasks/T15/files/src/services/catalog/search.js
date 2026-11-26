import { legacyFetch as get } from '../../lib/legacy-http.js';
import { API } from '../config.js';

/** Full-text search. The search backend is slow to fail, so the call gives up after 3 seconds. */
export async function searchProducts(term, limit = 10) {
  const { data } = await get(`${API}/search`, { qs: { q: term, limit }, timeout: 3 });
  return data.hits;
}
