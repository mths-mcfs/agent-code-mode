import * as legacy from '../../lib/legacy-http.js';
import { API } from '../config.js';

/** Cancels an order. An order that already shipped answers 409 and is not cancelled. */
export async function cancelOrder(id, reason) {
  const res = await legacy.legacyFetch(`${API}/orders/${id}`, { method: 'delete', qs: { reason } });
  if (res.status === 409) return { cancelled: false, reason: res.data.error };
  return { cancelled: true };
}
