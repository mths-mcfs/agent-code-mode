import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_FIXTURE_SEED, generateFixture, treeHash, writeTree } from '../fixture/generate.ts';
import { runNodeTests } from '../tasks/checks.ts';

/** Hash of the default fixture. If this changes, every published number changes meaning: bump it on purpose only. */
const DEFAULT_FIXTURE_HASH = 'e8aee80fe0d34c5a38561d74cc1d850800ae134bc59ef55fe5cb3bb1a5e0c521';

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe('fixture generator', () => {
  it('is byte-identical for the same seed', () => {
    const a = generateFixture();
    const b = generateFixture(DEFAULT_FIXTURE_SEED);
    expect(treeHash(a.files)).toBe(treeHash(b.files));
    expect(treeHash(a.files)).toBe(DEFAULT_FIXTURE_HASH);
    expect(a.facts).toEqual(b.facts);
  });

  it('changes with the seed', () => {
    expect(treeHash(generateFixture(7).files)).not.toBe(DEFAULT_FIXTURE_HASH);
  });

  it('has the shape the tasks rely on', () => {
    const { files, facts } = generateFixture();
    expect(files.size).toBeGreaterThanOrEqual(60);
    expect(files.size).toBeLessThanOrEqual(100);
    expect(facts.orderFiles).toHaveLength(50);
    expect(facts.paidOrderFiles).toHaveLength(40);
    expect(facts.handlerFiles).toHaveLength(10);
    expect(facts.handlerFiles).toContain(facts.protectedFile);
    expect(facts.renameFiles.length).toBeGreaterThanOrEqual(28);
    expect(facts.renameFiles.length).toBeLessThanOrEqual(32);
    const top = facts.customerTotals.slice(0, 4).map((c) => c.totalCents);
    expect(new Set(top).size).toBe(4);
    expect(JSON.parse(files.get('config/app.json') ?? '{}').service.retryLimit).toBe(facts.retryLimit);
    for (const text of files.values()) expect(text).not.toContain('\r');
  });

  it('writes a project whose tests pass under node --test', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'acm-fixture-'));
    dirs.push(dir);
    await writeTree(dir, generateFixture().files);
    const run = await runNodeTests(dir);
    expect(run.ok).toBe(true);
    expect(run.pass).toBe(13);
    expect(run.fail).toBe(0);
  });
});
