import { HttpError, request } from '../../lib/http.js';
import { API } from '../config.js';

/**
 * Sends a payment reminder for an invoice. `method` is 'post' for a new reminder and 'put' to
 * replace the one already scheduled. Returns the HTTP status of the reminder service.
 */
export async function sendReminder(invoiceId, { channel = 'email', method = 'post' } = {}) {
  try {
    const res = await request({
      method: String(method).toUpperCase(),
      url: `${API}/invoices/${invoiceId}/reminders`,
      headers: { 'content-type': 'application/json' },
      body: { channel },
    });
    return res.status;
  } catch (err) {
    if (err instanceof HttpError) return err.status;
    throw err;
  }
}
