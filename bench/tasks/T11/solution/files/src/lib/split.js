/**
 * Splits an amount of cents into integer shares proportional to weights (see the task for the rules).
 * BigInt arithmetic keeps it exact for every safe-integer total.
 */
export function splitCents(totalCents, weights) {
  if (weights !== null && typeof weights === 'object' && !Array.isArray(weights)) {
    const keys = Object.keys(weights);
    if (keys.length === 0) throw new RangeError('weights must not be empty');
    const shares = splitCents(totalCents, keys.map((k) => weights[k]));
    return Object.fromEntries(keys.map((k, i) => [k, shares[i]]));
  }
  if (!Number.isSafeInteger(totalCents)) throw new RangeError('totalCents must be a safe integer');
  if (!Array.isArray(weights) || weights.length === 0) throw new RangeError('weights must be a non-empty array');
  for (const w of weights) if (!Number.isSafeInteger(w) || w < 0) throw new RangeError('weights must be non-negative safe integers');
  const sum = weights.reduce((s, w) => s + BigInt(w), 0n);
  if (sum === 0n) {
    if (totalCents !== 0) throw new RangeError('cannot split a non-zero amount with all-zero weights');
    return weights.map(() => 0);
  }
  const abs = BigInt(Math.abs(totalCents));
  const shares = weights.map((w) => (abs * BigInt(w)) / sum);
  const rems = weights.map((w, i) => ({ i, rem: (abs * BigInt(w)) % sum }));
  let left = abs - shares.reduce((s, v) => s + v, 0n);
  rems.sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1));
  for (const { i } of rems) {
    if (left === 0n) break;
    shares[i] = (shares[i] ?? 0n) + 1n;
    left -= 1n;
  }
  const sign = totalCents < 0 ? -1 : 1;
  return shares.map((s) => (s === 0n ? 0 : sign * Number(s)));
}
