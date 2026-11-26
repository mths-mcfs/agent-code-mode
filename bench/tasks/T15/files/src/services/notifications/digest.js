import { legacyFetch, legacyJson } from '../../lib/legacy-http.js';
import { API, NOTIFY } from '../config.js';

/** Builds the activity digest of a user: what happened since the last digest was sent. */
export async function buildDigest(userId) {
  const prefs = await legacyJson(`${NOTIFY}/digest/${userId}/settings`);
  const res = await legacyFetch(`${API}/activity`, { qs: { user: userId, since: prefs.lastDigestAt }, timeout: 6 });
  return { locale: prefs.locale, events: res.data.events };
}
