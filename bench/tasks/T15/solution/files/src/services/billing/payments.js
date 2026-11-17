import { HttpError, request } from '../../lib/http.js';
import { API } from '../config.js';

const DEFAULTS = { timeoutMs: 15000, headers: { 'x-billing-version': '3' } };

/** Captures an authorized payment. A declined card answers 402 with a decline code. */
export async function capturePayment(id, cents) {
  let body;
  try {
    const res = await request({
      ...DEFAULTS,
      method: 'POST',
      url: `${API}/payments/${id}/capture`,
      headers: { ...DEFAULTS.headers, 'content-type': 'application/json' },
      body: { amount_cents: cents },
    });
    body = res.body;
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    if (err.status === 402) return { captured: false, declineCode: err.body.code };
    body = err.body;
  }
  return { captured: true, receipt: body.receipt };
}

export async function voidPayment(id) {
  try {
    const res = await request({ ...DEFAULTS, method: 'DELETE', url: `${API}/payments/${id}` });
    return res.status === 204;
  } catch (err) {
    if (err instanceof HttpError) return false;
    throw err;
  }
}
