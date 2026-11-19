import { request } from '../../lib/http.js';
import { API } from '../config.js';

export async function createOrder(order) {
  const res = await request({
    method: 'POST',
    url: `${API}/orders`,
    headers: { 'Idempotency-Key': order.clientRef, 'content-type': 'application/json' },
    body: order,
  });
  return { id: res.body.id, status: res.body.status };
}
