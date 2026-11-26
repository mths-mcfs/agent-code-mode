import { request } from '../../lib/http.js';
import { API } from '../config.js';

export async function getProduct(id) {
  const res = await request({ url: `${API}/products/${id}` });
  return res.body;
}

export async function listProducts({ page = 1, perPage = 20 } = {}) {
  const res = await request({ url: `${API}/products`, query: { page, per_page: perPage } });
  return res.body.items;
}
