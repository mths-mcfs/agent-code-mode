import { request } from '../../lib/http.js';
import { CARRIER } from '../config.js';

export async function listZones() {
  return (await request({ url: `${CARRIER}/zones` })).body;
}

export async function zoneFor(zip, country = 'US') {
  const match = (await request({ url: `${CARRIER}/zones/lookup`, query: { zip, country }, timeoutMs: 1500 })).body;
  return match.zone;
}
