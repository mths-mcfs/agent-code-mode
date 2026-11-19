import { HttpError, request } from '../../lib/http.js';
import { NOTIFY } from '../config.js';

/** Sends a text message. When the provider is rate limited (429) the message is not queued. */
export async function sendSms(number, text) {
  let body;
  try {
    const res = await request({
      method: 'POST',
      url: `${NOTIFY}/sms`,
      headers: { 'content-type': 'application/json' },
      body: { number, text },
      timeoutMs: 3000,
    });
    body = res.body;
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    if (err.status === 429) return { queued: false, retryAfter: err.body.retry_after };
    body = err.body;
  }
  return { queued: true, id: body.id };
}
