export interface Spread {
  readonly median: number;
  readonly min: number;
  readonly max: number;
  readonly n: number;
}

export function spread(values: readonly number[]): Spread | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  return { median, min: sorted[0] as number, max: sorted[sorted.length - 1] as number, n: sorted.length };
}
