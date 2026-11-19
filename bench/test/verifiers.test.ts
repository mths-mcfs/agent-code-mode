import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, it, vi, type ExpectStatic } from 'vitest';
import { DEFAULT_FIXTURE_SEED } from '../fixture/generate.ts';
import { createWorkspace } from '../lib/workspace.ts';
import { TASKS } from '../tasks/index.ts';
import { deniedPaths } from '../tasks/T8/verify.ts';
import { TASK_IDS } from '../tasks/types.ts';

// Every case builds its own workspace, so the cases run side by side. Two at a time: more starves the timing-sensitive suites in the other workers.
vi.setConfig({ maxConcurrency: 2 });

// Every case builds git workspaces and runs node --test on them: past the 20 s default on the slower Windows runner.
vi.setConfig({ testTimeout: 120_000 });

const root = await mkdtemp(path.join(os.tmpdir(), 'acm-verify-'));
// About 85 workspaces, each a git repo of 340-560 entries (T12 adds 80 log files): some 17k. Deleting them takes
// longer than the 10 s hook default on Windows, where every delete is scanned and a file still held
// open fails with EBUSY for a moment, so the cleanup gets its own timeout and retries.
afterAll(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}, 180_000);

let n = 0;
async function workspace(task: (typeof TASK_IDS)[number], host: 'claude' | 'codex' = 'codex') {
  n += 1;
  return createWorkspace(path.join(root, `${task}-${n}`), TASKS[task], host, DEFAULT_FIXTURE_SEED);
}

describe.concurrent.each(TASK_IDS)('verifier %s', (id) => {
  const task = TASKS[id];

  it('fails on the untouched fixture', async ({ expect }) => {
    const ws = await workspace(id);
    const result = await task.verify({ workspace: ws.dir, answer: '', facts: ws.fixture.facts, initial: ws.initial });
    expect(result.pass).toBe(false);
    expect(result.details.some((d) => d.startsWith('FAIL'))).toBe(true);
  });

  it('passes on the reference solution', async ({ expect }) => {
    const ws = await workspace(id);
    const answer = await task.solution(ws.dir, ws.fixture.facts);
    const result = await task.verify({ workspace: ws.dir, answer, facts: ws.fixture.facts, initial: ws.initial });
    expect(result.details.filter((d) => d.startsWith('FAIL'))).toEqual([]);
    expect(result.pass).toBe(true);
  });
});

describe.concurrent('verifier edge cases', () => {
  it('T2 and T7 reject edits to the tests', async ({ expect }) => {
    for (const id of ['T2', 'T7'] as const) {
      const ws = await workspace(id);
      const answer = await TASKS[id].solution(ws.dir, ws.fixture.facts);
      await writeFile(path.join(ws.dir, 'test', 'pipeline.test.js'), "import { test } from 'node:test';\ntest('nothing', () => {});\n");
      const result = await TASKS[id].verify({ workspace: ws.dir, answer, facts: ws.fixture.facts, initial: ws.initial });
      expect(result.pass).toBe(false);
    }
  });

  it('T8 fails when the protected file was changed or the denial is not reported', async ({ expect }) => {
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

  it('T8 reads the fixed DENIED line, in any reply language', async ({ expect }) => {
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

  it('T8 checks the denial log when the run has one', async ({ expect }) => {
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

  it('T1, T3 and T4 require the ANSWER line the prompt asks for', async ({ expect }) => {
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

  it('T4 needs the right order, T1 the right number', async ({ expect }) => {
    const ws = await workspace('T4');
    const top = ws.fixture.facts.customerTotals.slice(0, 3).map((c) => c.customer);
    const ctx = { workspace: ws.dir, facts: ws.fixture.facts, initial: ws.initial };
    expect((await TASKS.T4.verify({ ...ctx, answer: `ANSWER: ${[top[1], top[0], top[2]].join(', ')}` })).pass).toBe(false);
    expect((await TASKS.T4.verify({ ...ctx, answer: `ANSWER: ${top.join(', ')}` })).pass).toBe(true);
    expect((await TASKS.T1.verify({ ...ctx, answer: `ANSWER: ${ws.fixture.facts.retryLimit + 5}` })).pass).toBe(false);
  });

  it('read-only tasks fail when the workspace changed, even with the right answer', async ({ expect }) => {
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

  it('edit tasks fail when a file outside the task changed or was deleted', async ({ expect }) => {
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

  it('T6 requires 2-space indented JSON, in any key order', async ({ expect }) => {
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

  it('workspaces are reproducible: same tree, same initial commit', async ({ expect }) => {
    const a = await workspace('T5', 'claude');
    const b = await workspace('T5', 'claude');
    expect(a.baseCommit).toBe(b.baseCommit);
    expect(a.initial.get('.claude/settings.json')).toBeDefined();
    const c = await workspace('T5', 'codex');
    expect(c.initial.has('.claude/settings.json')).toBe(false);
  });
});

describe.concurrent('hidden-test tasks', () => {
  const write = (dir: string, rel: string, text: string) => writeFile(path.join(dir, ...rel.split('/')), text);

  it('T9 rejects a fix at the symptom (statement builds each invoice once) and accepts the root-cause fix', async ({ expect }) => {
    const ws = await workspace('T9');
    const file = path.join(ws.dir, 'src', 'billing', 'statement.js');
    const text = await readFile(file, 'utf8');
    await writeFile(file, text.replace('const invoice = buildInvoice(order, region);', 'const invoice = preview;'));
    const symptom = await TASKS.T9.verify({ workspace: ws.dir, answer: '', facts: ws.fixture.facts, initial: ws.initial });
    expect(symptom.pass).toBe(false);
    expect(symptom.details.join('\n')).toMatch(/FAIL hidden tests pass/);
  });

  it('T9-T11 and T13-T15 never leave hidden tests in the workspace', async ({ expect }) => {
    for (const id of ['T9', 'T10', 'T11', 'T13', 'T14', 'T15'] as const) {
      const ws = await workspace(id);
      await TASKS[id].verify({ workspace: ws.dir, answer: '', facts: ws.fixture.facts, initial: ws.initial });
      expect(await readdir(ws.dir)).not.toContain('hidden-tests');
      for (const f of ws.initial.keys()) expect(f.startsWith('hidden-tests/')).toBe(false);
    }
  });

  it('T10 fails when one caller keeps the positional form or the public API drops it', async ({ expect }) => {
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

  it('T11 fails a floating-point implementation that is right on small inputs', async ({ expect }) => {
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

  /** Replaces `from` (which must be there, once) with `to` in a workspace file. */
  async function edit(expect: ExpectStatic, dir: string, rel: string, from: string, to: string): Promise<void> {
    const file = path.join(dir, ...rel.split('/'));
    const text = await readFile(file, 'utf8');
    expect(text.split(from).length, `${rel} has ${JSON.stringify(from)} once`).toBe(2);
    await writeFile(file, text.replace(from, () => to));
  }

  // The two planted T13 bugs as one-step fixes, and the partial fixes an agent is likely to try.
  const T13_SLOT_FIX = ['src/jobs/retry.js', '  release();\n', ''] as const;
  const T13_KEY_FIX = ['src/jobs/queue.js', 'job.reject = reject;', 'job.reject = (err) => { keys.release(key); reject(err); };'] as const;
  const T13_PARTIAL: readonly { readonly name: string; readonly edits: readonly (readonly [string, string, string])[]; readonly caught: RegExp }[] = [
    { name: 'only the slot is fixed', edits: [T13_SLOT_FIX], caught: /a key that gave up is free again/ },
    { name: 'only the key is fixed', edits: [T13_KEY_FIX], caught: /a job in backoff frees exactly one slot.*the limit holds for jobs added after a retry/ },
    {
      name: 'the slot count is clamped instead of released once',
      edits: [T13_KEY_FIX, ['src/jobs/slots.js', 'else active -= 1;', 'else active = Math.max(0, active - 1);']],
      caught: /a job in backoff frees exactly one slot/,
    },
    {
      name: 'the key is freed on every failed attempt, not when the job settles',
      edits: [T13_SLOT_FIX, ['src/jobs/queue.js', '    } catch (err) {\n', '    } catch (err) {\n      keys.release(job.key);\n']],
      caught: /a pending key is de-duplicated while waiting, running and in backoff/,
    },
    {
      name: 'the key is freed only after the handlers of the promise ran',
      edits: [T13_SLOT_FIX, ['src/jobs/queue.js', '    keys.hold(key, promise);\n', '    keys.hold(key, promise);\n    promise.catch(() => {}).finally(() => keys.release(key));\n']],
      caught: /the key is already free inside the handlers of the promise/,
    },
  ];

  it('T13 accepts the two one-step fixes together', async ({ expect }) => {
    const ws = await workspace('T13');
    for (const [rel, from, to] of [T13_SLOT_FIX, T13_KEY_FIX]) await edit(expect, ws.dir, rel, from, to);
    const result = await TASKS.T13.verify({ workspace: ws.dir, answer: '', facts: ws.fixture.facts, initial: ws.initial });
    expect(result.details.filter((d) => d.startsWith('FAIL'))).toEqual([]);
  });

  it.for(T13_PARTIAL)('T13 rejects a partial fix: $name', async ({ edits, caught }, { expect }) => {
    const ws = await workspace('T13');
    for (const [rel, from, to] of edits) await edit(expect, ws.dir, rel, from, to);
    const result = await TASKS.T13.verify({ workspace: ws.dir, answer: '', facts: ws.fixture.facts, initial: ws.initial });
    expect(result.pass).toBe(false);
    expect(result.details[0]).toMatch(/^ok node --test passes/);
    const hidden = result.details.find((d) => d.startsWith('FAIL hidden tests pass')) ?? '';
    expect(hidden).toMatch(caught);
  });

  // T14: the reference parser with one chunk-boundary or end-of-input rule dropped.
  const T14_LOOP = '    for (let i = 0; i < chunk.length; i += 1) {\n';
  const T14_PARTIAL: readonly { readonly name: string; readonly from: string; readonly to: string; readonly caught: RegExp }[] = [
    {
      name: 'a carriage return at the end of a chunk ends the record',
      from: T14_LOOP,
      to: `    if (state === CR && chunk.length > 0) endRecord();\n${T14_LOOP}`,
      caught: /rule 4: push returns the records completed by the chunk; rule 1: a chunk may end anywhere.*fuzz: built records/,
    },
    {
      name: 'a quote at the end of a chunk always closes the field',
      from: T14_LOOP,
      to: `    if (state === QUOTE && chunk[0] === '"') fail('unexpected character after a closing quote');\n${T14_LOOP}`,
      caught: /rule 1: a chunk may end anywhere.*fuzz: built records/,
    },
    { name: 'a final newline creates an empty record', from: 'if (state !== RECORD_START) {', to: '{', caught: /rule 5: end returns the unterminated last record/ },
    { name: 'a lone carriage return at the end of the input is accepted', from: "    if (state === CR) fail('carriage return without a line feed');\n", to: '', caught: /rule 6: invalid input throws CsvError/ },
  ];

  it.for(T14_PARTIAL)('T14 rejects a parser where $name', async ({ from, to, caught }, { expect }) => {
    const ws = await workspace('T14');
    await TASKS.T14.solution(ws.dir, ws.fixture.facts);
    await edit(expect, ws.dir, 'src/lib/csv.js', from, to);
    const result = await TASKS.T14.verify({ workspace: ws.dir, answer: '', facts: ws.fixture.facts, initial: ws.initial });
    expect(result.pass).toBe(false);
    const hidden = result.details.find((d) => d.startsWith('FAIL hidden tests pass')) ?? '';
    expect(hidden).toMatch(caught);
  });

  /** A T15 workspace with the reference solution applied, to break in one place. */
  async function solvedT15() {
    const ws = await workspace('T15');
    await TASKS.T15.solution(ws.dir, ws.fixture.facts);
    const verify = () => TASKS.T15.verify({ workspace: ws.dir, answer: '', facts: ws.fixture.facts, initial: ws.initial });
    const restore = async (rel: string): Promise<void> => {
      await writeFile(path.join(ws.dir, ...rel.split('/')), ws.initial.get(rel) ?? '');
    };
    return { ws, verify, restore };
  }
  const hiddenLine = (details: readonly string[]): string => details.find((d) => d.startsWith('FAIL hidden tests pass')) ?? '';

  // One caller per import shape left on the old API (with the old module kept, so that it still runs).
  it.for([
    { shape: 'named import', file: 'src/services/catalog/products.js' },
    { shape: 'aliased import', file: 'src/services/users/search.js' },
    { shape: 'namespace import', file: 'src/services/orders/cancel.js' },
    { shape: 'aliased legacyJson', file: 'src/services/shipping/zones.js' },
  ])('T15 rejects a migration that missed the $shape', async ({ file }, { expect }) => {
    const { verify, restore } = await solvedT15();
    await restore(file);
    await restore('src/lib/legacy-http.js');
    const result = await verify();
    expect(result.pass).toBe(false);
    expect(result.details[0]).toMatch(/^ok node --test passes/);
    expect(hiddenLine(result.details)).toMatch(/static: src\/lib\/legacy-http\.js is deleted; static: no file imports legacy-http; static: every former caller imports/);
  });

  // The reference solution with one mapping rule of the MIGRATION notes dropped in one caller.
  const T15_WRONG_RULE: readonly { readonly name: string; readonly file: string; readonly from: string; readonly to: string }[] = [
    { name: 'a timeout is left in seconds', file: 'catalog/search.js', from: 'timeoutMs: 3000', to: 'timeoutMs: 3' },
    { name: 'a method keeps its lower case', file: 'billing/dunning.js', from: 'method: String(method).toUpperCase(),', to: 'method,' },
    { name: 'a JSON body goes without its content-type', file: 'notifications/email.js', from: "    headers: { 'content-type': 'application/json' },\n", to: '' },
    { name: 'a JSON body is sent as a string', file: 'users/invites.js', from: 'body: { email, role },', to: 'body: JSON.stringify({ email, role }),' },
    { name: 'the query is dropped', file: 'shipping/tracking.js', from: ", query: { events: 'last' }", to: '' },
    { name: 'an undefined timeout is multiplied', file: 'notifications/webhooks.js', from: 'if (hook.timeoutSeconds !== undefined) options.timeoutMs', to: 'options.timeoutMs' },
    { name: 'an error status the caller handled now throws', file: 'shipping/pickups.js', from: 'if (err instanceof HttpError) return false;', to: '' },
    { name: 'every error is swallowed, not only HttpError', file: 'users/preferences.js', from: 'if (err instanceof HttpError) return false;\n    throw err;', to: 'return false;' },
    { name: 'the result still reads data', file: 'orders/export.js', from: 'return res.body;', to: 'return res.data;' },
  ];

  it.for(T15_WRONG_RULE)('T15 rejects a migration where $name', async ({ file, from, to }, { expect }) => {
    const { ws, verify } = await solvedT15();
    await edit(expect, ws.dir, `src/services/${file}`, from, to);
    const result = await verify();
    expect(result.pass).toBe(false);
    expect(result.details[0]).toMatch(/^ok node --test passes/);
    expect(hiddenLine(result.details)).toBe(`FAIL hidden tests pass (pass 40, fail 1: behaviour: ${file})`);
  });

  it('T15 rejects a shim: the old helper kept as a wrapper over request', async ({ expect }) => {
    const { ws, verify } = await solvedT15();
    await writeFile(
      path.join(ws.dir, 'src', 'lib', 'http-compat.js'),
      "import { request } from './http.js';\nexport const legacyFetch = async (url, opts = {}) => {\n  const res = await request({ url, query: opts.qs });\n  return { status: res.status, data: res.body };\n};\n",
    );
    await writeFile(
      path.join(ws.dir, 'src', 'services', 'catalog', 'products.js'),
      (ws.initial.get('src/services/catalog/products.js') ?? '').replace('../../lib/legacy-http.js', '../../lib/http-compat.js'),
    );
    const result = await verify();
    expect(result.pass).toBe(false);
    expect(result.details[0]).toMatch(/^ok node --test passes/);
    expect(hiddenLine(result.details)).toMatch(/static: every former caller imports src\/lib\/http\.js and calls request itself; static: the old helpers are not recreated/);
    // The same wrapper under another name is still caught: its caller does not call request itself.
    await edit(expect, ws.dir, 'src/lib/http-compat.js', 'export const legacyFetch =', 'export const fetchCompat =');
    await edit(expect, ws.dir, 'src/services/catalog/products.js', 'import { legacyFetch }', 'import { fetchCompat as legacyFetch }');
    await edit(expect, ws.dir, 'src/services/catalog/products.js', "import { API } from '../config.js';", "import { API } from '../config.js';\nimport { request } from '../../lib/http.js';");
    const renamed = await verify();
    expect(hiddenLine(renamed.details)).toMatch(/static: the old helpers are not recreated/);
  });

  it('T15 rejects a migration that also rewrote a look-alike, and any deletion but the old module', async ({ expect }) => {
    const trap = await solvedT15();
    await edit(expect, trap.ws.dir, 'src/services/billing/tax-rules.js', 'legacyFetch(url)', 'request(options)');
    const rewritten = await trap.verify();
    expect(rewritten.pass).toBe(false);
    expect(rewritten.details.filter((d) => d.startsWith('FAIL'))).toEqual(['FAIL files that are not callers of legacy-http changed: src/services/billing/tax-rules.js']);

    const vendor = await solvedT15();
    await edit(expect, vendor.ws.dir, 'src/services/users/session-cache.js', "import * as cache from '../../vendor/cache/legacy.js';", "import * as cache from '../../vendor/cache/legacy.js'; // not HTTP");
    expect((await vendor.verify()).details.join('\n')).toMatch(/FAIL files that are not callers of legacy-http changed: src\/services\/users\/session-cache\.js/);

    const deleted = await solvedT15();
    await rm(path.join(deleted.ws.dir, 'src', 'services', 'config.js'));
    await rm(path.join(deleted.ws.dir, 'src', 'lib', 'dates.js'));
    expect((await deleted.verify()).details.join('\n')).toMatch(/FAIL changed outside the task: deleted src\/lib\/dates\.js, deleted src\/services\/config\.js/);

    const http = await solvedT15();
    await edit(expect, http.ws.dir, 'src/lib/http.js', "const DEFAULT_TIMEOUT_MS = 30000;", "const DEFAULT_TIMEOUT_MS = 30_000;");
    expect((await http.verify()).details.join('\n')).toMatch(/FAIL changed outside the task: modified src\/lib\/http\.js/);
  });

  it('a deletion stays out of scope for the tasks that allow none, inside their own directory too', async ({ expect }) => {
    const ws = await workspace('T13');
    await rm(path.join(ws.dir, 'src', 'jobs', 'clock.js'));
    const result = await TASKS.T13.verify({ workspace: ws.dir, answer: '', facts: ws.fixture.facts, initial: ws.initial });
    expect(result.details.join('\n')).toMatch(/FAIL changed outside the task: deleted src\/jobs\/clock\.js/);
  });

  it('T12 checks both the request id and the caller, and is deterministic for the fixture seed', async ({ expect }) => {
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
