import { legacyFetch } from '../../lib/legacy-http.js';
import { CARRIER } from '../config.js';

export async function schedulePickup(addressId, date) {
  const res = await legacyFetch(`${CARRIER}/pickups`, { method: 'POST', json: { address: addressId, date } });
  return res.data.pickupId;
}

/** Returns true when the pickup was cancelled, false when it was not (unknown id, already done). */
export async function cancelPickup(pickupId) {
  const res = await legacyFetch(`${CARRIER}/pickups/${pickupId}`, { method: 'DELETE' });
  return res.status === 204;
}
