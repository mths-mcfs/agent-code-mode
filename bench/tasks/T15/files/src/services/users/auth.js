import { legacyFetch as post } from '../../lib/legacy-http.js';
import { AUTH } from '../config.js';

/** Signs a user in. Wrong credentials answer 401. */
export async function login(email, password) {
  const res = await post(`${AUTH}/login`, { method: 'POST', json: { email, password }, timeout: 5 });
  if (res.status === 401) return { ok: false };
  return { ok: true, token: res.data.token };
}
