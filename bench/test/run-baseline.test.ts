// The baseline build arm dry runs of main(), apart from run.test.ts so that Vitest runs them in their own process.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { main, REPO_ROOT, resolveBaseline } from '../run.ts';
import { quiet } from './quiet.ts';

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
      expect(r.value, r.errors).toBe(0);
      expect(r.text.match(/^claude T\d B0 r\d: pass, valid/gm)).toHaveLength(6);
      const summary = JSON.parse(await readFile(path.join(out, '2026-01-04', 'summary.json'), 'utf8'));
      const builds = new Set(summary.groups.filter((g: { arm: string }) => g.arm !== 'A').map((g: { arm: string; config: { acmBuild: string } }) => `${g.arm}:${g.config.acmBuild}`));
      expect([...builds].sort()).toEqual(expect.arrayContaining(['B:checkout', 'C:checkout', expect.stringMatching(/^B0:dist:[0-9a-f]{12}$/)]));
      // A baseline cell carries its build, so runs of two builds would never share one.
      const b0 = (summary.arms as { arm: string }[]).map((a) => a.arm).find((a) => a.startsWith('B0@')) ?? '';
      expect(b0).toMatch(/^B0@dist:[0-9a-f]{12}$/);
      expect(summary.comparisons.map((c: { arm: string; reference: string }) => `${c.arm}-${c.reference}`).sort()).toEqual(['B-A', `B-${b0}`, `${b0}-A`, 'C-A']);
      // Canned transcripts: B and B0 are identical, so the cost difference is exactly 0 and the interval says so.
      const bb0 = summary.comparisons.find((c: { arm: string; reference: string }) => c.arm === 'B' && c.reference === b0);
      expect(bb0.costUsd).toMatchObject({ estimate: 0, lo: 0, hi: 0, crossesZero: true, tasks: 3 });
      expect(r.text).toMatch(/\| B vs B0@dist:[0-9a-f]{12} \| 3 \|.*CI crosses 0/);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }, 300_000); // End to end through main(): on Windows it competes for the CPU with the other test files.

  it('reuses a cached --acm-ref build only while its package-lock.json matches the checkout\'s', async () => {
    const work = await mkdtemp(path.join(os.tmpdir(), 'acm-cached-'));
    try {
      const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
      const dir = path.join(work, 'acm-builds', commit);
      await mkdir(path.join(dir, 'dist'), { recursive: true });
      await writeFile(path.join(dir, 'dist', 'cli.js'), '');
      await writeFile(path.join(dir, '.built'), `${commit}\n`);
      const opts = { acmRef: 'HEAD', acmDist: undefined, dryRun: false };
      // The checkout's dependencies moved on after the build was made.
      await writeFile(path.join(dir, 'package-lock.json'), '{"lockfileVersion": 3, "packages": {}}\n');
      await expect(resolveBaseline(opts, work)).rejects.toThrow(/package-lock\.json differs from this checkout's/);
      await writeFile(path.join(dir, 'package-lock.json'), await readFile(path.join(REPO_ROOT, 'package-lock.json')));
      await expect(resolveBaseline(opts, work)).resolves.toMatchObject({ id: `ref:${commit.slice(0, 12)}`, entry: path.join(dir, 'dist', 'cli.js') });
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

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
  }, 300_000); // End to end through main(): on Windows it competes for the CPU with the other test files.
});
