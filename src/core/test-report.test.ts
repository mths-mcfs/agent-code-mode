import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_TEST_FAILURES, testResult } from './test-report.js';
import type { BashResult } from './types.js';

const fixture = (name: string): string => readFileSync(path.join(import.meta.dirname, 'fixtures', 'test-output', `${name}.txt`), 'utf8');

function bash(stdout: string, extra: Partial<BashResult> = {}): BashResult {
  return { exitCode: 1, signal: null, stdout, stderr: '', truncated: false, timedOut: false, ...extra };
}

describe('testResult: recorded runner output (one pass, two failures, one skip)', () => {
  it.each([
    ['vitest', 'vitest', ['math.test.ts > subtracts', 'math.test.ts > group > nested fails']],
    ['jest', 'jest', ['subtracts', 'group › nested fails']],
    ['pytest', 'pytest', ['test_math.py::test_subtracts', 'test_math.py::TestGroup::test_nested_fails']],
    ['node-spec', 'node:test', ['subtracts', 'nested fails']],
  ])('%s', (file, runner, names) => {
    const r = testResult(bash(fixture(file)));
    expect(r).toMatchObject({ ok: false, exitCode: 1, runner, passed: 1, failed: 2, skipped: 1, truncated: false });
    expect(r.failures.map((f) => f.name)).toEqual(names);
    expect(r.failures.every((f) => typeof f.message === 'string' && f.message !== '')).toBe(true);
    expect(r.output).toBeDefined();
  });

  it('node --test with the TAP reporter: the runner count wins over the suite lines', () => {
    const r = testResult(bash(fixture('node-tap')));
    expect(r).toMatchObject({ ok: false, runner: 'tap', passed: 1, failed: 2, skipped: 1 });
    expect(r.failures.map((f) => f.name)).toContain('nested fails');
    expect(r.failures.find((f) => f.name === 'nested fails')?.message).toBe('boom nested');
  });

  it('reads pytest totals when the runner wrote to stderr and colored its output', () => {
    const r = testResult({ ...bash(''), stderr: '\x1b[31m==== 1 failed, 3 passed in 0.10s ====\x1b[0m\n' });
    expect(r).toMatchObject({ ok: false, runner: 'pytest', passed: 3, failed: 1 });
  });

  it('adds up every cargo test binary', () => {
    const out = 'test a ... ok\ntest b ... FAILED\ntest result: FAILED. 1 passed; 1 failed; 2 ignored; 0 measured\n\ntest c ... ok\ntest d ... ok\ntest e ... ok\ntest f ... ok\ntest result: ok. 4 passed; 0 failed; 0 ignored\n';
    expect(testResult(bash(out))).toMatchObject({ runner: 'cargo', passed: 5, failed: 1, skipped: 2, failures: [{ name: 'b' }] });
  });
});

describe('testResult: never a pass that did not happen', () => {
  it('is ok for exit 0 with passing totals, and leaves the output out', () => {
    const r = testResult(bash(' Test Files  1 passed (1)\n      Tests  3 passed (3)\n', { exitCode: 0 }));
    expect(r).toEqual({ ok: true, exitCode: 0, timedOut: false, runner: 'vitest', passed: 3, failed: 0, skipped: 0, failures: [], truncated: false });
  });

  it('is not ok when the command exits non-zero, whatever the totals say', () => {
    expect(testResult(bash('      Tests  3 passed (3)\n', { exitCode: 2 })).ok).toBe(false);
  });

  it('is not ok when the output shows failures but the command exits 0', () => {
    expect(testResult(bash(fixture('vitest'), { exitCode: 0 }))).toMatchObject({ ok: false, failed: 2 });
  });

  it('is not ok when the command timed out or was killed by a signal', () => {
    expect(testResult(bash('      Tests  3 passed (3)\n', { exitCode: null, signal: 'SIGKILL', timedOut: true }))).toMatchObject({ ok: false, timedOut: true });
    expect(testResult(bash('      Tests  3 passed (3)\n', { exitCode: null, signal: 'SIGTERM' })).ok).toBe(false);
  });

  it('counts node cancelled tests as failed', () => {
    expect(testResult(bash('ℹ pass 2\nℹ fail 0\nℹ cancelled 1\n', { exitCode: 1 }))).toMatchObject({ failed: 1, passed: 2 });
  });

  it('reports runner null and the end of the output when no totals are found', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    const r = testResult(bash(lines, { exitCode: 0 }));
    expect(r).toMatchObject({ ok: true, runner: null, passed: 0, failed: 0 });
    expect(r.output?.split('\n')).toHaveLength(40);
    expect(r.output?.endsWith('line 99')).toBe(true);
  });

  it('marks a result cut by the bash cap as truncated', () => {
    expect(testResult(bash('partial', { truncated: true })).truncated).toBe(true);
  });
});

describe('testResult: what is not a failure, and what still is', () => {
  it('does not count the console block jest prints for a passing test', () => {
    const out = 'PASS ./a.test.js\n  ● Console\n\n    console.log\n      hello\n\nTests:       2 passed, 2 total\n';
    expect(testResult(bash(out, { exitCode: 0 }))).toMatchObject({ ok: true, runner: 'jest', failed: 0, failures: [] });
  });

  it('does not count a TAP TODO result as a failure', () => {
    const out = 'TAP version 13\nok 1 - works\nnot ok 2 - later # TODO not yet\n# pass 1\n# fail 0\n# todo 1\n';
    expect(testResult(bash(out, { exitCode: 0 }))).toMatchObject({ ok: true, runner: 'tap', failed: 0, skipped: 1, failures: [] });
  });

  it('counts failure lines with no totals, even when the command exits 0', () => {
    expect(testResult(bash('TAP version 13\nok 1 - fine\nnot ok 2 - broken\n', { exitCode: 0 }))).toMatchObject({ ok: false, runner: null, failed: 1, failures: [{ name: 'broken' }] });
  });
});

describe('testResult: counts come from the runner\'s final summary', () => {
  it('ignores TAP summary lines a test printed before the real one', () => {
    const out = 'TAP version 13\n# pass 8\n# fail 0\nok 1 - only test\n1..1\n# tests 1\n# pass 1\n# fail 0\n';
    expect(testResult(bash(out, { exitCode: 0 }))).toMatchObject({ ok: true, runner: 'tap', passed: 1, failed: 0 });
  });

  it('ignores spec summary lines a test printed, and never reports more passes than results', () => {
    expect(testResult(bash('ℹ pass 8\n✔ only test (1ms)\nℹ tests 1\nℹ pass 1\nℹ fail 0\n', { exitCode: 0 }))).toMatchObject({ runner: 'node:test', passed: 1 });
    expect(testResult(bash('✔ only test (1ms)\nℹ pass 9\nℹ fail 0\n', { exitCode: 0 }))).toMatchObject({ runner: 'node:test', passed: 1 });
  });
});

describe('testResult: bounded', () => {
  it('reads a megabyte of incomplete summary lines quickly', () => {
    const line = `      Tests  1 passed${' '.repeat(1_900)}(1`;
    const out = `${Array.from({ length: Math.ceil(1_048_576 / line.length) }, () => line).join('\n')}\n`;
    const started = performance.now();
    const r = testResult(bash(out, { exitCode: 0 }));
    expect(performance.now() - started).toBeLessThan(500);
    expect(r.runner).toBeNull();
  });

  it('reads a megabyte of near-miss lines of every runner quickly', () => {
    const near = ['=== 1 passed in 0.1s', 'not ok 1 - ' + ' '.repeat(400) + 'x', 'FAIL ' + ' '.repeat(450), '✖ ' + '('.repeat(450), 'test result: ' + '1 passed '.repeat(50)];
    const out = Array.from({ length: 3_000 }, (_, i) => near[i % near.length]).join('\n');
    const started = performance.now();
    testResult(bash(out));
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('lists at most MAX_TEST_FAILURES failures and says it cut them', () => {
    const out = `${Array.from({ length: 80 }, (_, i) => `FAILED t.py::test_${i} - boom`).join('\n')}\n==== 80 failed in 1.00s ====\n`;
    const r = testResult(bash(out));
    expect(r.failures).toHaveLength(MAX_TEST_FAILURES);
    expect(r).toMatchObject({ failed: 80, truncated: true });
  });

  it('reads only the end of a huge output and cuts long lines, in linear time', () => {
    const noise = `${'x'.repeat(1_000_000)}\n`.repeat(4);
    const started = performance.now();
    const r = testResult(bash(`${noise}      Tests  1 failed | 2 passed (3)\n`));
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(r).toMatchObject({ runner: 'vitest', failed: 1, passed: 2, truncated: true });
    expect(r.output?.length).toBeLessThanOrEqual(4_000);
  });

  it('stays fast on a line built to make a backtracking pattern blow up', () => {
    const evil = `${'1 passed '.repeat(5_000)}${' '.repeat(50_000)}`;
    const started = performance.now();
    testResult(bash(`Tests: ${evil}\n==== ${' '.repeat(100_000)}\n${'ℹ pass '.repeat(10_000)}\n`));
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
