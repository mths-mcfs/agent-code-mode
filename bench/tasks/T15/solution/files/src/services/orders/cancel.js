import { HttpError, request } from '../../lib/http.js';
import { API } from '../config.js';

/** Cancels an order. An order that already shipped answers 409 and is not cancelled. */
export async function cancelOrder(id, reason) {
  try {
    await request({ method: 'DELETE', url: `${API}/orders/${id}`, query: { reason } });
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    if (err.status === 409) return { cancelled: false, reason: err.body.error };
  }
  return { cancelled: true };
}
