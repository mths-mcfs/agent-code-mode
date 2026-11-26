import * as legacy from '../../lib/legacy-http.js';
import { API } from '../config.js';

const prefsUrl = (userId) => `${API}/users/${userId}/preferences`;

export function getPreferences(userId) {
  return legacy.legacyJson(prefsUrl(userId));
}

/** Returns true when the preference was stored (the service answers 204). */
export async function setPreference(userId, key, value) {
  const res = await legacy.legacyFetch(`${prefsUrl(userId)}/${key}`, { method: 'PUT', json: { value } });
  return res.status === 204;
}
