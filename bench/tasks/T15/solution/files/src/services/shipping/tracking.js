import { HttpError, request } from '../../lib/http.js';
import { CARRIER } from '../config.js';

/** Tracking state of a parcel. An unknown code answers 404. */
export async function track(code) {
  let body;
  try {
    const res = await request({ url: `${CARRIER}/tracking/${code}`, query: { events: 'last' } });
    body = res.body;
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    if (err.status === 404) return { found: false };
    body = err.body;
  }
  return { found: true, state: body.state };
}
