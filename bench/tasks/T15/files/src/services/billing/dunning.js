import { legacyFetch } from '../../lib/legacy-http.js';
import { API } from '../config.js';

/**
 * Sends a payment reminder for an invoice. `method` is 'post' for a new reminder and 'put' to
 * replace the one already scheduled. Returns the HTTP status of the reminder service.
 */
export async function sendReminder(invoiceId, { channel = 'email', method = 'post' } = {}) {
  const res = await legacyFetch(`${API}/invoices/${invoiceId}/reminders`, { method, json: { channel } });
  return res.status;
}
