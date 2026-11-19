// The per-task verifier cases from T12 on. The verifier cases are split across files so that Vitest runs them in parallel processes.
import { describe, expect, it } from 'vitest';
import { TASKS } from '../tasks/index.ts';
import { TASK_IDS } from '../tasks/types.ts';
import { verifierWorkspaces } from './verifier-workspaces.ts';

const { workspace } = await verifierWorkspaces();

describe.each(TASK_IDS.slice(11))('verifier %s', (id) => {
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
