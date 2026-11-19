import { legacyJson } from '../../lib/legacy-http.js';
import { API } from '../config.js';

export async function getBalance(customerId, currency = 'USD') {
  const account = await legacyJson(`${API}/credits/${customerId}`, {
    qs: { currency },
    headers: { 'Cache-Control': 'no-cache' },
  });
  return account.balance_cents;
}
