import { HttpError, request } from '../../lib/http.js';
import { API } from '../config.js';

export async function listCategories() {
  return (await request({ url: `${API}/categories` })).body;
}

/** Returns the category, or null when there is none with that slug. */
export async function getCategory(slug) {
  try {
    const res = await request({ url: `${API}/categories/${slug}` });
    return res.body;
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    if (err.status === 404) return null;
    return err.body;
  }
}
