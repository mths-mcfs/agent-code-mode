import { legacyFetch } from '../../lib/legacy-http.js';
import { API } from '../config.js';

/** Returns the profile, or null for an unknown user. */
export async function getProfile(userId) {
  const res = await legacyFetch(`${API}/users/${userId}`);
  if (res.status === 404) {
    return null;
  }
  return res.data;
}

export async function updateProfile(userId, patch) {
  const res = await legacyFetch(`${API}/users/${userId}`, { method: 'PATCH', json: patch });
  return res.data;
}
