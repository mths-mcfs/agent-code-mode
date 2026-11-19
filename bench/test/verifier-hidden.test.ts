// The hidden-test cases of T9-T12. The verifier cases are split across files so that Vitest runs them in parallel processes.
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TASKS } from '../tasks/index.ts';
import { verifierWorkspaces } from './verifier-workspaces.ts';

const { workspace } = await verifierWorkspaces();

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

  it('T9-T11 and T13-T15 never leave hidden tests in the workspace', async () => {
    for (const id of ['T9', 'T10', 'T11', 'T13', 'T14', 'T15'] as const) {
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

  it('a deletion stays out of scope for the tasks that allow none, inside their own directory too', async () => {
    const ws = await workspace('T13');
    await rm(path.join(ws.dir, 'src', 'jobs', 'clock.js'));
    const result = await TASKS.T13.verify({ workspace: ws.dir, answer: '', facts: ws.fixture.facts, initial: ws.initial });
    expect(result.details.join('\n')).toMatch(/FAIL changed outside the task: deleted src\/jobs\/clock\.js/);
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
