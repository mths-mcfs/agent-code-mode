import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ERROR_CAP_CHARS, SUCCESS_CAP_CHARS, formatRunResult, truncateStructurally } from './output.js';
import { stateDirPath } from './state-dir.js';
import type { RunResult } from './types.js';

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

describe('formatRunResult', () => {
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
