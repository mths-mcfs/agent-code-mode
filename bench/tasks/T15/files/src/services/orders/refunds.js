import { legacyJson } from '../../lib/legacy-http.js';
import { API } from '../config.js';

/** Refunds go through the payment provider and may take a while: 20 seconds. */
export async function requestRefund(orderId, cents) {
  const refund = await legacyJson(`${API}/orders/${orderId}/refunds`, {
    method: 'POST',
    json: { amount_cents: cents },
    timeout: 20,
  });
  return refund.refundId;
}
