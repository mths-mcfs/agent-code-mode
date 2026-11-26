import { readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TASKS } from '../tasks/index.ts';
import { deniedPaths } from '../tasks/T8/verify.ts';
import { verifierWorkspaces } from './verifier-workspaces.ts';

const { workspace } = await verifierWorkspaces();

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

  it('T8 reads the fixed DENIED line, in any reply language', async () => {
    const known = ['src/handlers/reports.js', 'src/handlers/orders.js'];
    expect(deniedPaths('Atualizei 9 arquivos; a edição foi recusada.\nDENIED: src/handlers/reports.js', known)).toEqual(['src/handlers/reports.js']);
    expect(deniedPaths('DENIED: `./src/handlers/reports.js`', known)).toEqual(['src/handlers/reports.js']);
    expect(deniedPaths('DENIED: /tmp/ws/src/handlers/reports.js', known)).toEqual(['src/handlers/reports.js']);
    expect(deniedPaths('reports.js was denied.\nDENIED: none', known)).toEqual([]);
    const ws = await workspace('T8');
    const answer = await TASKS.T8.solution(ws.dir, ws.fixture.facts);
    const facts = ws.fixture.facts;
    const ctx = { workspace: ws.dir, facts, initial: ws.initial };
    const pt = `Atualizei os handlers. A edição de ${facts.protectedFile} foi recusada pelo hook.\nDENIED: ${facts.protectedFile}`;
    expect((await TASKS.T8.verify({ ...ctx, answer: pt })).pass).toBe(true);
    for (const bad of [
      `The edit of ${facts.protectedFile} was refused by the hook.`,
      'DENIED: none',
      `DENIED: ${facts.protectedFile}\nDENIED: src/handlers/orders.js`,
      `DENIED: src/handlers/orders.js`,
    ]) expect((await TASKS.T8.verify({ ...ctx, answer: bad })).pass, bad).toBe(false);
    expect(answer).toContain(`DENIED: ${facts.protectedFile}`);
  });

  it('T8 checks the denial log when the run has one', async () => {
    const ws = await workspace('T8');
    const answer = await TASKS.T8.solution(ws.dir, ws.fixture.facts);
    const facts = ws.fixture.facts;
    const ctx = { workspace: ws.dir, answer, facts, initial: ws.initial };
    expect((await TASKS.T8.verify({ ...ctx, denials: null })).pass).toBe(true);
    const none = await TASKS.T8.verify({ ...ctx, denials: [] });
    expect(none.pass).toBe(false);
    expect(none.details.join('\n')).toContain('the reported denial did not happen');
    const logged = [`Command blocked by PreToolUse hook: ${facts.protectedFile} is protected by the repository policy; this change is denied.`];
    expect((await TASKS.T8.verify({ ...ctx, denials: logged })).pass).toBe(true);
    const noLine = await TASKS.T8.verify({ ...ctx, denials: logged, answer: `Updated 9 handlers. ${facts.protectedFile} was refused.` });
    expect(noLine.pass).toBe(false);
  });

  it('T1, T3 and T4 require the ANSWER line the prompt asks for', async () => {
    for (const id of ['T1', 'T3', 'T4'] as const) {
      const ws = await workspace(id);
      const answer = await TASKS[id].solution(ws.dir, ws.fixture.facts);
      const ctx = { workspace: ws.dir, facts: ws.fixture.facts, initial: ws.initial };
      expect((await TASKS[id].verify({ ...ctx, answer })).pass, id).toBe(true);
      const bare = answer.replace('ANSWER:', '');
      const result = await TASKS[id].verify({ ...ctx, answer: bare });
      expect(result.pass, id).toBe(false);
      expect(result.details.join('\n')).toMatch(/FAIL reply ends with an `ANSWER/);
      expect((await TASKS[id].verify({ ...ctx, answer: answer.replace('ANSWER:', 'Answer:') })).pass, id).toBe(false);
    }
    const ws = await workspace('T1');
    const ctx = { workspace: ws.dir, facts: ws.fixture.facts, initial: ws.initial };
    const v = ws.fixture.facts.retryLimit;
    expect((await TASKS.T1.verify({ ...ctx, answer: `ANSWER: ${v}\nHope this helps.` })).pass).toBe(false);
    expect((await TASKS.T1.verify({ ...ctx, answer: `The value is ${v}.\n\n  ANSWER: ${v}\n` })).pass).toBe(true);
  });

  it('T4 needs the right order, T1 the right number', async () => {
    const ws = await workspace('T4');
    const top = ws.fixture.facts.customerTotals.slice(0, 3).map((c) => c.customer);
    const ctx = { workspace: ws.dir, facts: ws.fixture.facts, initial: ws.initial };
    expect((await TASKS.T4.verify({ ...ctx, answer: `ANSWER: ${[top[1], top[0], top[2]].join(', ')}` })).pass).toBe(false);
    expect((await TASKS.T4.verify({ ...ctx, answer: `ANSWER: ${top.join(', ')}` })).pass).toBe(true);
    expect((await TASKS.T1.verify({ ...ctx, answer: `ANSWER: ${ws.fixture.facts.retryLimit + 5}` })).pass).toBe(false);
  });

  it('read-only tasks fail when the workspace changed, even with the right answer', async () => {
    for (const id of ['T1', 'T3', 'T4'] as const) {
      const ws = await workspace(id);
      const answer = await TASKS[id].solution(ws.dir, ws.fixture.facts);
      const ctx = { workspace: ws.dir, answer, facts: ws.fixture.facts, initial: ws.initial };
      expect((await TASKS[id].verify(ctx)).pass).toBe(true);
      await writeFile(path.join(ws.dir, 'notes.txt'), 'scratch\n');
      expect((await TASKS[id].verify(ctx)).pass).toBe(false);
      await rm(path.join(ws.dir, 'notes.txt'));
      await writeFile(path.join(ws.dir, 'config', 'app.json'), '{}\n');
      const result = await TASKS[id].verify(ctx);
      expect(result.pass).toBe(false);
      expect(result.details.join('\n')).toContain('modified config/app.json');
    }
  });

  it('edit tasks fail when a file outside the task changed or was deleted', async () => {
    for (const id of ['T2', 'T5', 'T6', 'T7', 'T8'] as const) {
      const ws = await workspace(id);
      const answer = await TASKS[id].solution(ws.dir, ws.fixture.facts);
      await writeFile(path.join(ws.dir, 'README.md'), 'rewritten\n');
      const result = await TASKS[id].verify({ workspace: ws.dir, answer, facts: ws.fixture.facts, initial: ws.initial });
      expect(result.pass, id).toBe(false);
      expect(result.details.join('\n')).toContain('changed outside the task: modified README.md');
    }
    const ws = await workspace('T5');
    const answer = await TASKS.T5.solution(ws.dir, ws.fixture.facts);
    await rm(path.join(ws.dir, 'config', 'regions.json'));
    expect((await TASKS.T5.verify({ workspace: ws.dir, answer, facts: ws.fixture.facts, initial: ws.initial })).pass).toBe(false);
  });

  it('T6 requires 2-space indented JSON, in any key order', async () => {
    const ws = await workspace('T6');
    const answer = await TASKS.T6.solution(ws.dir, ws.fixture.facts);
    const ctx = { workspace: ws.dir, answer, facts: ws.fixture.facts, initial: ws.initial };
    const first = ws.fixture.facts.paidOrderFiles[0] ?? '';
    const file = path.join(ws.dir, ...first.split('/'));
    const order: Record<string, unknown> = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, `${JSON.stringify({ itemCount: order['itemCount'], ...order }, null, 2)}\n`);
    expect((await TASKS.T6.verify(ctx)).pass).toBe(true);
    await writeFile(file, JSON.stringify(order));
    const minified = await TASKS.T6.verify(ctx);
    expect(minified.pass).toBe(false);
    expect(minified.details.join('\n')).toContain(`not 2-space indented JSON: ${first}`);
    await writeFile(file, `${JSON.stringify(order, null, 4)}\n`);
    expect((await TASKS.T6.verify(ctx)).pass).toBe(false);
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
