// The hidden-test cases of T13 and T14. The verifier cases are split across files so that Vitest runs them in parallel processes.
import { describe, expect, it } from 'vitest';
import { TASKS } from '../tasks/index.ts';
import { verifierWorkspaces, edit } from './verifier-workspaces.ts';

const { workspace } = await verifierWorkspaces();

describe('hidden-test tasks', () => {
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

  it('T13 accepts the two one-step fixes together', async () => {
    const ws = await workspace('T13');
    for (const [rel, from, to] of [T13_SLOT_FIX, T13_KEY_FIX]) await edit(ws.dir, rel, from, to);
    const result = await TASKS.T13.verify({ workspace: ws.dir, answer: '', facts: ws.fixture.facts, initial: ws.initial });
    expect(result.details.filter((d) => d.startsWith('FAIL'))).toEqual([]);
  });

  it.each(T13_PARTIAL)('T13 rejects a partial fix: $name', async ({ edits, caught }) => {
    const ws = await workspace('T13');
    for (const [rel, from, to] of edits) await edit(ws.dir, rel, from, to);
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

  it.each(T14_PARTIAL)('T14 rejects a parser where $name', async ({ from, to, caught }) => {
    const ws = await workspace('T14');
    await TASKS.T14.solution(ws.dir, ws.fixture.facts);
    await edit(ws.dir, 'src/lib/csv.js', from, to);
    const result = await TASKS.T14.verify({ workspace: ws.dir, answer: '', facts: ws.fixture.facts, initial: ws.initial });
    expect(result.pass).toBe(false);
    const hidden = result.details.find((d) => d.startsWith('FAIL hidden tests pass')) ?? '';
    expect(hidden).toMatch(caught);
  });
});
