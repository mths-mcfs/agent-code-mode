import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DIFF_INLINE_CHARS, ERROR_CAP_CHARS, RESULT_IN_NEXT_BLOCK, SUCCESS_CAP_CHARS, diffStat, formatRunResult, safeStringify, type McpToolResponse } from './output.js';
import { OverflowStore } from './overflow.js';
import type { CallLogEntry, RunResult } from './types.js';
import { binaryDiff, unifiedDiff } from '../tools/diff.js';

const base: RunResult = { ok: true, result: null, logs: [], calls: [], changedFiles: [], diff: '', warnings: [] };

function call(n: number, decision: CallLogEntry['decision'], reason?: string, tool = 'read'): CallLogEntry {
  return { id: `c${n}`, tool, summary: `${tool} f${n}.txt`, decision, durationMs: 1, ...(reason === undefined ? {} : { reason }) };
}

function json(r: McpToolResponse): Record<string, unknown> {
  return JSON.parse(r.content[0]?.text ?? '') as Record<string, unknown>;
}

function size(r: McpToolResponse): number {
  return r.content.reduce((n, c) => n + c.text.length, 0);
}

function readAll(store: OverflowStore, id: string): string {
  let text = '';
  for (;;) {
    const r = store.read({ id, offset: text.length, limit: 7_000 });
    if (!r.ok || !('totalChars' in r.value)) throw new Error('expected a slice');
    text += r.value.text;
    if (!r.value.truncated) return text;
  }
}

function fileDiff(name: string, lines: number): string {
  return `--- a/${name}\n+++ b/${name}\n@@ -1,${lines} +1,${lines} @@\n${Array.from({ length: lines }, (_, i) => `-old ${i}\n+new ${i}`).join('\n')}\n`;
}

describe('formatRunResult', () => {
  it('returns counts per tool and leaves empty fields out', () => {
    const calls = [call(1, 'allowed'), call(2, 'allowed', undefined, 'grep'), call(3, 'allowed')];
    const out = formatRunResult({ ...base, result: { a: 1 }, calls });
    expect(out.isError).toBe(false);
    expect(json(out)).toEqual({ ok: true, result: { a: 1 }, calls: { total: 3, byTool: { read: 2, grep: 1 } } });
  });

  it('lists every denied and failed call with its reason', () => {
    const calls = [call(1, 'allowed'), call(2, 'denied', 'rule: denied by Read(./secret)'), call(3, 'error', 'not-found: f3.txt does not exist', 'edit')];
    const out = formatRunResult({ ...base, ok: false, error: { kind: 'error', name: 'Error', message: 'boom' }, calls });
    expect(out.isError).toBe(true);
    expect(json(out)['calls']).toEqual({
      total: 3,
      byTool: { read: 2, edit: 1 },
      denied: [{ id: 'c2', tool: 'read', summary: 'read f2.txt', reason: 'rule: denied by Read(./secret)' }],
      errors: [{ id: 'c3', tool: 'edit', summary: 'edit f3.txt', reason: 'not-found: f3.txt does not exist' }],
    });
  });

  it('turns a large diff into diffStat and keeps the whole result for readOverflow', () => {
    const store = new OverflowStore();
    const diff = Array.from({ length: 12 }, (_, i) => fileDiff(`src/f${i}.ts`, 10)).join('');
    expect(diff.length).toBeGreaterThan(DIFF_INLINE_CHARS);
    const result: RunResult = { ...base, changedFiles: Array.from({ length: 12 }, (_, i) => `src/f${i}.ts`), diff };
    const body = json(formatRunResult(result, { overflow: store }));
    expect(body).not.toHaveProperty('diff');
    expect(body['diffStat']).toMatchObject({ moreFiles: 2, total: '12 files +120 -120' });
    expect(Object.keys((body['diffStat'] as { files: object }).files)).toHaveLength(10);
    const { id } = body['overflow'] as { id: string };
    expect(JSON.parse(readAll(store, id))).toEqual(result);
  });

  it('returns every call and the whole diff with verbose', () => {
    const diff = fileDiff('a.ts', 200);
    const calls = [call(1, 'allowed')];
    const body = json(formatRunResult({ ...base, calls, diff }, { verbose: true }));
    expect(body['calls']).toEqual(calls);
    expect(body['diff']).toBe(diff);
  });

  it('sends a long multi-line string result as a second plain-text block', () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i} "quoted"`).join('\n');
    const out = formatRunResult({ ...base, result: text });
    expect(json(out)['result']).toBe(RESULT_IN_NEXT_BLOCK);
    expect(out.content[1]?.text).toBe(text);
    expect(json(formatRunResult({ ...base, result: 'one line' }))['result']).toBe('one line');
  });

  it('cuts an oversized response to the cap and keeps the whole result readable', () => {
    const store = new OverflowStore();
    const result: RunResult = {
      ...base,
      result: Array.from({ length: 20_000 }, (_, i) => ({ i, text: `row ${i}` })),
      logs: Array.from({ length: 5_000 }, (_, i) => `log ${i} ${'y'.repeat(50)}`),
      calls: [call(1, 'allowed'), call(2, 'denied', 'no')],
    };
    const out = formatRunResult(result, { overflow: store });
    expect(size(out)).toBeLessThanOrEqual(SUCCESS_CAP_CHARS);
    const body = json(out);
    expect(body).toMatchObject({ ok: true, truncated: true, calls: { denied: [{ id: 'c2', reason: 'no' }] } });
    expect(out.content[1]?.text).toMatch(/^\[\{"i":0/);
    expect(out.content[1]?.text).toMatch(/"i":19999.*\]$/);
    const logs = body['logs'] as string[];
    expect(logs[0]).toBe(`log 0 ${'y'.repeat(50)}`);
    expect(logs.at(-1)).toBe(`log 4999 ${'y'.repeat(50)}`);
    const { id } = body['overflow'] as { id: string };
    expect(readAll(store, id)).toBe(safeStringify(result));
  });

  it('keeps every distinct reason with its exact count when the denied calls do not fit one by one', () => {
    const calls = Array.from({ length: 30_000 }, (_, i) => call(i, 'denied', i % 3 === 0 ? 'rule: a' : i % 3 === 1 ? 'rule: b' : 'hook: c', i % 2 ? 'bash' : 'read'));
    const out = formatRunResult({ ...base, ok: false, error: { kind: 'denied', name: 'PermissionDenied', message: 'x' }, calls }, { overflow: new OverflowStore() });
    expect(size(out)).toBeLessThanOrEqual(ERROR_CAP_CHARS);
    const denied = (json(out)['calls'] as { denied: { tool: string; reason: string; count: number; calls: string[] }[] }).denied;
    expect(denied).toHaveLength(6);
    expect(denied.reduce((n, g) => n + g.count, 0)).toBe(30_000);
    for (const g of denied) {
      const listed = g.calls.filter((c) => !c.startsWith('…'));
      const more = Number(/^…\[(\d+) more in readOverflow\]$/.exec(g.calls.at(-1) ?? '')?.[1] ?? 0);
      expect(listed.length + more).toBe(g.count);
    }
    expect(denied.find((g) => g.tool === 'read' && g.reason === 'rule: a')?.calls[0]).toBe('read f0.txt');
  });

  it('names every denied target when a group still fits, even among allowed calls', () => {
    const calls = Array.from({ length: 1_000 }, (_, i) => (i % 2 ? call(i, 'denied', 'rule: denied by Write(./f*) from project settings', 'write') : call(i, 'allowed', undefined, 'write')));
    const body = json(formatRunResult({ ...base, calls }, { overflow: new OverflowStore() }));
    const denied = (body['calls'] as { denied: { count: number; calls: string[] }[] }).denied;
    expect(denied).toEqual([{ tool: 'write', reason: 'rule: denied by Write(./f*) from project settings', count: 500, calls: calls.filter((c) => c.decision === 'denied').map((c) => c.summary) }]);
  });

  it('marks how many reasons and calls it leaves out when even the groups do not fit', () => {
    const calls = Array.from({ length: 5_000 }, (_, i) => call(i, 'denied', `reason ${i} ${'r'.repeat(30)}`));
    const body = json(formatRunResult({ ...base, ok: false, error: { kind: 'denied', name: 'PermissionDenied', message: 'x' }, calls }, { overflow: new OverflowStore() }));
    const denied = (body['calls'] as { denied: unknown[] }).denied;
    const marker = denied.at(-1);
    expect(marker).toMatch(/^…\[\d+ more reasons \(\d+ calls\) in readOverflow\]$/);
    const shown = denied.length - 1;
    expect(marker).toContain(`${5_000 - shown} more reasons (${5_000 - shown} calls)`);
  });

  it('keeps the error and the denied count when even a clipped envelope does not fit', () => {
    const diff = Array.from({ length: 12 }, (_, i) => fileDiff(`${'d'.repeat(1_100)}/f${i}.ts`, 2)).join('');
    const out = formatRunResult(
      { ...base, ok: false, error: { kind: 'denied', name: 'PermissionDenied', message: 'transaction aborted: c3 was denied' }, calls: [call(1, 'allowed', undefined, 'write'), call(2, 'denied', 'rule: no')], diff },
      { overflow: new OverflowStore() },
    );
    expect(size(out)).toBeLessThanOrEqual(ERROR_CAP_CHARS);
    const body = json(out);
    expect(body).toMatchObject({ ok: false, error: { message: 'transaction aborted: c3 was denied' } });
    expect(JSON.stringify(body['calls'])).toContain('rule: no');
  });

  it('keeps protected changes when warnings are cut to a count and when only the last-resort envelope fits', () => {
    const window = (n: number, paths: number) => ({ call: `c${n}`, command: `bash node w${n}.js`, when: 'during' as const, changed: Array.from({ length: paths }, (_, i) => `.claude/agents/${'a'.repeat(300)}${i}.md`) });
    const warnings = Array.from({ length: 400 }, (_, i) => `warning ${i} ${'w'.repeat(200)}`);
    const tight = json(formatRunResult({ ...base, result: 'x'.repeat(60_000), warnings, protectedChanges: [window(1, 1)] }, { overflow: new OverflowStore() }));
    expect(tight['truncated']).toBe(true);
    expect(tight['protectedChanges']).toEqual([window(1, 1)]);

    const diff = Array.from({ length: 12 }, (_, i) => fileDiff(`${'d'.repeat(1_100)}/f${i}.ts`, 2)).join('');
    const protectedChanges = Array.from({ length: 40 }, (_, i) => window(i + 1, 30));
    const out = formatRunResult({ ...base, ok: false, error: { kind: 'error', name: 'Error', message: 'x' }, diff, warnings, protectedChanges }, { overflow: new OverflowStore() });
    expect(size(out)).toBeLessThanOrEqual(ERROR_CAP_CHARS);
    const kept = json(out)['protectedChanges'] as unknown[];
    expect(kept[0]).toMatchObject({ call: 'c1', changed: expect.arrayContaining([expect.stringContaining('.claude/agents/')]) });
    const shown = (kept[0] as { changed: string[] }).changed;
    expect(shown.at(-1)).toBe(`…[${30 - (shown.length - 1)} more in readOverflow]`);
    expect(kept.at(-1)).toBe(`…[${40 - (kept.length - 1)} more in readOverflow]`);

    const rolledBack = { restored: Array.from({ length: 2_000 }, (_, i) => `f${i}.txt`), skipped: [] };
    const last = formatRunResult({ ...base, ok: false, error: { kind: 'error', name: 'Error', message: 'x' }, rolledBack, protectedChanges }, { overflow: new OverflowStore() });
    expect(size(last)).toBeLessThanOrEqual(ERROR_CAP_CHARS);
    const envelope = json(last);
    expect(envelope).not.toHaveProperty('rolledBack');
    expect(envelope['protectedChanges']).toHaveLength(4);
    expect((envelope['protectedChanges'] as unknown[]).at(-1)).toBe('…[37 more in readOverflow]');
  });

  it('names no overflow when nothing could keep the result', () => {
    const body = json(formatRunResult({ ...base, result: 'x'.repeat(100_000) }));
    expect(body).toMatchObject({ truncated: true });
    expect(body).not.toHaveProperty('overflow');
  });

  it('stays under the cap with output that JSON escaping makes longer', () => {
    const out = formatRunResult({ ...base, logs: Array.from({ length: 2_000 }, () => '\u0001"\\'.repeat(20)) }, { overflow: new OverflowStore() });
    expect(size(out)).toBeLessThanOrEqual(SUCCESS_CAP_CHARS);
  });
});

describe('safeStringify', () => {
  it('keeps an object shared by two fields and marks only a real cycle', () => {
    const item = { n: 1 };
    const loop: Record<string, unknown> = { a: 1 };
    loop['self'] = loop;
    expect(JSON.parse(safeStringify({ result: [item, item], loop }))).toEqual({ result: [{ n: 1 }, { n: 1 }], loop: { a: 1, self: '[circular]' } });
  });
});

describe('diffStat', () => {
  it('counts hunk lines from the header, so a removed `--` line is not a file header', () => {
    const diff = '--- a/x.md\n+++ b/x.md\n@@ -1,2 +1,1 @@\n--- not a header\n keep\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+hi\n';
    expect(diffStat(diff)).toEqual({ files: { 'x.md': '+0 -1', 'new.txt': '+1 -0' }, total: '2 files +1 -1' });
  });

  it('takes the new name of a git header whose old and new names differ in length', () => {
    expect(Object.keys(diffStat('diff --git a/x b/longer.txt\nnew file mode 100644\n').files)).toEqual(['longer.txt']);
    expect(Object.keys(diffStat('diff --git "a/a b " "b/c d e "\nnew file mode 100644\n').files)).toEqual(['c d e ']);
  });

  it('reads renames from real git diff -M output, a space in the new path included', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'acm-gitdiff-'));
    try {
      const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'diff.mnemonicPrefix=false', '-c', 'diff.noprefix=false', ...args], { cwd: dir, encoding: 'utf8' });
      git('init', '-q');
      writeFileSync(path.join(dir, 'x'), Array.from({ length: 20 }, (_, i) => `line ${i}\n`).join(''));
      writeFileSync(path.join(dir, 'same'), 'keep\n');
      git('add', '.');
      git('commit', '-qm', 'base');
      mkdirSync(path.join(dir, 'dir b'));
      git('mv', 'x', 'dir b/file');
      writeFileSync(path.join(dir, 'dir b', 'file'), Array.from({ length: 20 }, (_, i) => `line ${i === 3 ? 'three' : i}\n`).join(''));
      git('mv', 'same', 'dir b/same copy');
      git('add', '-A');
      const diff = git('diff', '--cached', '-M', '--no-color');
      expect(diff).toContain('rename to dir b/file');
      expect(diffStat(diff).files).toEqual({ 'dir b/file': '+1 -1', 'dir b/same copy': '+0 -0' });
      git('commit', '-qm', 'renames');
      mkdirSync(path.join(dir, 'b'));
      git('mv', 'dir b/file', 'b/x');
      const pure = git('diff', '--cached', '-M', '--no-color');
      expect(pure).toContain('rename to b/x');
      expect(diffStat(pure).files).toEqual({ 'b/x': '+0 -0' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts empty new files, binary files and quoted names', () => {
    const diff = [
      ...Array.from({ length: 50 }, (_, i) => unifiedDiff(`empty-file-${i}`, null, '')),
      binaryDiff('img.png', false),
      unifiedDiff('a b ', 'x\n', 'y\n'),
    ].join('');
    const stat = diffStat(diff);
    expect(stat.total).toBe('52 files +1 -1');
    expect(stat.files['empty-file-0']).toBe('+0 -0');
    expect(diffStat(unifiedDiff('a b ', 'x\n', 'y\n')).files).toEqual({ 'a b ': '+1 -1' });
  });
});
