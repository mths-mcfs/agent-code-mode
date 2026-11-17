import { HttpError, request } from '../../lib/http.js';
import { CARRIER } from '../config.js';

export async function schedulePickup(addressId, date) {
  const res = await request({
    method: 'POST',
    url: `${CARRIER}/pickups`,
    headers: { 'content-type': 'application/json' },
    body: { address: addressId, date },
  });
  return res.body.pickupId;
}

/** Returns true when the pickup was cancelled, false when it was not (unknown id, already done). */
export async function cancelPickup(pickupId) {
  try {
    const res = await request({ method: 'DELETE', url: `${CARRIER}/pickups/${pickupId}` });
    return res.status === 204;
  } catch (err) {
    if (err instanceof HttpError) return false;
    throw err;
  }
}
