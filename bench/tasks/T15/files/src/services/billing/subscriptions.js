import * as legacy from '../../lib/legacy-http.js';
import { API } from '../config.js';

export function changePlan(subscriptionId, plan) {
  return legacy.legacyJson(`${API}/subscriptions/${subscriptionId}`, { method: 'PATCH', json: { plan } });
}

export async function pauseSubscription(subscriptionId, days) {
  const sub = await legacy.legacyJson(`${API}/subscriptions/${subscriptionId}/pause`, {
    method: 'post',
    json: { days },
    timeout: 10,
  });
  return sub.resumesAt;
}
