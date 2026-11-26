import { request } from '../../lib/http.js';
import { API } from '../config.js';

/** Refunds go through the payment provider and may take a while: 20 seconds. */
export async function requestRefund(orderId, cents) {
  const res = await request({
    method: 'POST',
    url: `${API}/orders/${orderId}/refunds`,
    headers: { 'content-type': 'application/json' },
    body: { amount_cents: cents },
    timeoutMs: 20000,
  });
  return res.body.refundId;
}
