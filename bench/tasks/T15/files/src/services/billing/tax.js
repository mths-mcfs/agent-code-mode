import { legacyFetch as callTax } from '../../lib/legacy-http.js';
import { TAX } from '../config.js';

/**
 * Tax of a cart, in cents. The tax service is optional at checkout: when it does not answer 200
 * within 2.5 seconds' worth of patience the caller falls back to its own table, so this returns null.
 */
export async function quoteTax(cart) {
  const res = await callTax(`${TAX}/quote`, { method: 'POST', json: cart, timeout: 2.5 });
  if (res.status !== 200) return null;
  return res.data.tax_cents;
}
