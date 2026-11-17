import { request } from '../../lib/http.js';
import { CARRIER } from '../config.js';

export async function getRates(destination, weightGrams) {
  const res = await request({
    url: `${CARRIER}/rates`,
    query: { country: destination.country, zip: destination.zip, weight_g: weightGrams },
    timeoutMs: 4000,
  });
  return res.body.rates;
}
