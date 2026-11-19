import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ARM_LABELS, RunRecordSchema, type RunRecord } from './lib/record.ts';
import { spread, type Spread } from './lib/stats.ts';

/** Aggregates run records into `summary.json` and a Markdown table snippet for the README. */

export interface GroupSummary {
  readonly host: 'claude' | 'codex';
  readonly task: string;
  readonly arm: string;
  readonly armLabel: string;
  /** Runs with different configs are never pooled: each config is its own group. */
  readonly configHash: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly runs: number;
  readonly validRuns: number;
  readonly invalidRuns: number;
  readonly invalidReasons: readonly string[];
  /** Over valid runs. Null when there is no valid run. */
  readonly passRate: number | null;
  /** Over all runs (a fallback in a strict arm makes the run invalid, so it would never show over valid runs). */
  readonly fallbackRate: number | null;
  readonly turns: Spread | null;
  readonly inputTokens: Spread | null;
  readonly outputTokens: Spread | null;
  readonly cacheCreationTokens: Spread | null;
  readonly cacheReadTokens: Spread | null;
  readonly costUsd: Spread | null;
  readonly wallMs: Spread | null;
  /** Run ids behind the numbers, so each one traces to its record and transcript. */
  readonly runIds: readonly string[];
}

export interface Summary {
  readonly generatedAt: string;
  readonly dryRun: boolean;
  readonly environment: unknown;
  readonly groups: readonly GroupSummary[];
}

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

export function summarize(records: readonly RunRecord[]): GroupSummary[] {
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
      passRate: valid.length === 0 ? null : valid.filter((r) => r.verify.pass).length / valid.length,
      fallbackRate: runs.length === 0 ? null : runs.filter((r) => r.fallback).length / runs.length,
      turns: nums((r) => r.parsed?.turns),
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

function fmt(s: Spread | null, unit: (v: number) => string): string {
  if (s === null) return '–';
  return s.n === 1 || s.min === s.max ? unit(s.median) : `${unit(s.median)} (${unit(s.min)}–${unit(s.max)})`;
}

const int = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(1));
const usd = (v: number): string => `$${v.toFixed(4)}`;
const secs = (v: number): string => `${(v / 1000).toFixed(1)}s`;
const pct = (v: number | null): string => (v === null ? '–' : `${Math.round(v * 100)}%`);

const EnvSchema = z.object({ invocations: z.array(z.record(z.string(), z.unknown())) }).passthrough();

export function markdownTable(summary: Summary): string {
  const lines: string[] = [];
  if (summary.dryRun) lines.push('> DRY RUN: canned transcripts and reference solutions, not model results.', '');
  lines.push('Median (min–max) over valid runs. Input is uncached input tokens; Codex output includes reasoning tokens.', '');
  const keys = summary.groups.map((g) => `${g.host}|${g.task}|${g.arm}`);
  if (new Set(keys).size !== keys.length) {
    lines.push('> Some host/task/arm rows appear more than once: those runs used different configs (see Config) and are reported separately, never pooled.', '');
  }
  lines.push('| Host | Task | Arm | Config | Pass | Turns | Input | Output | Cache write | Cache read | Cost | Wall | Fallback | Valid/runs |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const g of summary.groups) {
    lines.push(
      `| ${g.host} | ${g.task} | ${g.arm} ${g.armLabel} | ${g.configHash} | ${pct(g.passRate)} | ${fmt(g.turns, int)} | ${fmt(g.inputTokens, int)} | ${fmt(g.outputTokens, int)} | ${fmt(g.cacheCreationTokens, int)} | ${fmt(g.cacheReadTokens, int)} | ${fmt(g.costUsd, usd)} | ${fmt(g.wallMs, secs)} | ${pct(g.fallbackRate)} | ${g.validRuns}/${g.runs} |`,
    );
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

/** Reads every record under `resultsDir`, writes `summary.json` and `summary.md` there, returns both. */
export async function writeReport(resultsDir: string, now: Date = new Date()): Promise<{ summary: Summary; markdown: string }> {
  const records = await loadRecords(resultsDir);
  const summary: Summary = {
    generatedAt: now.toISOString(),
    dryRun: records.length > 0 && records.every((r) => r.dryRun),
    environment: await readEnvironment(resultsDir),
    groups: summarize(records),
  };
  const markdown = markdownTable(summary);
  await writeFile(path.join(resultsDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(path.join(resultsDir, 'summary.md'), markdown);
  return { summary, markdown };
}

/** The newest `YYYY-MM-DD` directory under `root`, or undefined. */
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

// `npm run bench:report [-- <results/date dir>]`: without a dir, the newest date under bench/results.
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
