import { legacyFetch } from '../../lib/legacy-http.js';
import { API } from '../config.js';

/** Exports the orders matching a filter expression as CSV text. Large exports get two minutes. */
export async function exportOrders(filter) {
  const res = await legacyFetch(`${API}/orders/export`, {
    method: 'POST',
    body: filter,
    headers: { 'content-type': 'text/plain', accept: 'text/csv' },
    timeout: 120,
  });
  return res.data;
}
