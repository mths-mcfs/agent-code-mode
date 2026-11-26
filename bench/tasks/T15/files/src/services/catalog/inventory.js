import { legacyJson } from '../../lib/legacy-http.js';
import { API } from '../config.js';

const stockUrl = (sku) => `${API}/inventory/${encodeURIComponent(sku)}`;

export async function getStock(sku) {
  const stock = await legacyJson(stockUrl(sku), { headers: { Accept: 'application/json' } });
  return stock.available;
}

export function reserveStock(sku, qty) {
  return legacyJson(`${stockUrl(sku)}/reserve`, { method: 'POST', json: { qty } });
}
