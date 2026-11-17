import { request } from '../../lib/http.js';
import { API } from '../config.js';

export async function getBalance(customerId, currency = 'USD') {
  const res = await request({
    url: `${API}/credits/${customerId}`,
    query: { currency },
    headers: { 'Cache-Control': 'no-cache' },
  });
  return res.body.balance_cents;
}
