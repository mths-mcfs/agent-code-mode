import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RunRecordSchema, type RunRecord } from '../lib/record.ts';
import { spread } from '../lib/stats.ts';
import { latestResultsDir, markdownTable, summarize, writeReport } from '../report.ts';

function record(over: Partial<RunRecord> & { turns?: number; cost?: number }): RunRecord {
  const { turns = 2, cost = 0.01, ...rest } = over;
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
    verify: { pass: true, details: ['ok'] },
    fallback: false,
    valid: true,
    invalidReasons: [],
    files: {},
    ...rest,
  });
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
    expect(markdownTable({ generatedAt: '', dryRun: false, environment: null, groups })).toContain('different configs');
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

  it('writes summary.json and a Markdown table', async () => {
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
      expect(markdown).toContain('| claude | T1 | A native tools | aaaaaaaaaaaa | 100% | 3 (2–7) |');
      expect(markdown).toContain('"seed": 1');
      expect(JSON.parse(await readFile(path.join(dir, 'summary.json'), 'utf8')).groups).toHaveLength(1);
      expect(markdownTable({ ...summary, dryRun: true })).toContain('DRY RUN');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
