import { HttpError, request } from '../../lib/http.js';
import { API } from '../config.js';

const prefsUrl = (userId) => `${API}/users/${userId}/preferences`;

export async function getPreferences(userId) {
  return (await request({ url: prefsUrl(userId) })).body;
}

/** Returns true when the preference was stored (the service answers 204). */
export async function setPreference(userId, key, value) {
  try {
    const res = await request({
      method: 'PUT',
      url: `${prefsUrl(userId)}/${key}`,
      headers: { 'content-type': 'application/json' },
      body: { value },
    });
    return res.status === 204;
  } catch (err) {
    if (err instanceof HttpError) return false;
    throw err;
  }
}
