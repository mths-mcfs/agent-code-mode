import { request } from '../../lib/http.js';
import { API } from '../config.js';

/** Full-text search. The search backend is slow to fail, so the call gives up after 3 seconds. */
export async function searchProducts(term, limit = 10) {
  const { body } = await request({ url: `${API}/search`, query: { q: term, limit }, timeoutMs: 3000 });
  return body.hits;
}
