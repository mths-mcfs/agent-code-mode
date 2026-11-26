import { legacyFetch } from '../../lib/legacy-http.js';
import { NOTIFY } from '../config.js';

/** Sends a push notification. `ttl` is in seconds; `priority` is 'high' or 'normal'. */
export async function sendPush(deviceId, payload, { ttl, priority } = {}) {
  const headers = {};
  if (ttl !== undefined) headers['x-ttl'] = String(ttl);
  if (priority) headers['x-priority'] = priority;
  const opts = { method: 'POST', json: { device: deviceId, payload }, headers };
  const res = await legacyFetch(`${NOTIFY}/push`, opts);
  return res.data.accepted;
}
