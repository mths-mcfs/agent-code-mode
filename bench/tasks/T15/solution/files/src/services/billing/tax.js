import { HttpError, request } from '../../lib/http.js';
import { TAX } from '../config.js';

/**
 * Tax of a cart, in cents. The tax service is optional at checkout: when it does not answer 200
 * within 2.5 seconds' worth of patience the caller falls back to its own table, so this returns null.
 */
export async function quoteTax(cart) {
  try {
    const res = await request({
      method: 'POST',
      url: `${TAX}/quote`,
      headers: { 'content-type': 'application/json' },
      body: cart,
      timeoutMs: 2500,
    });
    if (res.status !== 200) return null;
    return res.body.tax_cents;
  } catch (err) {
    if (err instanceof HttpError) return null;
    throw err;
  }
}
