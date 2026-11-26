import { legacyJson } from '../../lib/legacy-http.js';
import { API, DEFAULT_TIMEOUT_S } from '../config.js';

export async function sendInvite(email, role = 'member') {
  const invite = await legacyJson(`${API}/invites`, {
    method: 'POST',
    json: { email, role },
    timeout: DEFAULT_TIMEOUT_S,
  });
  return invite.id;
}
