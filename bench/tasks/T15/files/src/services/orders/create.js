import { legacyFetch } from '../../lib/legacy-http.js';
import { API } from '../config.js';

export async function createOrder(order) {
  const res = await legacyFetch(`${API}/orders`, {
    method: 'POST',
    json: order,
    headers: { 'Idempotency-Key': order.clientRef },
  });
  return { id: res.data.id, status: res.data.status };
}
