import { request } from '../../lib/http.js';
import { CARRIER } from '../config.js';

/** Files a customs declaration. `timeoutSeconds` overrides the default patience of 12 seconds. */
export async function declare(shipmentId, items, { timeoutSeconds } = {}) {
  const res = await request({
    method: 'POST',
    url: `${CARRIER}/customs/${shipmentId}`,
    body: { items },
    timeoutMs: (timeoutSeconds ?? 12) * 1000,
    headers: { 'X-Request-Source': 'customs', 'content-type': 'application/json' },
  });
  return res.body.declarationId;
}
