import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { main } from '../run.ts';
import { TASKS } from '../tasks/index.ts';
import { quiet } from './quiet.ts';

let work: string;
let args: string[];

beforeEach(async () => {
  work = await mkdtemp(path.join(os.tmpdir(), 'acm-exit-'));
  args = ['--dry-run', '--host', 'claude', '--arms', 'A', '--tasks', 'T1', '--runs', '1', '--seed', '1', '--work-dir', work, '--out', path.join(work, 'results'), '--date', '2026-01-04'];
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(work, { recursive: true, force: true });
});

async function recordFile(): Promise<string> {
  const dir = path.join(work, 'results', '2026-01-04');
  // The warm-up run keeps its own record under warmup/.
  const found = (await readdir(dir, { recursive: true })).filter((f) => f.endsWith('record.json') && !f.startsWith('warmup'));
  expect(found).toHaveLength(1);
  return path.join(dir, found[0] ?? '');
}

describe('exit code', () => {
  it('is 0 when every planned run passes and is valid', async () => {
    expect((await quiet(() => main(args))).value).toBe(0);
  }, 120_000);

  it('is 1 when a reference answer is off by one', async () => {
    const solve = TASKS.T1.solution;
    vi.spyOn(TASKS.T1, 'solution').mockImplementation(async (ws, facts) => (await solve(ws, facts)).replace(`ANSWER: ${facts.retryLimit}`, `ANSWER: ${facts.retryLimit + 1}`));
    const r = await quiet(() => main(args));
    expect(r.value).toBe(1);
    expect(r.errors).toMatch(/claude-T1-A-r1: dry run failed verification/);
  }, 120_000);

  it('is 1 when a reference answer is off by one on arm D (Claude Code Mode)', async () => {
    const solve = TASKS.T1.solution;
    vi.spyOn(TASKS.T1, 'solution').mockImplementation(async (ws, facts) => (await solve(ws, facts)).replace(`ANSWER: ${facts.retryLimit}`, `ANSWER: ${facts.retryLimit + 1}`));
    const r = await quiet(() => main(args.map((a) => (a === 'A' ? 'D' : a))));
    expect(r.value).toBe(1);
    expect(r.errors).toMatch(/claude-T1-D-r1: dry run failed verification/);
  }, 120_000);

  it('is 1 when a planned run leaves no record', async () => {
    vi.spyOn(TASKS.T1, 'solution').mockRejectedValue(new Error('solution crashed'));
    const r = await quiet(() => main(args));
    expect(r.value).toBe(1);
    expect(r.errors).toMatch(/claude-T1-A-r1: no usable record/);
  }, 120_000);

  it('is 1 when a forced rerun fails over a good record', async () => {
    expect((await quiet(() => main(args))).value).toBe(0);
    vi.spyOn(TASKS.T1, 'solution').mockRejectedValue(new Error('solution crashed'));
    const r = await quiet(() => main([...args, '--force']));
    expect(r.value).toBe(1);
    expect(r.errors).toMatch(/claude-T1-A-r1: no usable record/);
  }, 120_000);

  it('is 1 when a recorded run it resumes is invalid', async () => {
    expect((await quiet(() => main(args))).value).toBe(0);
    const file = await recordFile();
    const record = z.looseObject({}).parse(JSON.parse(await readFile(file, 'utf8')));
    await writeFile(file, JSON.stringify({ ...record, valid: false, invalidReasons: ['tool surface not observed'] }));
    const r = await quiet(() => main(args));
    expect(r.text).toMatch(/^skip claude-T1-A-r1/m);
    expect(r.value).toBe(1);
    expect(r.errors).toMatch(/claude-T1-A-r1: dry run invalid: tool surface not observed/);
  }, 120_000);

  it('is 2, with that as the only error, before any host call when arm D has no credentials file to copy', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', work);
    try {
      // --host all: the Claude and Codex version and catalog calls come after this check.
      const r = await quiet(() => main(args.filter((a) => a !== '--dry-run' && a !== 'claude' && a !== '--host').map((a) => (a === 'A' ? 'B,D' : a))));
      expect(r.value).toBe(2);
      expect(r.errors.trim()).toMatch(/^arm D \(Claude Code Mode\) needs .*\.credentials\.json to copy into a temporary config dir$/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('is 2 before any host call when a real agent-code-mode arm is planned on Windows', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const r = await quiet(() => main(args.filter((a) => a !== '--dry-run').map((a) => (a === 'A' ? 'B' : a))));
      expect(r.value).toBe(2);
      expect(r.errors).toMatch(/agent-code-mode arms do not run on Windows/);
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
  });
});
