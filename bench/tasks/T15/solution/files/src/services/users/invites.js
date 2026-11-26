import { request } from '../../lib/http.js';
import { API, DEFAULT_TIMEOUT_S } from '../config.js';

export async function sendInvite(email, role = 'member') {
  const res = await request({
    method: 'POST',
    url: `${API}/invites`,
    headers: { 'content-type': 'application/json' },
    body: { email, role },
    timeoutMs: DEFAULT_TIMEOUT_S * 1000,
  });
  return res.body.id;
}
