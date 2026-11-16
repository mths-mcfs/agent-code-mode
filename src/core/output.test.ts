import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CHANGED_FILES_SHOWN, DIFF_INLINE_CHARS, DIFF_SAMPLE_CHARS, ERROR_CAP_CHARS, FAILED_CALLS_SHOWN, SUCCESS_CAP_CHARS, compactRunResult, formatRunResult, truncateStructurally } from './output.js';
import { stateDirPath } from './state-dir.js';
import type { CallLogEntry, RunResult } from './types.js';

const base: RunResult = { ok: true, result: null, logs: [], calls: [], changedFiles: [], diff: '', warnings: [] };
const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), 'acm-out-'));
  dirs.push(d);
  return path.join(d, 'state');
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const allowed = (i: number, tool = 'read'): CallLogEntry => ({ id: `c${i}`, tool, summary: `${tool} f${i}.txt`, decision: 'allowed', durationMs: 2 });

describe('compactRunResult', () => {
  it('turns the call log into counts and keeps denied and failed calls in full, without durations', () => {
    const calls: CallLogEntry[] = [
      allowed(1),
      allowed(2, 'write'),
      { id: 'c3', tool: 'bash', summary: 'bash rm x', decision: 'denied', reason: 'rule: rm is not allowed', durationMs: 9 },
      { id: 'c4', tool: 'read', summary: 'read gone.txt', decision: 'error', reason: 'gone.txt does not exist', durationMs: 1 },
      allowed(5),
    ];
    expect(compactRunResult({ ...base, calls }).view['calls']).toEqual({
      total: 5,
      byTool: { read: 3, write: 1, bash: 1 },
      denied: [{ id: 'c3', tool: 'bash', summary: 'bash rm x', reason: 'rule: rm is not allowed' }],
      errors: [{ id: 'c4', tool: 'read', summary: 'read gone.txt', reason: 'gone.txt does not exist' }],
    });
  });

  it('does not grow with the number of allowed calls and caps the list of failed ones', () => {
    const few = JSON.stringify(compactRunResult({ ...base, calls: Array.from({ length: 3 }, (_, i) => allowed(i)) }).view);
    const many = JSON.stringify(compactRunResult({ ...base, calls: Array.from({ length: 3_000 }, (_, i) => allowed(i)) }).view);
    expect(many.length).toBeLessThan(few.length + 10);
    const denied = Array.from({ length: FAILED_CALLS_SHOWN + 7 }, (_, i): CallLogEntry => ({ ...allowed(i, 'bash'), decision: 'denied', reason: 'no' }));
    const shown = (compactRunResult({ ...base, calls: denied }).view['calls'] as { denied: unknown[] }).denied;
    expect(shown).toHaveLength(FAILED_CALLS_SHOWN + 1);
    expect(shown.at(-1)).toBe('…[7 more]');
  });

  it('leaves out empty fields and keeps the result, error, logs, warnings and rollback report', () => {
    expect(Object.keys(compactRunResult({ ...base, result: 1 }).view).sort()).toEqual(['calls', 'ok', 'result']);
    const rolledBack = { restored: ['a.txt'], skipped: [] };
    const failed: RunResult = { ...base, ok: false, error: { kind: 'denied', name: 'PermissionDenied', message: 'm' }, logs: ['l'], warnings: ['w'], rolledBack };
    expect(compactRunResult(failed).view).toEqual({ ok: false, result: null, error: failed.error, logs: ['l'], calls: { total: 0, byTool: {} }, warnings: ['w'], rolledBack });
  });

  it('returns a small diff whole and cuts a large one at a line end', () => {
    const small = 'x'.repeat(DIFF_INLINE_CHARS - 1) + '\n';
    expect(compactRunResult({ ...base, diff: small })).toMatchObject({ diffClipped: false, view: { diff: small } });
    const line = '+0123456789\n';
    const large = line.repeat(Math.ceil((DIFF_INLINE_CHARS + 1) / line.length));
    const { view, diffClipped } = compactRunResult({ ...base, diff: large });
    const shown = String(view['diff']);
    expect(diffClipped).toBe(true);
    const kept = shown.slice(0, shown.indexOf('…['));
    expect(kept.length).toBeLessThanOrEqual(DIFF_SAMPLE_CHARS);
    expect(kept.endsWith(line)).toBe(true);
    expect(large.startsWith(kept)).toBe(true);
    expect(shown).toContain(`…[${large.length - kept.length} more chars; overflowPath has the whole result]`);
  });

  it('caps a long list of changed files', () => {
    const changedFiles = Array.from({ length: CHANGED_FILES_SHOWN + 5 }, (_, i) => `f${i}.txt`);
    const shown = compactRunResult({ ...base, changedFiles }).view['changedFiles'] as string[];
    expect(shown).toEqual([...changedFiles.slice(0, CHANGED_FILES_SHOWN), '…[5 more]']);
  });
});

describe('formatRunResult', () => {
  it('returns the whole result when verbose', async () => {
    const result: RunResult = { ...base, calls: [allowed(1), allowed(2)], diff: 'd'.repeat(DIFF_INLINE_CHARS + 1) };
    const out = await formatRunResult(result, { stateDir: await tmp(), verbose: true });
    expect(JSON.parse(out.content[0]?.text ?? '')).toEqual(result);
  });

  it('saves the whole result when the compact view cut the diff, and points to the file', async () => {
    const stateDir = await tmp();
    const result: RunResult = { ...base, result: 'done', calls: [allowed(1, 'write')], changedFiles: ['a.txt'], diff: '+line\n'.repeat(2_000) };
    const out = await formatRunResult(result, { stateDir });
    const shown = JSON.parse(out.content[0]?.text ?? '') as { diff: string; overflowPath: string; truncated?: boolean };
    expect(shown.truncated).toBeUndefined();
    expect(shown.diff.length).toBeLessThan(DIFF_SAMPLE_CHARS + 90);
    expect(shown.diff).toContain('overflowPath');
    expect(JSON.parse(await readFile(shown.overflowPath, 'utf8'))).toEqual(result);
  });


  it('returns compact JSON and isError', async () => {
    const ok = await formatRunResult({ ...base, result: { a: 1 } }, { stateDir: await tmp() });
    expect(ok.isError).toBe(false);
    expect(JSON.parse(ok.content[0]?.text ?? '')).toMatchObject({ ok: true, result: { a: 1 } });
    const err = await formatRunResult({ ...base, ok: false, error: { kind: 'error', name: 'Error', message: 'x' } }, { stateDir: await tmp() });
    expect(err.isError).toBe(true);
  });

  it('writes oversized success results to an overflow file and returns a valid preview', async () => {
    const stateDir = await tmp();
    const big: RunResult = { ...base, result: { text: 'x'.repeat(100_000), list: Array.from({ length: 5_000 }, (_, i) => i) }, diff: 'd'.repeat(50_000) };
    const out = await formatRunResult(big, { stateDir });
    const text = out.content[0]?.text ?? '';
    expect(text.length).toBeLessThanOrEqual(SUCCESS_CAP_CHARS);
    const preview = JSON.parse(text) as { overflowPath: string; truncated: boolean; ok: boolean };
    expect(preview.truncated).toBe(true);
    expect(preview.ok).toBe(true);
    const full: unknown = JSON.parse(await readFile(preview.overflowPath, 'utf8'));
    expect(full).toEqual(JSON.parse(JSON.stringify(big)));
    if (process.platform !== 'win32') {
      expect((await stat(preview.overflowPath)).mode & 0o777).toBe(0o600);
      expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
    }
  });

  it('caps error results lower', async () => {
    const big: RunResult = { ...base, ok: false, error: { kind: 'error', name: 'Error', message: 'm'.repeat(20_000) }, logs: ['l'.repeat(20_000)] };
    const out = await formatRunResult(big, { stateDir: await tmp() });
    const text = out.content[0]?.text ?? '';
    expect(text.length).toBeLessThanOrEqual(ERROR_CAP_CHARS);
    expect(JSON.parse(text)).toMatchObject({ ok: false, truncated: true, error: { name: 'Error' } });
  });

  it('still returns a preview when the overflow file cannot be written', async () => {
    const big: RunResult = { ...base, result: 'x'.repeat(60_000) };
    const out = await formatRunResult(big, { stateDir: '\0invalid' });
    const preview = JSON.parse(out.content[0]?.text ?? '') as Record<string, unknown>;
    expect(preview['overflowPath']).toBeUndefined();
    expect(String(preview['note'])).toContain('could not be saved');
  });
});

describe('truncateStructurally', () => {
  it('always returns valid JSON within the cap', () => {
    const deep: Record<string, unknown> = {};
    let cur = deep;
    for (let i = 0; i < 50; i++) {
      const next: Record<string, unknown> = { s: 'y'.repeat(1_000) };
      cur['n'] = next;
      cur = next;
    }
    for (const cap of [40, 200, 1_000, 5_000]) {
      const text = truncateStructurally({ ok: true, deep, arr: new Array(1000).fill('z'.repeat(100)) }, cap, { overflowPath: '/state/x.json' });
      expect(text.length).toBeLessThanOrEqual(cap);
      expect(() => JSON.parse(text)).not.toThrow();
    }
  });
});

describe('truncateStructurally with wide objects', () => {
  it('cuts objects with many keys instead of dropping everything', () => {
    const wide = Object.fromEntries(Array.from({ length: 50_000 }, (_, i) => [`k${i}`, i]));
    const text = truncateStructurally({ ok: true, result: wide }, 30_000);
    const parsed = JSON.parse(text) as { result: Record<string, unknown> };
    expect(text.length).toBeLessThanOrEqual(30_000);
    expect(parsed.result['k0']).toBe(0);
  });
});

describe('stateDirPath', () => {
  it('uses an absolute XDG_STATE_HOME, else ~/.local/state', () => {
    expect(stateDirPath({ XDG_STATE_HOME: '/x/state' }, '/home/u')).toBe(path.join('/x/state', 'agent-code-mode'));
    expect(stateDirPath({ XDG_STATE_HOME: 'relative' }, '/home/u')).toBe(path.join('/home/u', '.local', 'state', 'agent-code-mode'));
    expect(stateDirPath({}, '/home/u')).toBe(path.join('/home/u', '.local', 'state', 'agent-code-mode'));
  });
});
