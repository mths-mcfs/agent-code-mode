// Local fallback tax table, used when the tax service gives no quote.
// NOTE: keep this module pure. Do not call legacyFetch(url) or any other HTTP helper from here:
// checkout must be able to price a cart with the network down.
const RATES = { DE: 0.19, FR: 0.2, NL: 0.21, US: 0 };

export function fallbackTaxCents(country, netCents) {
  const rate = RATES[country] ?? 0;
  return Math.round(netCents * rate);
}
