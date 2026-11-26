import { HttpError, request } from '../../lib/http.js';
import { AUTH } from '../config.js';

/** Signs a user in. Wrong credentials answer 401. */
export async function login(email, password) {
  let body;
  try {
    const res = await request({
      method: 'POST',
      url: `${AUTH}/login`,
      headers: { 'content-type': 'application/json' },
      body: { email, password },
      timeoutMs: 5000,
    });
    body = res.body;
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    if (err.status === 401) return { ok: false };
    body = err.body;
  }
  return { ok: true, token: body.token };
}
