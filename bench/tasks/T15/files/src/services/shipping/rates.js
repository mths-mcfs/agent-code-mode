import { legacyFetch } from '../../lib/legacy-http.js';
import { CARRIER } from '../config.js';

export async function getRates(destination, weightGrams) {
  const res = await legacyFetch(`${CARRIER}/rates`, {
    qs: { country: destination.country, zip: destination.zip, weight_g: weightGrams },
    timeout: 4,
  });
  return res.data.rates;
}
