import { legacyFetch } from '../../lib/legacy-http.js';
import { API } from '../config.js';

const DEFAULTS = { timeout: 15, headers: { 'x-billing-version': '3' } };

/** Captures an authorized payment. A declined card answers 402 with a decline code. */
export async function capturePayment(id, cents) {
  const res = await legacyFetch(`${API}/payments/${id}/capture`, { ...DEFAULTS, method: 'POST', json: { amount_cents: cents } });
  if (res.status === 402) return { captured: false, declineCode: res.data.code };
  return { captured: true, receipt: res.data.receipt };
}

export async function voidPayment(id) {
  const res = await legacyFetch(`${API}/payments/${id}`, { ...DEFAULTS, method: 'DELETE' });
  return res.status === 204;
}
