import { request } from '../../lib/http.js';
import { API } from '../config.js';

const JSON_HEADERS = { 'content-type': 'application/json' };

export async function changePlan(subscriptionId, plan) {
  const res = await request({ method: 'PATCH', url: `${API}/subscriptions/${subscriptionId}`, headers: JSON_HEADERS, body: { plan } });
  return res.body;
}

export async function pauseSubscription(subscriptionId, days) {
  const res = await request({
    method: 'POST',
    url: `${API}/subscriptions/${subscriptionId}/pause`,
    headers: JSON_HEADERS,
    body: { days },
    timeoutMs: 10000,
  });
  return res.body.resumesAt;
}
