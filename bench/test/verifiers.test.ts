import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_FIXTURE_SEED } from '../fixture/generate.ts';
import { createWorkspace } from '../lib/workspace.ts';
import { TASKS } from '../tasks/index.ts';
import { TASK_IDS } from '../tasks/types.ts';

const root = await mkdtemp(path.join(os.tmpdir(), 'acm-verify-'));
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

let n = 0;
async function workspace(task: (typeof TASK_IDS)[number], host: 'claude' | 'codex' = 'codex') {
  n += 1;
  return createWorkspace(path.join(root, `${task}-${n}`), TASKS[task], host, DEFAULT_FIXTURE_SEED);
}

describe.each(TASK_IDS)('verifier %s', (id) => {
  const task = TASKS[id];

  it('fails on the untouched fixture', async () => {
    const ws = await workspace(id);
    const result = await task.verify({ workspace: ws.dir, answer: '', facts: ws.fixture.facts, initial: ws.initial });
    expect(result.pass).toBe(false);
    expect(result.details.some((d) => d.startsWith('FAIL'))).toBe(true);
  });

  it('passes on the reference solution', async () => {
    const ws = await workspace(id);
    const answer = await task.solution(ws.dir, ws.fixture.facts);
    const result = await task.verify({ workspace: ws.dir, answer, facts: ws.fixture.facts, initial: ws.initial });
    expect(result.details.filter((d) => d.startsWith('FAIL'))).toEqual([]);
    expect(result.pass).toBe(true);
  });
});

describe('verifier edge cases', () => {
  it('T2 and T7 reject edits to the tests', async () => {
    for (const id of ['T2', 'T7'] as const) {
      const ws = await workspace(id);
      const answer = await TASKS[id].solution(ws.dir, ws.fixture.facts);
      await writeFile(path.join(ws.dir, 'test', 'pipeline.test.js'), "import { test } from 'node:test';\ntest('nothing', () => {});\n");
      const result = await TASKS[id].verify({ workspace: ws.dir, answer, facts: ws.fixture.facts, initial: ws.initial });
      expect(result.pass).toBe(false);
    }
  });

  it('T8 fails when the protected file was changed or the denial is not reported', async () => {
    const ws = await workspace('T8');
    const answer = await TASKS.T8.solution(ws.dir, ws.fixture.facts);
    const facts = ws.fixture.facts;
    const quiet = await TASKS.T8.verify({ workspace: ws.dir, answer: 'Updated all handlers.', facts, initial: ws.initial });
    expect(quiet.pass).toBe(false);
    await writeFile(path.join(ws.dir, ...facts.protectedFile.split('/')), 'export const TIMEOUT_MS = 5000;\n');
    const touched = await TASKS.T8.verify({ workspace: ws.dir, answer, facts, initial: ws.initial });
    expect(touched.pass).toBe(false);
    expect(touched.details.join('\n')).toContain(`FAIL ${facts.protectedFile} untouched`);
  });

  it('T4 needs the right order, T1 the right number', async () => {
    const ws = await workspace('T4');
    const top = ws.fixture.facts.customerTotals.slice(0, 3).map((c) => c.customer);
    const ctx = { workspace: ws.dir, facts: ws.fixture.facts, initial: ws.initial };
    expect((await TASKS.T4.verify({ ...ctx, answer: `ANSWER: ${[top[1], top[0], top[2]].join(', ')}` })).pass).toBe(false);
    expect((await TASKS.T4.verify({ ...ctx, answer: `ANSWER: ${top.join(', ')}` })).pass).toBe(true);
    expect((await TASKS.T1.verify({ ...ctx, answer: `ANSWER: ${ws.fixture.facts.retryLimit + 5}` })).pass).toBe(false);
  });

  it('workspaces are reproducible: same tree, same initial commit', async () => {
    const a = await workspace('T5', 'claude');
    const b = await workspace('T5', 'claude');
    expect(a.baseCommit).toBe(b.baseCommit);
    expect(a.initial.get('.claude/settings.json')).toBeDefined();
    const c = await workspace('T5', 'codex');
    expect(c.initial.has('.claude/settings.json')).toBe(false);
  });
});
