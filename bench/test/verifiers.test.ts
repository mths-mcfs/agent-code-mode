import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_FIXTURE_SEED } from '../fixture/generate.ts';
import { createWorkspace } from '../lib/workspace.ts';
import { TASKS } from '../tasks/index.ts';
import { deniedPaths } from '../tasks/T8/verify.ts';
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

describe('hidden-test tasks', () => {
  const write = (dir: string, rel: string, text: string) => writeFile(path.join(dir, ...rel.split('/')), text);

  it('T9 rejects a fix at the symptom (statement builds each invoice once) and accepts the root-cause fix', async () => {
    const ws = await workspace('T9');
    const file = path.join(ws.dir, 'src', 'billing', 'statement.js');
    const text = await readFile(file, 'utf8');
    await writeFile(file, text.replace('const invoice = buildInvoice(order, region);', 'const invoice = preview;'));
    const symptom = await TASKS.T9.verify({ workspace: ws.dir, answer: '', facts: ws.fixture.facts, initial: ws.initial });
    expect(symptom.pass).toBe(false);
    expect(symptom.details.join('\n')).toMatch(/FAIL hidden tests pass/);
  });

  it('T9-T11 never leave hidden tests in the workspace', async () => {
    for (const id of ['T9', 'T10', 'T11'] as const) {
      const ws = await workspace(id);
      await TASKS[id].verify({ workspace: ws.dir, answer: '', facts: ws.fixture.facts, initial: ws.initial });
      expect(await readdir(ws.dir)).not.toContain('hidden-tests');
      for (const f of ws.initial.keys()) expect(f.startsWith('hidden-tests/')).toBe(false);
    }
  });

  it('T10 fails when one caller keeps the positional form or the public API drops it', async () => {
    const ws = await workspace('T10');
    await TASKS.T10.solution(ws.dir, ws.fixture.facts);
    // Same output, old form: caught by the static check.
    await write(ws.dir, 'src/catalog/export.js', "import { formatPrice } from '../lib/price.js';\nexport function csvRow(item) {\n  return [item.sku, item.name, formatPrice(item.cents, { symbol: false })].join(',');\n}\nexport function csv(items) {\n  return ['sku,name,price', ...items.map(csvRow)].join('\\n');\n}\nexport const legacy = (c) => formatPrice(c, 'USD', false);\n");
    const positional = await TASKS.T10.verify({ workspace: ws.dir, answer: '', facts: ws.fixture.facts, initial: ws.initial });
    expect(positional.details.join('\n')).toMatch(/FAIL positional formatPrice calls left: src\/catalog\/export\.js/);
    const ws2 = await workspace('T10');
    await TASKS.T10.solution(ws2.dir, ws2.fixture.facts);
    await write(ws2.dir, 'src/index.js', "export { formatPrice } from './lib/price.js';\nexport { priceLabel, plainLabel } from './catalog/labels.js';\nexport { csv, csvRow } from './catalog/export.js';\nexport { priceTable, priceDelta } from './catalog/table.js';\nexport { summaryLine, totalsByCurrency } from './catalog/summary.js';\n");
    const noCompat = await TASKS.T10.verify({ workspace: ws2.dir, answer: '', facts: ws2.fixture.facts, initial: ws2.initial });
    expect(noCompat.pass).toBe(false);
  });

  it('T11 fails a floating-point implementation that is right on small inputs', async () => {
    const ws = await workspace('T11');
    await write(
      ws.dir,
      'src/lib/split.js',
      `export function splitCents(totalCents, weights) {
  if (!Number.isSafeInteger(totalCents) || !Array.isArray(weights) || weights.length === 0) throw new RangeError('bad');
  if (weights.some((w) => !Number.isSafeInteger(w) || w < 0)) throw new RangeError('bad');
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0) { if (totalCents !== 0) throw new RangeError('bad'); return weights.map(() => 0); }
  const abs = Math.abs(totalCents);
  const raw = weights.map((w) => (abs * w) / sum);
  const shares = raw.map(Math.floor);
  let left = abs - shares.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, f: r - Math.floor(r) })).sort((a, b) => b.f - a.f || a.i - b.i);
  for (const { i } of order) { if (left <= 0) break; shares[i] += 1; left -= 1; }
  return shares.map((s) => (s === 0 ? 0 : totalCents < 0 ? -s : s));
}
`,
    );
    const result = await TASKS.T11.verify({ workspace: ws.dir, answer: '', facts: ws.fixture.facts, initial: ws.initial });
    expect(result.details[0]).toMatch(/^ok node --test passes/);
    expect(result.details.join("\n")).toMatch(/FAIL hidden tests pass \(pass \d+, fail \d+: [^)]*exact for the largest safe totals/);
  });

  it('T12 checks both the request id and the caller, and is deterministic for the fixture seed', async () => {
    const ws = await workspace('T12');
    const answer = await TASKS.T12.solution(ws.dir, ws.fixture.facts);
    const [, id, service] = /ANSWER: (\S+), (\S+)/.exec(answer) ?? [];
    expect(id).toMatch(/^r-[0-9a-f]{8}$/);
    const wrong = answer.replace(`, ${service}`, service === 'api' ? ', shipping' : ', api');
    expect((await TASKS.T12.verify({ workspace: ws.dir, answer: wrong, facts: ws.fixture.facts, initial: ws.initial })).pass).toBe(false);
    const again = await workspace('T12');
    expect([...again.initial.entries()].filter(([f]) => f.startsWith('logs/'))).toEqual([...ws.initial.entries()].filter(([f]) => f.startsWith('logs/')));
  });
});
