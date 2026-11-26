import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RunRecordSchema, type RunRecord } from '../lib/record.ts';
import { pairedBootstrap, passHatK, spread } from '../lib/stats.ts';
import { compareArms, latestResultsDir, markdownTable, summarize, summarizeArms, writeReport, type Summary } from '../report.ts';
import { Rng } from '../lib/rng.ts';

function record(over: Partial<RunRecord> & { turns?: number; cost?: number; pass?: boolean }): RunRecord {
  const { turns = 2, cost = 0.01, pass, ...rest } = over;
  return RunRecordSchema.parse({
    schema: 1,
    id: `claude-T1-A-r${rest.run ?? 1}`,
    configHash: 'aaaaaaaaaaaa',
    config: { model: 'claude-sonnet-5-5' },
    host: 'claude',
    arm: 'A',
    armLabel: 'native tools',
    task: 'T1',
    run: 1,
    round: 1,
    orderIndex: 0,
    dryRun: false,
    model: 'claude-sonnet-5-5',
    effort: 'medium',
    startedAt: '2026-11-15T00:00:00.000Z',
    exitCode: 0,
    timedOut: false,
    wallMs: 1000 * turns,
    parsed: {
      turns,
      requests: turns,
      hostDurationMs: 100,
      usage: { input: 10 * turns, output: turns, cacheCreation: 0, cacheRead: 100, reasoning: null },
      hostCostUsd: cost,
      model: 'claude-sonnet-5-5',
      finalAnswer: 'ANSWER: 7',
      toolCalls: { native: 1, run: 0, codeMode: 0, other: 0, byName: { Read: 1 } },
      innerCalls: null,
      availableTools: ['Bash'],
      hostError: null,
      evidence: {},
    },
    parseError: null,
    costUsd: cost,
    costSource: 'host',
    verify: pass === false ? { pass: false, details: ['FAIL x'] } : { pass: true, details: ['ok'] },
    fallback: false,
    valid: true,
    invalidReasons: [],
    files: {},
    ...rest,
  });
}

function emptySummary(over: Partial<Summary>): Summary {
  return { generatedAt: '', dryRun: false, environment: null, groups: [], arms: [], comparisons: [], bootstrap: { seed: 1, iterations: 1, method: '' }, warmup: { runs: 0, costUsd: 0, runIds: [] }, ...over };
}

describe('stats', () => {
  it('computes median, min and max', () => {
    expect(spread([5, 2, 3])).toEqual({ median: 3, min: 2, max: 5, n: 3 });
    expect(spread([4, 1, 2, 10])).toEqual({ median: 3, min: 1, max: 10, n: 4 });
    expect(spread([])).toBeNull();
  });
});

describe('report', () => {
  it('aggregates medians over valid runs and keeps invalid runs out of the numbers', () => {
    const records = [
      record({ run: 1, turns: 2, cost: 0.01 }),
      record({ run: 2, turns: 6, cost: 0.03, verify: { pass: false, details: ['FAIL x'] } }),
      record({ run: 3, turns: 4, cost: 0.02, fallback: true }),
      record({ run: 4, turns: 100, cost: 9, valid: false, invalidReasons: ['timed out after 15 min'] }),
    ];
    const [g] = summarize(records);
    expect(g?.runs).toBe(4);
    expect(g?.validRuns).toBe(3);
    expect(g?.turns).toEqual({ median: 4, min: 2, max: 6, n: 3 });
    expect(g?.costUsd?.median).toBeCloseTo(0.02, 10);
    expect(g?.inputTokens).toEqual({ median: 40, min: 20, max: 60, n: 3 });
    expect(g?.passRate).toBeCloseTo(2 / 3, 10);
    expect(g?.fallbackRate).toBeCloseTo(1 / 4, 10);
    expect(g?.invalidReasons).toEqual(['timed out after 15 min']);
  });

  it('groups by host, task and arm, in a stable order', () => {
    const groups = summarize([record({ task: 'T2', arm: 'B' }), record({ host: 'codex', arm: 'C' }), record({}), record({ arm: 'B' })]);
    expect(groups.map((g) => `${g.host} ${g.task} ${g.arm}`)).toEqual(['claude T1 A', 'claude T1 B', 'claude T2 B', 'codex T1 C']);
  });

  it('never pools runs made with different configs', () => {
    const groups = summarize([record({ run: 1, turns: 2 }), record({ run: 2, turns: 50, configHash: 'bbbbbbbbbbbb', config: { model: 'claude-haiku-5-5' } })]);
    expect(groups.map((g) => [g.configHash, g.turns?.median])).toEqual([['aaaaaaaaaaaa', 2], ['bbbbbbbbbbbb', 50]]);
    expect(markdownTable(emptySummary({ groups }))).toContain('different configs');
  });

  it('bench:report defaults to the newest date directory', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'acm-latest-'));
    try {
      expect(await latestResultsDir(dir)).toBeUndefined();
      for (const d of ['2026-11-15', '2026-11-16', 'notes']) await mkdir(path.join(dir, d));
      expect(await latestResultsDir(dir)).toBe(path.join(dir, '2026-11-16'));
      const pkg = JSON.parse(await readFile(path.join(import.meta.dirname, '..', '..', 'package.json'), 'utf8'));
      expect(pkg.scripts['bench:report']).toBe('node bench/report.ts');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes summary.json and returns a Markdown table without writing it', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'acm-report-'));
    try {
      for (const [i, turns] of [2, 3, 7].entries()) {
        const d = path.join(dir, 'claude', 'T1', 'A', String(i + 1));
        await mkdir(d, { recursive: true });
        await writeFile(path.join(d, 'record.json'), JSON.stringify(record({ run: i + 1, turns })));
      }
      await writeFile(path.join(dir, 'env.json'), JSON.stringify({ invocations: [{ seed: 1, node: 'v22' }] }));
      const { summary, markdown } = await writeReport(dir, new Date('2026-11-15T00:00:00Z'));
      expect(summary.groups[0]?.turns).toEqual({ median: 3, min: 2, max: 7, n: 3 });
      expect(markdown).toContain('| claude | T1 | A native tools | aaaaaaaaaaaa | 100% | 100% | 3 (2–7) | 3 (2–7) |');
      expect(markdown).toContain('"seed": 1');
      expect(JSON.parse(await readFile(path.join(dir, 'summary.json'), 'utf8')).groups).toHaveLength(1);
      expect((await readdir(dir)).sort()).toEqual(['claude', 'env.json', 'summary.json']);
      expect(markdownTable({ ...summary, dryRun: true })).toContain('DRY RUN');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('pass^k and bootstrap', () => {
  it('pass^k is C(c,k)/C(n,k) and refuses k above the runs', () => {
    expect(passHatK(3, 3, 3)).toBe(1);
    expect(passHatK(2, 3, 3)).toBe(0);
    expect(passHatK(2, 3, 1)).toBeCloseTo(2 / 3, 12);
    expect(passHatK(3, 4, 2)).toBeCloseTo(3 / 6, 12);
    expect(passHatK(0, 5, 1)).toBe(0);
    expect(() => passHatK(3, 3, 4)).toThrow(RangeError);
  });

  it('a constant per-task difference gives a zero-width interval at that value', () => {
    const tasks = [0.01, 0.02, 0.05].map((base) => ({ a: [base, base + 0.002], b: [base + 0.003, base + 0.005] }));
    const ci = pairedBootstrap(tasks, { seed: 1, iterations: 2000 });
    expect(ci?.estimate).toBeCloseTo(0.003, 12);
    expect(ci?.lo).toBeCloseTo(0.003, 12);
    expect(ci?.hi).toBeCloseTo(0.003, 12);
    expect(ci?.crossesZero).toBe(false);
  });

  it('two tasks with differences 0 and 1: the bootstrap distribution is {0, .5, 1} with 1/4, 1/2, 1/4', () => {
    const ci = pairedBootstrap([{ a: [0], b: [0] }, { a: [0], b: [1] }], { seed: 3, iterations: 20_000 });
    expect(ci?.estimate).toBe(0.5);
    expect(ci?.lo).toBe(0);
    expect(ci?.hi).toBe(1);
    expect(ci?.crossesZero).toBe(true);
  });

  it('matches the normal-theory interval of a mean on many tasks', () => {
    const rng = new Rng(11);
    // Per-task differences uniform on [0, 1): mean 0.5, sd 1/sqrt(12); 400 tasks -> half-width 1.96 * 0.2887 / 20.
    const diffs = Array.from({ length: 400 }, () => rng.next());
    const tasks = diffs.map((d) => ({ a: [1], b: [1 + d] }));
    const ci = pairedBootstrap(tasks, { seed: 5, iterations: 4000 });
    const m = diffs.reduce((s, d) => s + d, 0) / diffs.length;
    const sd = Math.sqrt(diffs.reduce((s, d) => s + (d - m) ** 2, 0) / (diffs.length - 1));
    const half = (1.96 * sd) / Math.sqrt(diffs.length);
    expect(ci?.estimate).toBeCloseTo(m, 12);
    expect(Math.abs((ci?.lo ?? 0) - (m - half))).toBeLessThan(0.004);
    expect(Math.abs((ci?.hi ?? 0) - (m + half))).toBeLessThan(0.004);
  });

  it('is deterministic for a seed, weighs tasks equally and needs two tasks', () => {
    const tasks = [{ a: [1, 2, 3], b: [2] }, { a: [5], b: [4, 4, 4, 4] }, { a: [0], b: [3] }];
    expect(pairedBootstrap(tasks, { seed: 9 })).toEqual(pairedBootstrap(tasks, { seed: 9 }));
    expect(pairedBootstrap(tasks, { seed: 9 })?.estimate).toBeCloseTo((0 + -1 + 3) / 3, 12);
    expect(pairedBootstrap([{ a: [1], b: [2] }], { seed: 1 })).toBeNull();
  });
});

describe('quality metrics', () => {
  const cell = (task: string, arm: 'A' | 'B', passes: boolean[], cost: number) =>
    passes.map((pass, i) => record({ id: `claude-${task}-${arm}-r${i + 1}`, task, arm, run: i + 1, pass, cost, configHash: arm === 'A' ? 'aaaaaaaaaaaa' : 'bbbbbbbbbbbb', config: { model: 'm', task, arm } }));

  it('cost per solved task charges the failed runs too', () => {
    const [g] = summarize(cell('T9', 'A', [true, false, true, false], 0.05));
    expect(g?.passRate).toBe(0.5);
    expect(g?.passAll).toBe(0);
    expect(g?.costPerSolvedUsd).toBeCloseTo(0.2 / 2, 12);
    expect(summarize(cell('T9', 'A', [false, false], 0.05))[0]?.costPerSolvedUsd).toBeNull();
  });

  it('aggregates arms per cohort with one k, and compares arms paired by task', () => {
    const records = [
      ...cell('T9', 'A', [true, true, false], 0.04),
      ...cell('T9', 'B', [true, true, true], 0.03),
      ...cell('T10', 'A', [false, false, false], 0.06),
      ...cell('T10', 'B', [true, false, true], 0.05),
      ...cell('T11', 'A', [true, true, true], 0.02),
      ...cell('T11', 'B', [true, true, true], 0.01),
      record({ id: 'warmup-claude-T1-A-r1', warmup: true, cost: 5 }),
    ];
    const arms = summarizeArms(records);
    expect(arms.map((a) => a.arm)).toEqual(['A', 'B']);
    const [a, b] = arms;
    expect(new Set(arms.map((x) => x.cohort)).size).toBe(1);
    expect(a?.tasks).toBe(3);
    expect(a?.pass1).toBeCloseTo((2 / 3 + 0 + 1) / 3, 12);
    expect(a?.passHatK).toEqual({ k: 3, value: (0 + 0 + 1) / 3 });
    expect(b?.passHatK).toEqual({ k: 3, value: (1 + 0 + 1) / 3 });
    expect(a?.costPerSolvedUsd).toBeCloseTo((0.12 + 0.18 + 0.06) / 5, 12);
    expect(b?.costPerRunUsd).toBeCloseTo(0.03, 12);
    const [cmp] = compareArms(records, 1, 2000);
    expect(cmp).toMatchObject({ arm: 'B', reference: 'A', tasks: ['T10', 'T11', 'T9'] });
    expect(cmp?.costUsd).toMatchObject({ lo: expect.closeTo(-0.01, 12), hi: expect.closeTo(-0.01, 12), crossesZero: false });
    expect(cmp?.pass?.estimate).toBeCloseTo((1 / 3 + 2 / 3 + 0) / 3, 12);
    const md = markdownTable(emptySummary({ groups: summarize(records), arms, comparisons: compareArms(records, 1, 2000), warmup: { runs: 1, costUsd: 5, runIds: [] } }));
    expect(md).toContain('| claude | ' + (a?.cohort ?? '') + ' | B vs A | 3 | +33.3 pp [');
    expect(md).toMatch(/B vs A \| 3 \| [^|]*CI crosses 0[^|]*\| -\$0\.0100 \[-\$0\.0100, -\$0\.0100\] \|/);
    expect(md).toContain('Warmup: 1 run(s), $5.0000');
    // The warmup record never enters a group.
    expect(summarize(records).some((g) => g.task === 'T1')).toBe(false);
  });

  it('never pools two configs in one cell, even when the cohort key misses their difference', () => {
    // B ran twice per task with two arm definitions (as when the isolation method sat in the arm definition).
    const run = (task: string, arm: 'B' | 'D', def: string, pass: boolean, cost: number) =>
      record({ id: `claude-${task}-${arm}-${def}`, task, arm, pass, cost, configHash: createHash('sha256').update(`${task}${arm}${def}`).digest('hex').slice(0, 12), config: { model: 'm', task, arm, armDefinitionSha256: `${task}${arm}${def}` } });
    const records = ['T9', 'T10'].flatMap((t) => [run(t, 'D', 'x', true, 2), run(t, 'B', 'x', true, 1), run(t, 'B', 'y', false, 9)]);
    const arms = summarizeArms(records);
    const main = arms.find((a) => a.arm === 'D')?.cohort;
    expect(arms.filter((a) => a.cohort === main).map((a) => a.arm)).toEqual(['D']);
    expect(arms.filter((a) => a.arm === 'B').map((a) => `${a.validRuns}/${a.runs} pass ${a.pass1}`).sort()).toEqual(['1/1 pass 0', '1/1 pass 0', '1/1 pass 1', '1/1 pass 1']);
    expect(compareArms(records, 1, 200)).toEqual([]);
  });

  it('counts each run in the one cohort it was assigned, when only one task of an arm has two configs', () => {
    const run = (task: string, def: string, valid = true) =>
      record({ id: `claude-${task}-B-${def}-${valid}`, task, arm: 'B', valid, configHash: createHash('sha256').update(`${task}${def}`).digest('hex').slice(0, 12), config: { model: 'm', task, arm: 'B', armDefinitionSha256: `${task}${def}` } });
    const records = [run('T9', 'x'), run('T9', 'y'), run('T10', 'x'), run('T10', 'x', false)];
    const rows = summarizeArms(records).map((a) => `${a.tasks} task(s) ${a.validRuns}/${a.runs}`).sort();
    expect(rows).toEqual(['1 task(s) 1/1', '1 task(s) 1/1', '1 task(s) 1/2']);
  });

  it('keeps B0 runs of two baseline builds apart, and compares B with each', () => {
    const run = (task: string, arm: 'B' | 'B0', acmBuild: string, pass: boolean, cost: number) =>
      record({ id: `claude-${task}-${arm}-${acmBuild}`, task, arm, pass, cost, configHash: acmBuild === 'checkout' ? 'cccccccccccc' : acmBuild.slice(-12), config: { model: 'm', task, arm, acmBuild } });
    const records = ['T9', 'T10'].flatMap((t) => [run(t, 'B', 'checkout', true, 3), run(t, 'B0', 'ref:aaaaaaaaaaaa', false, 1), run(t, 'B0', 'ref:bbbbbbbbbbbb', true, 3)]);
    const arms = summarizeArms(records);
    expect(arms.map((a) => [a.arm, a.armLabel, a.pass1, a.costPerRunUsd, a.validRuns, a.runs])).toEqual([
      ['B', 'agent-code-mode (strict)', 1, 3, 2, 2],
      ['B0@ref:aaaaaaaaaaaa', 'agent-code-mode baseline build (strict)', 0, 1, 2, 2],
      ['B0@ref:bbbbbbbbbbbb', 'agent-code-mode baseline build (strict)', 1, 3, 2, 2],
    ]);
    const cmp = compareArms(records, 1, 200);
    expect(cmp.map((c) => [`${c.arm} vs ${c.reference}`, c.pass?.estimate, c.costUsd?.estimate])).toEqual([
      ['B vs B0@ref:aaaaaaaaaaaa', 1, 2],
      ['B vs B0@ref:bbbbbbbbbbbb', 0, 0],
    ]);
  });
});
