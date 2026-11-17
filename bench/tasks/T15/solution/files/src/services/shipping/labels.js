import { request } from '../../lib/http.js';
import { CARRIER } from '../config.js';

export async function createLabel(shipment, carrier = 'acme-post') {
  const res = await request({
    method: 'POST',
    url: `${CARRIER}/labels`,
    body: { shipment: shipment.id, weight_g: shipment.weightGrams },
    headers: { 'x-carrier': carrier, 'content-type': 'application/json' },
  });
  const label = res.body;
  return { labelId: label.id, url: label.pdf };
}
