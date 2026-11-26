import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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
  }, 300_000); // End to end through main(): on Windows it competes for the CPU with the other test files.

  it('puts runs made with and without a Claude credentials file in two cohorts, never in one cell', async () => {
    const work = await mkdtemp(path.join(os.tmpdir(), 'acm-cohort-'));
    const out = path.join(work, 'results');
    const withCredentials = path.join(work, 'config-with');
    await mkdir(withCredentials);
    await writeFile(path.join(withCredentials, '.credentials.json'), '{}');
    const args = ['--dry-run', '--host', 'claude', '--arms', 'B,D', '--tasks', 'T1,T2', '--runs', '1', '--seed', '1', '--work-dir', work, '--out', out, '--date', '2026-01-05'];
    try {
      for (const dir of [withCredentials, path.join(work, 'config-without')]) {
        vi.stubEnv('CLAUDE_CONFIG_DIR', dir);
        expect((await quiet(() => main(args))).value).toBe(0);
      }
      const summary = JSON.parse(await readFile(path.join(out, '2026-01-05', 'summary.json'), 'utf8'));
      expect(summary.groups).toHaveLength(8);
      const cohorts = new Set(summary.arms.map((a: { cohort: string }) => a.cohort));
      expect(cohorts.size).toBe(2);
      expect(summary.arms.every((a: { validRuns: number; tasks: number }) => a.validRuns === 2 && a.tasks === 2)).toBe(true);
      expect(summary.comparisons.map((c: { cohort: string; arm: string; reference: string }) => `${c.arm}-${c.reference}`)).toEqual(['D-B', 'D-B']);
      // The isolation method is what differs, and it is a cohort fact: the arm definition stays the same.
      const defs = new Set(summary.groups.filter((g: { arm: string; task: string }) => g.arm === 'B' && g.task === 'T1').map((g: { config: { armDefinitionSha256: string } }) => g.config.armDefinitionSha256));
      expect(defs.size).toBe(1);
    } finally {
      vi.unstubAllEnvs();
      await rm(work, { recursive: true, force: true });
    }
  }, 300_000);
});
