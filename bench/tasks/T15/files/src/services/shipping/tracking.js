import * as legacy from '../../lib/legacy-http.js';
import { CARRIER } from '../config.js';

/** Tracking state of a parcel. An unknown code answers 404. */
export async function track(code) {
  const res = await legacy.legacyFetch(`${CARRIER}/tracking/${code}`, { qs: { events: 'last' } });
  if (res.status === 404) return { found: false };
  return { found: true, state: res.data.state };
}
