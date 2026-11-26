import { legacyFetch as send } from '../../lib/legacy-http.js';
import { NOTIFY } from '../config.js';

/** Sends a text message. When the provider is rate limited (429) the message is not queued. */
export async function sendSms(number, text) {
  const res = await send(`${NOTIFY}/sms`, { method: 'post', json: { number, text }, timeout: 3 });
  if (res.status === 429) return { queued: false, retryAfter: res.data.retry_after };
  return { queued: true, id: res.data.id };
}
