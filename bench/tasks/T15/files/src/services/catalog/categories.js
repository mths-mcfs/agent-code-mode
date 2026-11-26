import * as legacy from '../../lib/legacy-http.js';
import { API } from '../config.js';

export function listCategories() {
  return legacy.legacyJson(`${API}/categories`);
}

/** Returns the category, or null when there is none with that slug. */
export async function getCategory(slug) {
  const res = await legacy.legacyFetch(`${API}/categories/${slug}`);
  if (res.status === 404) return null;
  return res.data;
}
