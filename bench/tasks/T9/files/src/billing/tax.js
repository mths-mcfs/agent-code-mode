/** Sales tax by region, in basis points (1/100 of a percent). */
const RATES_BP = { domestic: 800, nearby: 1000, international: 0 };

export function taxRateBp(region) {
  const rate = RATES_BP[region];
  if (rate === undefined) throw new Error(`unknown region: ${region}`);
  return rate;
}

/** Tax on a subtotal, rounded half up to the cent (integer arithmetic, no float drift). */
export function taxCents(subtotalCents, region) {
  return Math.floor((subtotalCents * taxRateBp(region) + 5000) / 10000);
}
