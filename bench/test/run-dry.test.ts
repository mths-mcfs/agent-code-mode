// End-to-end dry runs of main(), apart from run.test.ts so that Vitest runs them in their own process.
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../run.ts';
import { quiet } from './quiet.ts';

describe('resume', () => {
  it('reruns instead of skipping when the config changed, and keeps both apart in the report', async () => {
    const work = await mkdtemp(path.join(os.tmpdir(), 'acm-resume-'));
    const out = path.join(work, 'results');
    const base = ['--dry-run', '--host', 'claude', '--arms', 'A', '--tasks', 'T1', '--runs', '1', '--work-dir', work, '--out', out, '--date', '2026-01-03'];
    try {
      const first = await quiet(() => main([...base, '--seed', '1']));
      expect(first.text).toMatch(/claude T1 A r1: pass, valid/);
      // Same config without --seed: the seed of the last invocation is reused, so the run is skipped.
      expect((await quiet(() => main(base))).text).toMatch(/^skip claude-T1-A-r1/m);
      for (const change of [['--claude-model', 'claude-haiku-5-5'], ['--seed', '2'], ['--claude-effort', 'high'], ['--fixture-seed', '999']]) {
        const args = change[0] === '--seed' ? [...base, ...change] : [...base, '--seed', '1', ...change];
        const r = await quiet(() => main(args));
        expect(r.text, change.join(' ')).not.toMatch(/^skip /m);
        expect(r.text).toMatch(/claude T1 A r1: pass, valid/);
      }
      const summary = JSON.parse(await readFile(path.join(out, '2026-01-03', 'summary.json'), 'utf8'));
      const hashes = summary.groups.map((g: { configHash: string }) => g.configHash);
      expect(new Set(hashes).size).toBe(5);
      expect(summary.groups.every((g: { runs: number }) => g.runs === 1)).toBe(true);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }, 120_000);
});

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
    expect(text.match(/^(claude|codex) T\d+ \w+ r1: pass, valid/gm)).toHaveLength(12);
    // One warmup per host x arm before the matrix; none on the resume, which has nothing left to run.
    expect(text.match(/^warmup (claude|codex) T1 \w+ r1: pass, valid/gm)).toHaveLength(6);
    expect(text.match(/^skip /gm)).toHaveLength(12);
    const summary = JSON.parse(await readFile(path.join(out, '2026-01-02', 'summary.json'), 'utf8'));
    expect(summary.dryRun).toBe(true);
    expect(summary.groups).toHaveLength(12);
    expect(summary.warmup.runs).toBe(6);
    expect(text).toMatch(/Warmup: 6 run\(s\)/);
    // No copy of an auth file may survive a run.
    const left = (await readdir(path.join(work, 'runs'), { recursive: true })).filter((f) => f.endsWith('auth.json'));
    expect(left).toEqual([]);
    await rm(work, { recursive: true, force: true });
  }, 120_000);
});

describe('baseline build arm', () => {
  it('runs B0 next to B in the same matrix and compares them', async () => {
    const work = await mkdtemp(path.join(os.tmpdir(), 'acm-base-'));
    const out = path.join(work, 'results');
    const dist = path.join(work, 'old-dist');
    await mkdir(dist, { recursive: true });
    await writeFile(path.join(dist, 'cli.js'), '// a stand-in build\n');
    const args = ['--dry-run', '--host', 'claude', '--tasks', 'T1,T2,T3', '--runs', '2', '--seed', '5', '--work-dir', work, '--out', out, '--date', '2026-01-04'];
    try {
      expect((await quiet(() => main([...args, '--arms', 'B0']))).value).toBe(2);
      const r = await quiet(() => main([...args, '--acm-dist', dist]));
      expect(r.value).toBe(0);
      expect(r.text.match(/^claude T\d B0 r\d: pass, valid/gm)).toHaveLength(6);
      const summary = JSON.parse(await readFile(path.join(out, '2026-01-04', 'summary.json'), 'utf8'));
      const builds = new Set(summary.groups.filter((g: { arm: string }) => g.arm !== 'A').map((g: { arm: string; config: { acmBuild: string } }) => `${g.arm}:${g.config.acmBuild}`));
      expect([...builds].sort()).toEqual(expect.arrayContaining(['B:checkout', 'C:checkout', expect.stringMatching(/^B0:dist:[0-9a-f]{12}$/)]));
      expect(summary.comparisons.map((c: { arm: string; reference: string }) => `${c.arm}-${c.reference}`).sort()).toEqual(['B-A', 'B-B0', 'B0-A', 'C-A']);
      // Canned transcripts: B and B0 are identical, so the cost difference is exactly 0 and the interval says so.
      const bb0 = summary.comparisons.find((c: { arm: string; reference: string }) => c.arm === 'B' && c.reference === 'B0');
      expect(bb0.costUsd).toMatchObject({ estimate: 0, lo: 0, hi: 0, crossesZero: true, tasks: 3 });
      expect(r.text).toMatch(/\| B vs B0 \| 3 \|.*CI crosses 0/);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }, 120_000);

  it('resolves --acm-ref to a commit of this repository', async () => {
    const work = await mkdtemp(path.join(os.tmpdir(), 'acm-ref-'));
    try {
      const r = await quiet(() => main(['--dry-run', '--host', 'claude', '--arms', 'B0', '--tasks', 'T1', '--runs', '1', '--seed', '1', '--work-dir', work, '--out', path.join(work, 'r'), '--date', '2026-01-05', '--acm-ref', 'HEAD']));
      expect(r.value).toBe(0);
      const env = JSON.parse(await readFile(path.join(work, 'r', '2026-01-05', 'env.json'), 'utf8'));
      expect(env.invocations[0].baseline.id).toMatch(/^ref:[0-9a-f]{12}$/);
      expect((await quiet(() => main(['--dry-run', '--host', 'claude', '--tasks', 'T1', '--runs', '1', '--work-dir', work, '--acm-ref', 'no-such-ref-xyz']))).value).toBe(2);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }, 120_000);
});
