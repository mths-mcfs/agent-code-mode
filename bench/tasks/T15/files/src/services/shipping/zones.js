import { legacyJson as loadJson } from '../../lib/legacy-http.js';
import { CARRIER } from '../config.js';

export function listZones() {
  return loadJson(`${CARRIER}/zones`);
}

export async function zoneFor(zip, country = 'US') {
  const match = await loadJson(`${CARRIER}/zones/lookup`, { qs: { zip, country }, timeout: 1.5 });
  return match.zone;
}
