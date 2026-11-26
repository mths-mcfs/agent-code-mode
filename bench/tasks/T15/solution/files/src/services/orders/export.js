import { request } from '../../lib/http.js';
import { API } from '../config.js';

/** Exports the orders matching a filter expression as CSV text. Large exports get two minutes. */
export async function exportOrders(filter) {
  const res = await request({
    method: 'POST',
    url: `${API}/orders/export`,
    body: filter,
    headers: { 'content-type': 'text/plain', accept: 'text/csv' },
    timeoutMs: 120000,
  });
  return res.body;
}
