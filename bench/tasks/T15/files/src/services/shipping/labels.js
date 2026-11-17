import { legacyJson } from '../../lib/legacy-http.js';
import { CARRIER } from '../config.js';

export async function createLabel(shipment, carrier = 'acme-post') {
  const label = await legacyJson(`${CARRIER}/labels`, {
    method: 'POST',
    json: { shipment: shipment.id, weight_g: shipment.weightGrams },
    headers: { 'x-carrier': carrier },
  });
  return { labelId: label.id, url: label.pdf };
}
