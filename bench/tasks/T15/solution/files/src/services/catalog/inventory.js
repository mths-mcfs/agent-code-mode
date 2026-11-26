import { request } from '../../lib/http.js';
import { API } from '../config.js';

const stockUrl = (sku) => `${API}/inventory/${encodeURIComponent(sku)}`;

export async function getStock(sku) {
  const stock = (await request({ url: stockUrl(sku), headers: { Accept: 'application/json' } })).body;
  return stock.available;
}

export async function reserveStock(sku, qty) {
  const res = await request({
    method: 'POST',
    url: `${stockUrl(sku)}/reserve`,
    headers: { 'content-type': 'application/json' },
    body: { qty },
  });
  return res.body;
}
