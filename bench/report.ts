import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ARM_LABELS, RunRecordSchema, type RunRecord } from './lib/record.ts';
import { mean, pairedBootstrap, passHatK, spread, type BootstrapCi, type Spread } from './lib/stats.ts';


export interface GroupSummary {
  readonly host: 'claude' | 'codex';
  readonly task: string;
  readonly arm: string;
  readonly armLabel: string;
  readonly configHash: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly runs: number;
  readonly validRuns: number;
  readonly invalidRuns: number;
  readonly invalidReasons: readonly string[];
  readonly passRate: number | null;
  readonly passAll: number | null;
  readonly costPerSolvedUsd: number | null;
  readonly fallbackRate: number | null;
  /** Claude `num_turns` (tool-use rounds), Codex requests. */
  readonly turns: Spread | null;
  /** Model requests counted from usage events. */
  readonly requests: Spread | null;
  readonly inputTokens: Spread | null;
  readonly outputTokens: Spread | null;
  readonly cacheCreationTokens: Spread | null;
  readonly cacheReadTokens: Spread | null;
  readonly costUsd: Spread | null;
  readonly wallMs: Spread | null;
  readonly runIds: readonly string[];
}

/** One arm over every task of a cohort (runs that differ only in task and arm). */
export interface ArmSummary {
  readonly host: 'claude' | 'codex';
  readonly cohort: string;
  /** The arm, with its build for a baseline arm (`B0@ref:<commit>`): runs of two baseline builds are never pooled. */
  readonly arm: string;
  readonly armLabel: string;
  readonly tasks: number;
  readonly validRuns: number;
  readonly runs: number;
  /** Mean over tasks of the per-task pass rate (every task weighs the same). */
  readonly pass1: number | null;
  /** Mean over tasks of the per-task pass^k estimate C(c, k) / C(n, k); k is the same for every arm of the cohort. */
  readonly passHatK: { readonly k: number; readonly value: number } | null;
  /** Mean over tasks of the per-task mean cost per run. */
  readonly costPerRunUsd: number | null;
  /** All valid runs' cost (failed ones included) over the passing runs. */
  readonly costPerSolvedUsd: number | null;
  readonly requests: Spread | null;
  readonly turns: Spread | null;
}

/** Difference `arm - reference` over the tasks both have, with paired cluster-bootstrap 95% intervals. */
export interface Comparison {
  readonly host: 'claude' | 'codex';
  readonly cohort: string;
  readonly arm: string;
  readonly reference: string;
  readonly tasks: readonly string[];
  /** Difference in pass rate (fraction, b - a). */
  readonly pass: BootstrapCi | null;
  /** Difference in mean cost per run (USD, b - a). */
  readonly costUsd: BootstrapCi | null;
}

export interface Summary {
  readonly generatedAt: string;
  readonly dryRun: boolean;
  readonly environment: unknown;
  readonly groups: readonly GroupSummary[];
  readonly arms: readonly ArmSummary[];
  readonly comparisons: readonly Comparison[];
  readonly bootstrap: { readonly seed: number; readonly iterations: number; readonly method: string };
  /** Warmup runs: listed, never in a statistic. */
  readonly warmup: { readonly runs: number; readonly costUsd: number; readonly runIds: readonly string[] };
}

export const BOOTSTRAP_SEED = 20261116;
export const BOOTSTRAP_ITERATIONS = 10_000;

async function findRecords(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await findRecords(p)));
    else if (e.name === 'record.json') out.push(p);
  }
  return out.sort();
}

export async function loadRecords(resultsDir: string): Promise<RunRecord[]> {
  const records: RunRecord[] = [];
  for (const file of await findRecords(resultsDir)) {
    const parsed = RunRecordSchema.safeParse(JSON.parse(await readFile(file, 'utf8')));
    if (!parsed.success) throw new Error(`invalid record ${file}: ${parsed.error.message}`);
    records.push(parsed.data);
  }
  return records;
}

const HOST_ORDER = ['claude', 'codex'];

export function summarize(all: readonly RunRecord[]): GroupSummary[] {
  const records = all.filter((r) => !r.warmup);
  const groups = new Map<string, { host: RunRecord['host']; task: string; arm: string; configHash: string; config: Record<string, unknown>; runs: RunRecord[] }>();
  for (const r of records) {
    const key = `${r.host}|${r.task}|${r.arm}|${r.configHash}`;
    const group = groups.get(key) ?? { host: r.host, task: r.task, arm: r.arm, configHash: r.configHash, config: r.config, runs: [] };
    group.runs.push(r);
    groups.set(key, group);
  }
  const out: GroupSummary[] = [];
  for (const { host, task, arm, configHash, config, runs } of groups.values()) {
    const valid = runs.filter((r) => r.valid);
    const nums = (pick: (r: RunRecord) => number | null | undefined): Spread | null =>
      spread(valid.map(pick).filter((v): v is number => typeof v === 'number'));
    const passes = valid.filter((r) => r.verify.pass).length;
    out.push({
      host,
      task,
      arm,
      armLabel: ARM_LABELS[host][arm] ?? arm,
      configHash,
      config,
      runs: runs.length,
      validRuns: valid.length,
      invalidRuns: runs.length - valid.length,
      invalidReasons: [...new Set(runs.flatMap((r) => r.invalidReasons))],
      passRate: valid.length === 0 ? null : passes / valid.length,
      passAll: valid.length === 0 ? null : passHatK(passes, valid.length, valid.length),
      costPerSolvedUsd: costPerSolved(valid),
      fallbackRate: runs.length === 0 ? null : runs.filter((r) => r.fallback).length / runs.length,
      turns: nums((r) => r.parsed?.turns),
      requests: nums((r) => r.parsed?.requests),
      inputTokens: nums((r) => r.parsed?.usage?.input),
      outputTokens: nums((r) => r.parsed?.usage?.output),
      cacheCreationTokens: nums((r) => r.parsed?.usage?.cacheCreation),
      cacheReadTokens: nums((r) => r.parsed?.usage?.cacheRead),
      costUsd: nums((r) => r.costUsd),
      wallMs: nums((r) => r.wallMs),
      runIds: runs.map((r) => r.id).sort(),
    });
  }
  return out.sort((a, b) => HOST_ORDER.indexOf(a.host) - HOST_ORDER.indexOf(b.host) || a.task.localeCompare(b.task) || a.arm.localeCompare(b.arm) || a.configHash.localeCompare(b.configHash));
}

function costPerSolved(valid: readonly RunRecord[]): number | null {
  const passes = valid.filter((r) => r.verify.pass).length;
  if (passes === 0 || valid.some((r) => r.costUsd === null)) return null;
  return valid.reduce((sum, r) => sum + (r.costUsd ?? 0), 0) / passes;
}

/** Config keys that differ between the cells of one comparison (task and arm); the rest must match. */
const CELL_KEYS = new Set(['task', 'arm', 'armDefinitionSha256', 'promptSha256', 'taskTreeSha256', 'acmBuild']);

/** Runs share a cohort when their configs differ only in task and arm. */
export function cohortKey(r: RunRecord): string {
  const rest = Object.fromEntries(Object.entries(r.config).filter(([k]) => !CELL_KEYS.has(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return createHash('sha256').update(`${r.host}|${JSON.stringify(rest)}`).digest('hex').slice(0, 8);
}

/**
 * The column a run is counted in: its arm, with the build for a baseline arm (`B0@ref:<commit>`). The build
 * is out of the cohort key, so B and B0 stay comparable, but two baseline builds are two different arms.
 */
function cellArm(r: RunRecord): string {
  const build = r.config['acmBuild'];
  return (r.arm === 'B0' || r.arm === 'C0') && typeof build === 'string' ? `${r.arm}@${build}` : r.arm;
}

const armLabel = (host: RunRecord['host'], cell: string): string => ARM_LABELS[host][cell.split('@')[0] ?? cell] ?? cell;

type Cells = Map<string, Map<string, RunRecord[]>>; // cellArm -> task -> valid runs

function cohorts(records: readonly RunRecord[]): Map<string, { host: RunRecord['host']; cells: Cells }> {
  const out = new Map<string, { host: RunRecord['host']; cells: Cells }>();
  for (const r of records) {
    if (r.warmup || !r.valid) continue;
    const key = cohortKey(r);
    const c = out.get(key) ?? { host: r.host, cells: new Map() };
    const byTask = c.cells.get(cellArm(r)) ?? new Map<string, RunRecord[]>();
    byTask.set(r.task, [...(byTask.get(r.task) ?? []), r]);
    c.cells.set(cellArm(r), byTask);
    out.set(key, c);
  }
  return out;
}

/** Per-arm aggregates over the tasks of each cohort. */
export function summarizeArms(records: readonly RunRecord[]): ArmSummary[] {
  const out: ArmSummary[] = [];
  const all = records.filter((r) => !r.warmup);
  for (const [cohort, { host, cells }] of cohorts(records)) {
    // One k for the whole cohort: the fewest valid runs of any cell, so no arm is scored on more runs than it has.
    const k = Math.min(...[...cells.values()].flatMap((t) => [...t.values()].map((runs) => runs.length)));
    for (const [arm, byTask] of [...cells.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const tasks = [...byTask.values()];
      const valid = tasks.flat();
      const passOf = (runs: readonly RunRecord[]): number => runs.filter((r) => r.verify.pass).length;
      const costs = tasks.map((runs) => runs.map((r) => r.costUsd)).filter((c): c is number[] => c.every((v) => v !== null));
      out.push({
        host,
        cohort,
        arm,
        armLabel: armLabel(host, arm),
        tasks: tasks.length,
        validRuns: valid.length,
        runs: all.filter((r) => cellArm(r) === arm && cohortKey(r) === cohort).length,
        pass1: mean(tasks.map((runs) => passOf(runs) / runs.length)),
        passHatK: k >= 1 ? { k, value: mean(tasks.map((runs) => passHatK(passOf(runs), runs.length, k))) as number } : null,
        costPerRunUsd: costs.length === tasks.length ? mean(costs.map((c) => mean(c) as number)) : null,
        costPerSolvedUsd: costPerSolved(valid),
        requests: spread(valid.map((r) => r.parsed?.requests).filter((v): v is number => typeof v === 'number')),
        turns: spread(valid.map((r) => r.parsed?.turns).filter((v): v is number => typeof v === 'number')),
      });
    }
  }
  return out.sort((a, b) => HOST_ORDER.indexOf(a.host) - HOST_ORDER.indexOf(b.host) || a.cohort.localeCompare(b.cohort) || a.arm.localeCompare(b.arm));
}

/** The pairs compared: every arm against the native arm A, and each baseline build against its current arm. */
function comparedPairs(arms: readonly string[]): [string, string][] {
  const pairs: [string, string][] = [];
  if (arms.includes('A')) for (const a of arms) if (a !== 'A') pairs.push([a, 'A']);
  for (const [cur, base] of [['B', 'B0'], ['C', 'C0']] as const) {
    if (arms.includes(cur)) for (const a of arms) if (a === base || a.startsWith(`${base}@`)) pairs.push([cur, a]);
  }
  return pairs;
}

export function compareArms(records: readonly RunRecord[], seed = BOOTSTRAP_SEED, iterations = BOOTSTRAP_ITERATIONS): Comparison[] {
  const out: Comparison[] = [];
  for (const [cohort, { host, cells }] of cohorts(records)) {
    for (const [arm, reference] of comparedPairs([...cells.keys()].sort())) {
      const a = cells.get(reference) ?? new Map<string, RunRecord[]>();
      const b = cells.get(arm) ?? new Map<string, RunRecord[]>();
      const tasks = [...a.keys()].filter((t) => b.has(t)).sort();
      const pairsOf = (pick: (r: RunRecord) => number | null) =>
        tasks.map((t) => ({ a: (a.get(t) ?? []).map(pick), b: (b.get(t) ?? []).map(pick) })).filter((p) => p.a.every((v) => v !== null) && p.b.every((v) => v !== null)) as { a: number[]; b: number[] }[];
      const passPairs = pairsOf((r) => (r.verify.pass ? 1 : 0));
      const costPairs = pairsOf((r) => r.costUsd);
      out.push({
        host,
        cohort,
        arm,
        reference,
        tasks,
        pass: pairedBootstrap(passPairs, { seed, iterations }),
        // Every task needs a cost on both sides, or the cost interval would cover a different task set.
        costUsd: costPairs.length === tasks.length ? pairedBootstrap(costPairs, { seed, iterations }) : null,
      });
    }
  }
  return out;
}

function fmt(s: Spread | null, unit: (v: number) => string): string {
  if (s === null) return '–';
  return s.n === 1 || s.min === s.max ? unit(s.median) : `${unit(s.median)} (${unit(s.min)}–${unit(s.max)})`;
}

const int = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(1));
const usd = (v: number): string => `$${v.toFixed(4)}`;
const secs = (v: number): string => `${(v / 1000).toFixed(1)}s`;
const pct = (v: number | null): string => (v === null ? '–' : `${Math.round(v * 100)}%`);
const usdOrDash = (v: number | null): string => (v === null ? '–' : usd(v));
const signed = (v: number, unit: (x: number) => string): string => `${v >= 0 ? '+' : '-'}${unit(Math.abs(v))}`;
const pp = (v: number): string => `${(v * 100).toFixed(1)} pp`;

function ciCell(ci: BootstrapCi | null, unit: (x: number) => string): string {
  if (ci === null) return '– (needs 2+ tasks)';
  const text = `${signed(ci.estimate, unit)} [${signed(ci.lo, unit)}, ${signed(ci.hi, unit)}]`;
  return ci.crossesZero ? `${text} **CI crosses 0: no difference shown**` : text;
}

const EnvSchema = z.object({ invocations: z.array(z.record(z.string(), z.unknown())) }).passthrough();

export function markdownTable(summary: Summary): string {
  const lines: string[] = [];
  if (summary.dryRun) lines.push('> DRY RUN: canned transcripts and reference solutions, not model results.', '');
  lines.push('Median (min–max) over valid runs. Input is uncached input tokens; Codex output includes reasoning tokens.', '');
  const keys = summary.groups.map((g) => `${g.host}|${g.task}|${g.arm}`);
  if (new Set(keys).size !== keys.length) {
    lines.push('> Some host/task/arm rows appear more than once: those runs used different configs (see Config) and are reported separately, never pooled.', '');
  }
  lines.push('Requests are model requests counted from usage events; num_turns is the host counter (Claude counts tool-use rounds, so parallel tool calls inflate it). pass^n: every valid run of the cell passed. Cost/solved: cost of all valid runs, failed ones included, over the passing runs.', '');
  lines.push('| Host | Task | Arm | Config | Pass@1 | Pass^n | Requests | num_turns | Input | Output | Cache write | Cache read | Cost | Cost/solved | Wall | Fallback | Valid/runs |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const g of summary.groups) {
    lines.push(
      `| ${g.host} | ${g.task} | ${g.arm} ${g.armLabel} | ${g.configHash} | ${pct(g.passRate)} | ${pct(g.passAll)} | ${fmt(g.requests, int)} | ${fmt(g.turns, int)} | ${fmt(g.inputTokens, int)} | ${fmt(g.outputTokens, int)} | ${fmt(g.cacheCreationTokens, int)} | ${fmt(g.cacheReadTokens, int)} | ${fmt(g.costUsd, usd)} | ${usdOrDash(g.costPerSolvedUsd)} | ${fmt(g.wallMs, secs)} | ${pct(g.fallbackRate)} | ${g.validRuns}/${g.runs} |`,
    );
  }
  if (summary.arms.length > 0) {
    lines.push('', '### Arms over all tasks', '', 'Cohort: runs whose configs differ only in task and arm. Pass@1 and cost/run are means over tasks (each task weighs the same); pass^k uses one k per cohort, the fewest valid runs of any cell, never more than the runs made.', '');
    lines.push('| Host | Cohort | Arm | Tasks | Pass@1 | Pass^k | Cost/run | Cost/solved | Requests | num_turns | Valid/runs |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
    for (const a of summary.arms) {
      lines.push(
        `| ${a.host} | ${a.cohort} | ${a.arm} ${a.armLabel} | ${a.tasks} | ${pct(a.pass1)} | ${a.passHatK === null ? '–' : `${pct(a.passHatK.value)} (k=${a.passHatK.k})`} | ${usdOrDash(a.costPerRunUsd)} | ${usdOrDash(a.costPerSolvedUsd)} | ${fmt(a.requests, int)} | ${fmt(a.turns, int)} | ${a.validRuns}/${a.runs} |`,
      );
    }
  }
  if (summary.comparisons.length > 0) {
    lines.push('', '### Comparisons', '', `Arm minus reference over the tasks both ran: estimate [95% CI], paired cluster bootstrap over tasks (${summary.bootstrap.iterations} resamples, seed ${summary.bootstrap.seed}). An interval that crosses 0 does not show a difference.`, '');
    lines.push('| Host | Cohort | Arm vs reference | Tasks | Δ pass@1 | Δ cost/run |');
    lines.push('|---|---|---|---|---|---|');
    for (const c of summary.comparisons) {
      lines.push(`| ${c.host} | ${c.cohort} | ${c.arm} vs ${c.reference} | ${c.tasks.length} | ${ciCell(c.pass, pp)} | ${ciCell(c.costUsd, usd)} |`);
    }
  }
  if (summary.warmup.runs > 0) {
    lines.push('', `Warmup: ${summary.warmup.runs} run(s), ${usd(summary.warmup.costUsd)}, kept under warmup/ and out of every number above.`);
  }
  const env = EnvSchema.safeParse(summary.environment);
  if (env.success && env.data.invocations.length > 0) {
    lines.push('', '<details><summary>Environment</summary>', '', '```json', JSON.stringify(env.data.invocations, null, 2), '```', '', '</details>');
  }
  return `${lines.join('\n')}\n`;
}

async function readEnvironment(resultsDir: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path.join(resultsDir, 'env.json'), 'utf8'));
  } catch {
    return null;
  }
}

export async function writeReport(resultsDir: string, now: Date = new Date()): Promise<{ summary: Summary; markdown: string }> {
  const records = await loadRecords(resultsDir);
  const warm = records.filter((r) => r.warmup);
  const summary: Summary = {
    generatedAt: now.toISOString(),
    dryRun: records.length > 0 && records.every((r) => r.dryRun),
    environment: await readEnvironment(resultsDir),
    groups: summarize(records),
    arms: summarizeArms(records),
    comparisons: compareArms(records),
    bootstrap: { seed: BOOTSTRAP_SEED, iterations: BOOTSTRAP_ITERATIONS, method: 'paired cluster bootstrap over tasks, percentile 95% interval of the mean per-task difference' },
    warmup: { runs: warm.length, costUsd: warm.reduce((s, r) => s + (r.costUsd ?? 0), 0), runIds: warm.map((r) => r.id).sort() },
  };
  const markdown = markdownTable(summary);
  await writeFile(path.join(resultsDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(path.join(resultsDir, 'summary.md'), markdown);
  return { summary, markdown };
}

export async function latestResultsDir(root: string): Promise<string | undefined> {
  let names: string[] = [];
  try {
    names = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name)).map((e) => e.name);
  } catch {
    return undefined;
  }
  const last = names.sort().at(-1);
  return last === undefined ? undefined : path.join(root, last);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename) {
  const dir = process.argv[2] ?? (await latestResultsDir(path.join(import.meta.dirname, 'results')));
  if (dir === undefined) {
    process.stderr.write('usage: npm run bench:report -- <bench/results/YYYY-MM-DD> (no results found under bench/results)\n');
    process.exitCode = 2;
  } else {
    const { markdown } = await writeReport(path.resolve(dir));
    process.stdout.write(markdown);
  }
}
