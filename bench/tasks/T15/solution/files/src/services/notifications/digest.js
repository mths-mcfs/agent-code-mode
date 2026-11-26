import { request } from '../../lib/http.js';
import { API, NOTIFY } from '../config.js';

/** Builds the activity digest of a user: what happened since the last digest was sent. */
export async function buildDigest(userId) {
  const prefs = (await request({ url: `${NOTIFY}/digest/${userId}/settings` })).body;
  const res = await request({ url: `${API}/activity`, query: { user: userId, since: prefs.lastDigestAt }, timeoutMs: 6000 });
  return { locale: prefs.locale, events: res.body.events };
}
