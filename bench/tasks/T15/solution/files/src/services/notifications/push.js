import { request } from '../../lib/http.js';
import { NOTIFY } from '../config.js';

/** Sends a push notification. `ttl` is in seconds; `priority` is 'high' or 'normal'. */
export async function sendPush(deviceId, payload, { ttl, priority } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (ttl !== undefined) headers['x-ttl'] = String(ttl);
  if (priority) headers['x-priority'] = priority;
  const res = await request({ method: 'POST', url: `${NOTIFY}/push`, body: { device: deviceId, payload }, headers });
  return res.body.accepted;
}
