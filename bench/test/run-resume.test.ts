// The resume dry runs of main(), apart from run.test.ts so that Vitest runs them in their own process.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
  }, 300_000); // End to end through main(): on Windows it competes for the CPU with the other test files.
});
