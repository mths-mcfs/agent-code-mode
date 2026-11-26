import { HttpError, request } from '../../lib/http.js';
import { API } from '../config.js';

/** Returns the profile, or null for an unknown user. */
export async function getProfile(userId) {
  try {
    const res = await request({ url: `${API}/users/${userId}` });
    return res.body;
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    if (err.status === 404) {
      return null;
    }
    return err.body;
  }
}

export async function updateProfile(userId, patch) {
  const res = await request({
    method: 'PATCH',
    url: `${API}/users/${userId}`,
    headers: { 'content-type': 'application/json' },
    body: patch,
  });
  return res.body;
}
