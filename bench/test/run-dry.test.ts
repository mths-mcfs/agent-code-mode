// The end-to-end dry run of main(), apart from run.test.ts so that Vitest runs them in their own process.
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../run.ts';

describe('dry run', () => {
  it('runs end to end, writes a summary and resumes without redoing runs', async () => {
    const work = await mkdtemp(path.join(os.tmpdir(), 'acm-dry-'));
    const out = path.join(work, 'results');
    const args = ['--dry-run', '--tasks', 'T1,T8', '--runs', '1', '--seed', '3', '--work-dir', work, '--out', out, '--date', '2026-01-02'];
    const writes: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(await main(args)).toBe(0);
      expect(await main(args)).toBe(0);
    } finally {
      process.stdout.write = orig;
    }
    const text = writes.join('');
    expect(text.match(/^(claude|codex) T\d+ \w+ r1: pass, valid/gm)).toHaveLength(14);
    // One warmup per host x arm before the matrix; none on the resume, which has nothing left to run.
    expect(text.match(/^warmup (claude|codex) T1 \w+ r1: pass, valid/gm)).toHaveLength(7);
    expect(text.match(/^skip /gm)).toHaveLength(14);
    const summary = JSON.parse(await readFile(path.join(out, '2026-01-02', 'summary.json'), 'utf8'));
    expect(summary.dryRun).toBe(true);
    expect(summary.groups).toHaveLength(14);
    expect(summary.warmup.runs).toBe(7);
    expect(text).toMatch(/Warmup: 7 run\(s\)/);
    // No copy of an auth file may survive a run.
    const left = (await readdir(path.join(work, 'runs'), { recursive: true })).filter((f) => f.endsWith('auth.json'));
    expect(left).toEqual([]);
    await rm(work, { recursive: true, force: true });
  }, 300_000); // End to end through main(): on Windows it competes for the CPU with the other test files.
});
