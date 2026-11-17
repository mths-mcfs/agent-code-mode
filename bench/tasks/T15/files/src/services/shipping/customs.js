import { legacyFetch } from '../../lib/legacy-http.js';
import { CARRIER } from '../config.js';

/** Files a customs declaration. `timeoutSeconds` overrides the default patience of 12 seconds. */
export async function declare(shipmentId, items, { timeoutSeconds } = {}) {
  const res = await legacyFetch(`${CARRIER}/customs/${shipmentId}`, {
    method: 'POST',
    json: { items },
    timeout: timeoutSeconds ?? 12,
    headers: { 'X-Request-Source': 'customs' },
  });
  return res.data.declarationId;
}
