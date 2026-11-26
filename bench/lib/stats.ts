import { Rng } from './rng.ts';

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

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

/**
 * pass^k of one task (Yao et al. 2024): the chance that k runs drawn without replacement from the n
 * observed runs all pass, C(c, k) / C(n, k) for c passes. k may not exceed n (there is no estimate of
 * k runs from fewer runs), so this throws instead of extrapolating.
 */
export function passHatK(passes: number, runs: number, k: number): number {
  if (!Number.isInteger(k) || k < 1 || k > runs) throw new RangeError(`pass^k needs 1 <= k <= runs (k ${k}, runs ${runs})`);
  if (passes < 0 || passes > runs) throw new RangeError(`passes ${passes} out of 0..${runs}`);
  return choose(passes, k) / choose(runs, k);
}

/** Linear-interpolation quantile (type 7) of a sorted array. */
function quantile(sorted: readonly number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (b - a) * (pos - lo);
}

export interface PairedTask {
  /** Per-run values of the reference arm on this task. */
  readonly a: readonly number[];
  /** Per-run values of the compared arm on this task. */
  readonly b: readonly number[];
}

export interface BootstrapCi {
  /** Mean over tasks of (mean of b - mean of a): the observed difference. */
  readonly estimate: number;
  readonly lo: number;
  readonly hi: number;
  /** Tasks in the comparison (each one a cluster). */
  readonly tasks: number;
  readonly iterations: number;
  readonly seed: number;
  /** True when the interval contains zero: the data do not show a difference. */
  readonly crossesZero: boolean;
}

/**
 * Paired cluster bootstrap over tasks, percentile 95% interval: each iteration draws as many tasks as
 * there are, with replacement, keeps all runs of both arms of each drawn task, and takes the mean over
 * the drawn tasks of the per-task difference of means (b - a). Every task weighs the same however many
 * runs it has. Null with fewer than 2 tasks (a single cluster has no spread to resample).
 */
export function pairedBootstrap(tasks: readonly PairedTask[], opts: { readonly seed: number; readonly iterations?: number }): BootstrapCi | null {
  const usable = tasks.filter((t) => t.a.length > 0 && t.b.length > 0);
  if (usable.length < 2) return null;
  const diffs = usable.map((t) => (mean(t.b) as number) - (mean(t.a) as number));
  const iterations = opts.iterations ?? 10_000;
  const rng = new Rng(opts.seed);
  const stats: number[] = [];
  for (let it = 0; it < iterations; it++) {
    let sum = 0;
    for (let i = 0; i < diffs.length; i++) sum += diffs[Math.floor(rng.next() * diffs.length)] as number;
    stats.push(sum / diffs.length);
  }
  stats.sort((x, y) => x - y);
  const lo = quantile(stats, 0.025);
  const hi = quantile(stats, 0.975);
  return { estimate: mean(diffs) as number, lo, hi, tasks: usable.length, iterations, seed: opts.seed, crossesZero: lo <= 0 && hi >= 0 };
}
