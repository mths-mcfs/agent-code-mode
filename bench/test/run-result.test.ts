import { describe, expect, it } from 'vitest';
import { formatRunResult } from '../../src/core/output.ts';
import { OverflowStore } from '../../src/core/overflow.ts';
import type { CallLogEntry, RunResult } from '../../src/core/types.ts';
import { runInnerCalls } from '../lib/run-result.ts';

const base: RunResult = { ok: true, result: null, logs: [], calls: [], changedFiles: [], diff: '', warnings: [] };
const calls: CallLogEntry[] = [
  { id: 'c1', tool: 'read', summary: 'read a', decision: 'allowed', durationMs: 1 },
  { id: 'c2', tool: 'bash', summary: 'bash rm x', decision: 'denied', reason: 'rule: no rm', durationMs: 1 },
  { id: 'c3', tool: 'grep', summary: 'grep "{"', decision: 'allowed', durationMs: 1 },
];
const expected = { total: 3, byTool: { read: 1, bash: 1, grep: 1 }, denials: ['bash bash rm x: rule: no rm'] };

/** The response text as the hosts hand it to the bench: every content block, joined. */
const joined = (result: RunResult, verbose = false): string =>
  formatRunResult(result, { overflow: new OverflowStore(), verbose })
    .content.map((c) => c.text)
    .join('');

describe('runInnerCalls on the server response', () => {
  it('reads a one-block response, compact and verbose', () => {
    expect(runInnerCalls(joined({ ...base, result: { a: '}' }, calls }))).toEqual(expected);
    expect(runInnerCalls(joined({ ...base, result: 1, calls }, true))).toEqual(expected);
  });

  it('reads the JSON block when a plain text result follows it', () => {
    const text = Array.from({ length: 30 }, (_, i) => `"line" {${i}} \\ ]`).join('\n');
    const response = formatRunResult({ ...base, result: text, calls });
    expect(response.content).toHaveLength(2);
    expect(runInnerCalls(joined({ ...base, result: text, calls }))).toEqual(expected);
  });

  it('reads a response cut at the cap', () => {
    const result: RunResult = { ...base, result: '{"x":\n'.repeat(40_000), calls };
    expect(runInnerCalls(joined(result))).toEqual(expected);
  });

  it('is null for text that is not a run result', () => {
    expect(runInnerCalls('not json')).toBeNull();
    expect(runInnerCalls('{"ok":true}')).toBeNull();
    expect(runInnerCalls('{"calls": {"total": 1, "byTool": {}} plus text')).toBeNull();
    expect(runInnerCalls('{"unclosed": "')).toBeNull();
  });
});
