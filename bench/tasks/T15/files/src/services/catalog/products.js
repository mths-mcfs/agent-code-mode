import { legacyFetch } from '../../lib/legacy-http.js';
import { API } from '../config.js';

export async function getProduct(id) {
  const res = await legacyFetch(`${API}/products/${id}`);
  return res.data;
}

export async function listProducts({ page = 1, perPage = 20 } = {}) {
  const res = await legacyFetch(`${API}/products`, { qs: { page, per_page: perPage } });
  return res.data.items;
}
