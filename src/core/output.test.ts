import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OverflowStore } from './overflow.js';
import {
  CHANGED_FILES_INLINE,
  DIFF_INLINE_CHARS,
  DIFF_STAT_FILES,
  ERROR_CAP_CHARS,
  RESULT_IN_NEXT_BLOCK,
  GROUP_TEXT_CHARS,
  SUCCESS_CAP_CHARS,
  diffStat,
  formatRunResult,
  groupFailed,
  runResultView,
  summarizeCalls,
  type McpToolResponse,
  type OverflowSink,
} from './output.js';
import { stateDirPath } from './state-dir.js';
import type { CallLogEntry, RunResult } from './types.js';

const base: RunResult = { ok: true, result: null, logs: [], calls: [], changedFiles: [], diff: '', warnings: [] };

const allowed = (i: number, tool = 'read'): CallLogEntry => ({ id: `c${i}`, tool, summary: `${tool} f${i}.txt`, decision: 'allowed', durationMs: 2 });
const deniedCall = (i: number, reason = 'rule: Read(./secret-*) denied'): CallLogEntry => ({ id: `c${i}`, tool: 'read', summary: `read secret-${i}.txt`, decision: 'denied', reason, durationMs: 1 });

/** A unified diff of `files` files, each changing `lines` lines, in the tool runtime's format. */
function fileDiffs(files: number, lines: number): string {
  let out = '';
  for (let f = 0; f < files; f++) {
    out += `--- a/src/f${f}.ts\n+++ b/src/f${f}.ts\n@@ -1,${lines} +1,${lines} @@\n`;
    for (let i = 0; i < lines; i++) out += `-old line ${i} of file ${f}\n`;
    for (let i = 0; i < lines; i++) out += `+new line ${i} of file ${f}\n`;
  }
  return out;
}

const json = (r: McpToolResponse): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(r.content[0]?.text ?? '');
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
  return Object.fromEntries(Object.entries(parsed));
};
const all = (r: McpToolResponse): string => r.content.map((c) => c.text).join('');
const total = (r: McpToolResponse): number => r.content.reduce((n, c) => n + c.text.length, 0);

/** The whole result kept for `readOverflow`, read back through the binding. */
function kept(store: OverflowStore, r: McpToolResponse): unknown {
  const overflow = json(r)['overflow'];
  if (overflow === null || typeof overflow !== 'object' || !('id' in overflow)) throw new Error('no overflow id');
  let text = '';
  for (;;) {
    const reply = store.read({ id: overflow.id, offset: text.length, limit: 1_000_000 });
    if (!reply.ok || !('totalChars' in reply.value)) throw new Error('overflow not readable');
    text += reply.value.text;
    if (!reply.value.truncated) return JSON.parse(text);
  }
}

const failingSink: OverflowSink = { put: () => undefined };

describe('summarizeCalls', () => {
  it('turns the call log into counts and keeps denied and failed calls in full, without durations', () => {
    const calls: CallLogEntry[] = [
      allowed(1),
      allowed(2, 'write'),
      { id: 'c3', tool: 'bash', summary: 'bash rm x', decision: 'denied', reason: 'rule: rm is not allowed', durationMs: 9 },
      { id: 'c4', tool: 'read', summary: 'read gone.txt', decision: 'error', reason: 'gone.txt does not exist', durationMs: 1 },
      allowed(5),
    ];
    expect(summarizeCalls(calls)).toEqual({
      total: 5,
      byTool: { read: 3, write: 1, bash: 1 },
      denied: [{ id: 'c3', tool: 'bash', summary: 'bash rm x', reason: 'rule: rm is not allowed' }],
      errors: [{ id: 'c4', tool: 'read', summary: 'read gone.txt', reason: 'gone.txt does not exist' }],
    });
  });

  it('does not repeat the run error in the reason of the call that raised it', () => {
    const message = 'host would ask the user and no interactive channel exists: Bash needs approval in default mode';
    const calls: CallLogEntry[] = [
      { id: 'c1', tool: 'bash', summary: 'bash node -v', decision: 'denied', reason: `ask-unavailable: ${message}`, durationMs: 1 },
      { id: 'c2', tool: 'read', summary: 'read x', decision: 'denied', reason: message, durationMs: 1 },
      { id: 'c3', tool: 'read', summary: 'read y', decision: 'denied', reason: 'rule: another reason', durationMs: 1 },
    ];
    expect(summarizeCalls(calls, message).denied).toEqual([
      { id: 'c1', tool: 'bash', summary: 'bash node -v', reason: 'ask-unavailable (see error)' },
      { id: 'c2', tool: 'read', summary: 'read x' },
      { id: 'c3', tool: 'read', summary: 'read y', reason: 'rule: another reason' },
    ]);
    const view = json(formatRunResult({ ...base, ok: false, error: { name: 'PermissionDenied', message, kind: 'error' }, calls }));
    expect(all(formatRunResult({ ...base, ok: false, error: { name: 'PermissionDenied', message, kind: 'error' }, calls })).split(message)).toHaveLength(2);
    expect(view['error']).toMatchObject({ message });
  });

  it('D1: lists every denied call, however many', () => {
    const out = formatRunResult({ ...base, result: 'caught all', calls: Array.from({ length: 25 }, (_, i) => deniedCall(i + 1)) });
    const calls = json(out)['calls'];
    expect(calls).toMatchObject({ total: 25 });
    expect((calls as { denied: unknown[] }).denied).toEqual(Array.from({ length: 25 }, (_, i) => ({ id: `c${i + 1}`, tool: 'read', summary: `read secret-${i + 1}.txt`, reason: 'rule: Read(./secret-*) denied' })));
    expect(all(out)).not.toMatch(/more\]/);
  });

  it('D1: lists every failed call, and every changed file of a failed run', () => {
    const errors = Array.from({ length: 30 }, (_, i): CallLogEntry => ({ id: `c${i}`, tool: 'read', summary: `read m${i}`, decision: 'error', reason: 'missing', durationMs: 0 }));
    const changedFiles = Array.from({ length: 40 }, (_, i) => `src/f${i}.ts`);
    const failed: RunResult = { ...base, ok: false, error: { kind: 'error', name: 'Error', message: 'x' }, calls: errors, changedFiles, diff: '--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+b\n' };
    const view = json(formatRunResult(failed, { errorCap: 100_000 }));
    expect((view['calls'] as { errors: unknown[] }).errors).toHaveLength(30);
    expect(view['changedFiles']).toEqual(changedFiles);
    expect(view['changedCount']).toBeUndefined();
  });

  describe('many changed files in a successful run', () => {
    const files = (n: number): string[] => Array.from({ length: n }, (_, i) => `src/f${i}.ts`);
    const hunks = (names: readonly string[]): string => names.map((f) => `--- a/${f}\n+++ b/${f}\n@@ -1,1 +1,1 @@\n-${'a'.repeat(60)}\n+${'b'.repeat(60)}\n`).join('');
    const store = (): { put(text: string): string; kept: string[] } => {
      const kept: string[] = [];
      return { kept, put: (text) => (kept.push(text), `ov_${kept.length}`) };
    };

    it('keeps the list up to the limit', () => {
      const changedFiles = files(CHANGED_FILES_INLINE);
      const sink = store();
      const view = json(formatRunResult({ ...base, changedFiles }, { overflow: sink }));
      expect(view['changedFiles']).toEqual(changedFiles);
      expect(view['changedCount']).toBeUndefined();
      expect(sink.kept).toEqual([]);
    });

    it('above the limit counts the files, keeps only the diff total and sends the whole result to the overflow', () => {
      const changedFiles = files(CHANGED_FILES_INLINE + 2);
      const sink = store();
      const view = json(formatRunResult({ ...base, changedFiles, diff: hunks(changedFiles) }, { overflow: sink }));
      expect(view['changedFiles']).toBeUndefined();
      expect(view['changedCount']).toBe(12);
      expect(view['diffStat']).toEqual({ total: '12 files +12 -12' });
      expect(view['overflow']).toMatchObject({ id: 'ov_1' });
      expect(JSON.parse(sink.kept[0] ?? '{}')).toMatchObject({ changedFiles });
    });

    it('a small diff stays inline next to the count', () => {
      const changedFiles = files(CHANGED_FILES_INLINE + 1);
      const view = json(formatRunResult({ ...base, changedFiles, diff: '--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+b\n' }, { overflow: store() }));
      expect(view['changedCount']).toBe(11);
      expect(view['diff']).toContain('+++ b/x');
    });

    it.each([
      ['there is no store', undefined],
      ['the store refuses the result', { put: () => undefined }],
    ])('restores the whole list and names no overflow when %s', (_why, overflow) => {
      const changedFiles = files(CHANGED_FILES_INLINE + 2);
      const view = json(formatRunResult({ ...base, changedFiles, diff: hunks(changedFiles) }, overflow === undefined ? {} : { overflow }));
      expect(view['changedFiles']).toEqual(changedFiles);
      expect(view['changedCount']).toBeUndefined();
      expect(view['overflow']).toBeUndefined();
      expect(view['diffStat']).toMatchObject({ files: expect.any(Object), moreFiles: 2 });
    });

    it('restores the list before the cap, so a list too long to fit is cut with a marker instead of disappearing', () => {
      const changedFiles = files(2_000);
      const view = json(formatRunResult({ ...base, changedFiles }, { successCap: 4_000 }));
      expect(view['truncated']).toBe(true);
      expect(view['changedCount']).toBeUndefined();
      expect((view['changedFiles'] as string[]).at(-1)).toMatch(/more\]$/);
    });

    it('without a store, an error keeps every path that fits: the diff totals give way first', () => {
      const changedFiles = Array.from({ length: 11 }, (_, i) => `${'folder-name/'.repeat(44)}f${i}.ts`);
      const failed: RunResult = { ...base, ok: false, error: { kind: 'error', name: 'Error', message: 'x' }, changedFiles, diff: hunks(changedFiles) };
      const out = formatRunResult(failed);
      expect(json(out)['changedFiles']).toEqual(changedFiles);
      expect(json(out)['diffStat']).toEqual({ total: '11 files +11 -11' });
      expect(all(out).length).toBeLessThanOrEqual(ERROR_CAP_CHARS);
    });

    it('a list that cannot fit whole keeps as many entries as fit', () => {
      const changedFiles = files(2_000);
      const list = json(formatRunResult({ ...base, changedFiles }, { successCap: 4_000 }))['changedFiles'] as string[];
      expect(list.length).toBeGreaterThan(200);
    });

    it.each([200, 80, 30, 11, 5])('never goes above a cap of %i characters', (successCap) => {
      const changedFiles = files(50);
      expect(all(formatRunResult({ ...base, changedFiles, diff: hunks(changedFiles), logs: ['x'.repeat(5_000)] }, { successCap, overflow: store() })).length).toBeLessThanOrEqual(successCap);
    });

    it('verbose keeps the list', () => {
      const changedFiles = files(CHANGED_FILES_INLINE + 2);
      const view = json(formatRunResult({ ...base, changedFiles }, { verbose: true, overflow: store() }));
      expect(view['changedFiles']).toEqual(changedFiles);
    });
  });

  it('keeps the size of a run with many allowed calls constant', () => {
    const few = all(formatRunResult({ ...base, calls: Array.from({ length: 3 }, (_, i) => allowed(i)) }));
    const many = all(formatRunResult({ ...base, calls: Array.from({ length: 3_000 }, (_, i) => allowed(i)) }));
    expect(many.length - few.length).toBeLessThan(10);
  });
});

describe('runResultView', () => {
  it('leaves empty fields out', () => {
    expect(Object.keys(runResultView({ ...base, result: 1 }).view).sort()).toEqual(['calls', 'ok', 'result']);
    const rolledBack = { restored: ['a'], skipped: [] };
    const failed: RunResult = { ...base, ok: false, error: { kind: 'error', name: 'Error', message: 'x' }, logs: ['l'], warnings: ['w'], rolledBack };
    expect(runResultView(failed).view).toEqual({ ok: false, result: null, error: failed.error, logs: ['l'], calls: { total: 0, byTool: {} }, warnings: ['w'], rolledBack });
  });

  it('D6: verbose returns the log of every call and the whole diff', () => {
    const diff = fileDiffs(30, 5);
    const calls = [allowed(1), deniedCall(2)];
    const { view, cut } = runResultView({ ...base, calls, diff }, true);
    expect(cut).toBe(false);
    expect(view['calls']).toEqual(calls);
    expect(view['diff']).toBe(diff);
    expect(view['diffStat']).toBeUndefined();
  });
});

describe('diffStat', () => {
  it('replaces a diff above the inline size, with at most ten files plus the totals', () => {
    const diff = fileDiffs(30, 3);
    expect(diff.length).toBeGreaterThan(DIFF_INLINE_CHARS);
    const store = new OverflowStore();
    const out = formatRunResult({ ...base, changedFiles: ['src/f0.ts'], diff }, { overflow: store });
    const view = json(out);
    expect(view['diff']).toBeUndefined();
    const stat = view['diffStat'] as { files: Record<string, string>; moreFiles: number; total: string };
    expect(Object.keys(stat.files)).toHaveLength(DIFF_STAT_FILES);
    expect(stat.files['src/f0.ts']).toBe('+3 -3');
    expect(stat.moreFiles).toBe(20);
    expect(stat.total).toBe('30 files +90 -90');
    // The whole diff stays readable.
    expect(kept(store, out)).toMatchObject({ diff });
  });

  it('keeps a small diff whole', () => {
    const small = fileDiffs(1, 2);
    expect(json(formatRunResult({ ...base, diff: small }))).toMatchObject({ diff: small });
  });

  it('counts hunk lines from the hunk header, so removed lines that start with -- are not file headers', () => {
    const diff = '--- a/a.md\n+++ b/a.md\n@@ -1,2 +1,2 @@\n--- not a header\n+++ not one either\n keep\n\\ No newline at end of file\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+x\n';
    expect(diffStat(diff)).toEqual({ files: { 'a.md': '+1 -1', 'new.txt': '+1 -0' }, total: '2 files +2 -1' });
  });
});

describe('formatRunResult: plain text result', () => {
  const text = Array.from({ length: 20 }, (_, i) => `line "${i}" \\ of output`).join('\n');

  it('sends a multi-line string result above 200 chars unescaped in a second block', () => {
    const out = formatRunResult({ ...base, result: text, calls: [allowed(1)] });
    expect(out.content).toHaveLength(2);
    expect(json(out)).toMatchObject({ ok: true, result: RESULT_IN_NEXT_BLOCK, calls: { total: 1 } });
    expect(out.content[1]?.text).toBe(text);
  });

  it('keeps short strings, single-line strings and other values in the JSON', () => {
    for (const result of ['short\nstring', 'x'.repeat(5_000), { text }, 42]) {
      const out = formatRunResult({ ...base, result });
      expect(out.content).toHaveLength(1);
      expect(json(out)['result']).toEqual(result);
    }
  });
});

describe('formatRunResult: response cap', () => {
  it('sets isError on failed runs', () => {
    expect(formatRunResult({ ...base, result: { a: 1 } }).isError).toBe(false);
    expect(formatRunResult({ ...base, ok: false, error: { kind: 'error', name: 'Error', message: 'x' } }).isError).toBe(true);
  });

  it('keeps the start and end of a huge result, reports its size and keeps the rest for readOverflow', () => {
    const lines = Array.from({ length: 50_000 }, (_, i) => `row ${i}`).join('\n');
    const result: RunResult = { ...base, result: lines, calls: [allowed(1)] };
    const store = new OverflowStore();
    const out = formatRunResult(result, { overflow: store });
    expect(total(out)).toBeLessThanOrEqual(SUCCESS_CAP_CHARS);
    const view = json(out);
    expect(view).toMatchObject({ ok: true, result: RESULT_IN_NEXT_BLOCK, truncated: true, calls: { total: 1 } });
    const overflow = view['overflow'] as { id: string; chars: number };
    expect(overflow.chars).toBe(JSON.stringify(result).length);
    const shown = out.content[1]?.text ?? '';
    expect(shown.startsWith('row 0\nrow 1\n')).toBe(true);
    expect(shown.endsWith('row 49998\nrow 49999')).toBe(true);
    expect(shown).toContain(`readOverflow(${JSON.stringify(overflow.id)})`);
    expect(kept(store, out)).toEqual(result);
  });

  it('cuts a huge non-string result as JSON text in the second block', () => {
    const result: RunResult = { ...base, result: { list: Array.from({ length: 20_000 }, (_, i) => ({ i })) } };
    const out = formatRunResult(result, { overflow: new OverflowStore() });
    expect(total(out)).toBeLessThanOrEqual(SUCCESS_CAP_CHARS);
    expect(json(out)['result']).toBe(RESULT_IN_NEXT_BLOCK);
    expect(out.content[1]?.text.startsWith('{"list":[{"i":0},')).toBe(true);
  });

  it('D1: above the cap, denied calls are grouped by tool and reason with exact counts, and the overflow has them all', () => {
    const reason = `hook: ${'policy text '.repeat(10)}`;
    const calls = Array.from({ length: 2_000 }, (_, i) => deniedCall(i, reason));
    const store = new OverflowStore();
    const out = formatRunResult({ ...base, result: 'r', calls }, { overflow: store });
    expect(total(out)).toBeLessThanOrEqual(SUCCESS_CAP_CHARS);
    expect((json(out)['calls'] as { denied: unknown[] }).denied).toEqual([{ tool: 'read', reason, count: 2_000, first: 'read secret-0.txt' }]);
    expect((kept(store, out) as RunResult).calls).toEqual(calls);
  });

  it('keeps every distinct reason of denied and failed calls, even in verbose and error results', () => {
    const calls: CallLogEntry[] = [];
    for (let i = 0; i < 3_000; i++) {
      calls.push({ id: `d${i}`, tool: i % 2 ? 'bash' : 'write', summary: `${i % 2 ? 'bash' : 'write'} ${'s'.repeat(80)}${i}`, decision: 'denied', reason: `rule ${i % 7}`, durationMs: 0 });
      calls.push({ id: `e${i}`, tool: 'read', summary: `read m${i}`, decision: 'error', reason: `${'p'.repeat(100)} code ${i % 5}`, durationMs: 0 });
    }
    for (const ok of [true, false]) {
      for (const verbose of [false, true]) {
        const result: RunResult = { ...base, ok, ...(ok ? {} : { error: { kind: 'error' as const, name: 'Error', message: 'boom' } }), calls };
        const out = formatRunResult(result, { overflow: new OverflowStore(), verbose });
        expect(total(out)).toBeLessThanOrEqual(ok ? SUCCESS_CAP_CHARS : ERROR_CAP_CHARS);
        const shown = json(out)[verbose ? 'callSummary' : 'calls'] as { denied: { tool: string; reason: string; count: number }[]; errors: { reason: string; count: number }[] };
        expect(shown.denied).toHaveLength(14);
        expect(shown.errors).toHaveLength(5);
        expect(shown.denied.reduce((n, g) => n + g.count, 0)).toBe(3_000);
        expect(shown.errors.reduce((n, g) => n + g.count, 0)).toBe(3_000);
        expect(shown.denied[0]).toMatchObject({ tool: 'write', reason: 'rule 0', first: `write ${'s'.repeat(80)}0` });
      }
    }
  });

  it('cuts reasons to GROUP_TEXT_CHARS before leaving a group out, and counts the groups left out', () => {
    const errors = Array.from({ length: 1_000 }, (_, i): CallLogEntry => ({ id: `c${i}`, tool: 'read', summary: `read missing-${i}`, decision: 'error', reason: `missing-${i} ${'x'.repeat(1_000)}`, durationMs: 0 }));
    const store = new OverflowStore();
    const out = formatRunResult({ ...base, result: 'done', calls: errors }, { overflow: store });
    expect(total(out)).toBeLessThanOrEqual(SUCCESS_CAP_CHARS);
    const list = (json(out)['calls'] as { errors: unknown[] }).errors;
    const groups = list.slice(0, -1) as { reason: string; count: number }[];
    expect(groups.length).toBeGreaterThan(50);
    groups.forEach((g, i) => expect(g.reason).toBe(`missing-${i} ${'x'.repeat(GROUP_TEXT_CHARS - `missing-${i} `.length)}…[${`missing-${i} `.length + 1_000 - GROUP_TEXT_CHARS} chars cut]`));
    expect(list.at(-1)).toBe(`…[${1_000 - groups.length} more reasons (${1_000 - groups.length} calls) in overflow]`);
    expect((kept(store, out) as RunResult).calls).toEqual(errors);
  });

  it('property: every reason shows until the groups fit no more, counts add up, and the overflow has every call', () => {
    let seed = 11;
    const rand = (n: number): number => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648), seed % n);
    const marker = /^…\[(\d+) more reasons? \((\d+) calls?\) in overflow\]$/;
    for (let round = 0; round < 60; round++) {
      const distinct = 1 + rand(round % 3 === 0 ? 3_000 : 40);
      const reasons = Array.from({ length: distinct }, (_, r) => `reason ${r} ${'r'.repeat(rand(round % 4 === 0 ? 600 : 120))}`);
      const n = 1 + rand(4_000);
      const calls = Array.from({ length: n }, (_, i): CallLogEntry => {
        const roll = rand(3);
        const tool = ['read', 'bash', 'edit'][rand(3)] ?? 'read';
        return { id: `c${i}`, tool, summary: `${tool} ${'f'.repeat(rand(60))}${i}`, decision: roll === 0 ? 'allowed' : roll === 1 ? 'denied' : 'error', reason: reasons[rand(distinct)], durationMs: 0 };
      });
      const ok = rand(2) === 0;
      const result: RunResult = {
        ...base,
        ok,
        ...(ok ? { result: 'x\n'.repeat(rand(30_000)) } : { error: { kind: 'error' as const, name: 'Error', message: 'e'.repeat(rand(20_000)) } }),
        logs: Array.from({ length: rand(500) }, (_, i) => `log ${i}`),
        changedFiles: Array.from({ length: rand(300) }, (_, i) => `src/f${i}.ts`),
        calls,
      };
      const store = new OverflowStore();
      const verbose = rand(2) === 0;
      const out = formatRunResult(result, { overflow: store, verbose });
      expect(total(out)).toBeLessThanOrEqual(ok ? SUCCESS_CAP_CHARS : ERROR_CAP_CHARS);
      const expected = summarizeCalls(calls, result.error?.message);
      if (json(out)['truncated'] !== true) {
        expect(json(out)['calls']).toEqual(verbose ? calls : expected);
        continue;
      }
      // Above the cap a verbose log stays a (cut) list and the compact calls go beside it.
      const shownCalls = json(out)[verbose ? 'callSummary' : 'calls'];
      if (verbose) expect(Array.isArray(json(out)['calls'])).toBe(true);
      expect((kept(store, out) as RunResult).calls).toEqual(calls);
      for (const key of ['denied', 'errors'] as const) {
        const want = expected[key];
        const list = (shownCalls as Record<string, unknown[] | undefined>)[key];
        if (want === undefined) {
          expect(list).toBeUndefined();
          continue;
        }
        if (list === undefined) throw new Error(`${key} missing`);
        if (list.every((e) => typeof e === 'object' && e !== null && 'id' in e)) {
          expect(list).toEqual(want);
          continue;
        }
        const groups = groupFailed(want);
        const last = list.at(-1);
        const m = typeof last === 'string' ? marker.exec(last) : null;
        const shown = (m ? list.slice(0, -1) : list) as { tool: string; reason?: string; count: number }[];
        if (distinct <= 15) expect(m).toBeNull();
        expect(shown.length + Number(m?.[1] ?? 0)).toBe(groups.length);
        expect(shown.reduce((a, g) => a + g.count, 0) + Number(m?.[2] ?? 0)).toBe(want.length);
        shown.forEach((g, i) => {
          const w = groups[i];
          expect(g.tool).toBe(w?.tool);
          expect(g.count).toBe(w?.count);
          const r = w?.reason ?? '';
          expect(g.reason === r || (g.reason ?? '').startsWith(`${r.slice(0, GROUP_TEXT_CHARS)}…[`)).toBe(true);
        });
      }
    }
  });

  it('caps error results lower', () => {
    const big: RunResult = { ...base, ok: false, error: { kind: 'error', name: 'Error', message: 'm'.repeat(20_000) }, logs: ['l'.repeat(20_000)] };
    const out = formatRunResult(big, { overflow: new OverflowStore() });
    expect(total(out)).toBeLessThanOrEqual(ERROR_CAP_CHARS);
    expect(json(out)).toMatchObject({ ok: false, truncated: true, error: { name: 'Error' } });
  });

  it('D2: never names an overflow that could not be kept', () => {
    const big: RunResult = { ...base, result: 'x\n'.repeat(60_000), calls: Array.from({ length: 3_000 }, (_, i) => deniedCall(i)) };
    const out = formatRunResult(big, { overflow: failingSink });
    expect(total(out)).toBeLessThanOrEqual(SUCCESS_CAP_CHARS);
    expect(all(out)).not.toMatch(/overflow/i);
    expect(json(out)).toMatchObject({ truncated: true, chars: JSON.stringify(big).length });
    const diffOnly = formatRunResult({ ...base, diff: fileDiffs(30, 3) }, { overflow: failingSink });
    expect(all(diffOnly)).not.toMatch(/overflow/i);
    expect(json(diffOnly)['diffStat']).toBeDefined();
  });

  it('stays under the cap with valid JSON whatever the shape', () => {
    let seed = 7;
    const rand = (n: number): number => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648), seed % n);
    for (let round = 0; round < 40; round++) {
      const result: RunResult = {
        ...base,
        ok: rand(3) !== 0,
        ...(rand(2) === 0 ? { error: { kind: 'error' as const, name: 'Error', message: 'e'.repeat(rand(30_000)), stack: 's\n'.repeat(rand(5_000)) } } : {}),
        result: rand(2) === 0 ? 'q"\n'.repeat(rand(40_000)) : { deep: Array.from({ length: rand(5_000) }, (_, i) => ({ i, s: 'z'.repeat(rand(50)) })) },
        logs: Array.from({ length: rand(3_000) }, (_, i) => `log ${i} ${'"'.repeat(rand(40))}`),
        calls: Array.from({ length: rand(1_500) }, (_, i) => (rand(2) === 0 ? allowed(i) : deniedCall(i, 'r'.repeat(rand(400))))),
        changedFiles: Array.from({ length: rand(400) }, (_, i) => `src/${'d/'.repeat(rand(10))}f${i}.ts`),
        diff: fileDiffs(rand(40), rand(30)),
        warnings: Array.from({ length: rand(200) }, (_, i) => `warning ${i} ${'w'.repeat(rand(200))}`),
      };
      for (const verbose of [false, true]) {
        const out = formatRunResult(result, { overflow: new OverflowStore(), verbose });
        expect(total(out)).toBeLessThanOrEqual(result.ok ? SUCCESS_CAP_CHARS : ERROR_CAP_CHARS);
        expect(json(out)['ok']).toBe(result.ok);
      }
    }
  });

  it('serializes values JSON cannot represent instead of throwing', () => {
    const circular: Record<string, unknown> = { n: 1n };
    circular['self'] = circular;
    expect(json(formatRunResult({ ...base, result: circular }))['result']).toEqual({ n: '1', self: '[circular]' });
  });
});

describe('stateDirPath', () => {
  it('uses an absolute XDG_STATE_HOME, else ~/.local/state', () => {
    expect(stateDirPath({ XDG_STATE_HOME: '/x/state' }, '/home/u')).toBe(path.join('/x/state', 'agent-code-mode'));
    expect(stateDirPath({ XDG_STATE_HOME: 'relative' }, '/home/u')).toBe(path.join('/home/u', '.local', 'state', 'agent-code-mode'));
    expect(stateDirPath({}, '/home/u')).toBe(path.join('/home/u', '.local', 'state', 'agent-code-mode'));
  });
});
