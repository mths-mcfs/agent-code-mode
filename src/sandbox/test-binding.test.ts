import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { BashResult, CallReply } from '../core/types.js';
import { QuickJsSandbox } from './quickjs-sandbox.js';

const sandbox = new QuickJsSandbox();
const fixture2 = (name: string): string => readFileSync(new URL(`./fixtures/test-output/${name}`, import.meta.url), 'utf8');
const fixture = (name: string): string => fixture2(`${name}.txt`);
const bashResult = (over: Partial<BashResult>): BashResult => ({ exitCode: 0, signal: null, stdout: '', stderr: '', truncated: false, timedOut: false, ...over });

interface Seen {
  readonly tool: string;
  readonly args: unknown;
}

/** Runs `code` in the real sandbox with bindings answered by `reply`. */
async function script(code: string, reply: (tool: string, args: unknown) => CallReply): Promise<{ value: unknown; calls: Seen[] }> {
  const calls: Seen[] = [];
  const outcome = await sandbox.run(code, {
    timeoutMs: 15_000,
    memoryBytes: 64 * 1024 * 1024,
    signal: new AbortController().signal,
    onCall: async (tool, args) => {
      calls.push({ tool, args });
      return reply(tool, args);
    },
    onLog: () => undefined,
  });
  if (!outcome.ok) throw new Error(`${outcome.error.name}: ${outcome.error.message}`);
  return { value: outcome.value, calls };
}

const ran = (result: Partial<BashResult>) => (tool: string): CallReply =>
  tool === 'bash' ? { ok: true, value: bashResult(result) } : { ok: false, error: { name: 'ToolError', code: 'not-found', message: 'missing' } };

const report = async (result: Partial<BashResult>): Promise<Record<string, unknown>> => {
  const { value } = await script('return await test({command: "run tests"});', ran(result));
  return value as Record<string, unknown>;
};

const recorded: Record<string, { exitCode: number; stdout: string; stderr: string }> = JSON.parse(fixture2('runs.json'));
const replay = (name: string): Promise<Record<string, unknown>> => {
  const run = recorded[name];
  if (run === undefined) throw new Error(`no recorded run ${name}`);
  return report(run);
};

describe('test(): recorded runner output', () => {
  const failing = { exitCode: 1 };

  it('node --test, spec reporter', async () => {
    const r = await report({ ...failing, stdout: fixture('node-spec') });
    expect(r).toMatchObject({ ok: false, exitCode: 1, parsed: true, passed: 1, failed: 2, skipped: 1 });
    expect(r['failures']).toEqual([
      { name: 'subtracts', message: 'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n\n2 !== 1', file: 'math.test.js', line: 4 },
      { name: 'nested fails', message: 'Error: boom nested', file: 'math.test.js', line: 6 },
    ]);
  });

  it('node --test, TAP reporter: a suite that only repeats its failed test is not a failure of its own', async () => {
    const r = await report({ ...failing, stdout: fixture('node-tap') });
    expect(r).toMatchObject({ parsed: true, passed: 1, failed: 2, skipped: 1 });
    expect(r['failures']).toEqual([
      { name: 'subtracts', message: 'Expected values to be strictly equal:\n\n2 !== 1', file: '/work/project/math.test.js', line: 4 },
      { name: 'nested fails', message: 'boom nested', file: '/work/project/math.test.js', line: 6 },
    ]);
  });

  it('vitest', async () => {
    const r = await report({ ...failing, stdout: fixture('vitest') });
    expect(r).toMatchObject({ parsed: true, passed: 1, failed: 2, skipped: 1 });
    expect(r['failures']).toEqual([
      { name: 'math.test.ts > subtracts', message: 'AssertionError: expected 2 to be 1 // Object.is equality\n\n- Expected\n+ Received\n\n- 1\n+ 2', file: 'math.test.ts', line: 3 },
      { name: 'math.test.ts > group > nested fails', message: 'Error: boom nested', file: 'math.test.ts', line: 5 },
    ]);
  });

  it('jest', async () => {
    const r = await report({ ...failing, stderr: fixture('jest') });
    expect(r).toMatchObject({ parsed: true, passed: 1, failed: 2, skipped: 1 });
    expect(r['failures']).toEqual([
      { name: 'subtracts', message: 'expect(received).toBe(expected) // Object.is equality\n\nExpected: 1\nReceived: 2', file: 'math.test.js', line: 2 },
      { name: 'group › nested fails', message: 'boom nested', file: 'math.test.js', line: 4 },
    ]);
  });

  it('pytest', async () => {
    const r = await report({ ...failing, stdout: fixture('pytest') });
    expect(r).toMatchObject({ parsed: true, passed: 1, failed: 2, skipped: 1 });
    expect(r['failures']).toEqual([
      { name: 'test_math.py::test_subtracts', message: 'assert (3 - 1) == 1', file: 'test_math.py', line: 5 },
      { name: 'test_math.py::TestGroup::test_nested_fails', message: 'ValueError: boom nested', file: 'test_math.py', line: 11 },
    ]);
  });
});

describe('test(): runs with mixed outcomes', () => {
  it.each(['node-mixed-spec', 'node-mixed-tap'])('%s: cancelled apart from failed, TODO not listed, several lines kept', async (name) => {
    const r = await replay(name);
    expect(r).toMatchObject({ parsed: true, passed: 2, failed: 2, skipped: 2, cancelled: 1, truncated: false });
    const failures = r['failures'] as { name: string; message: string }[];
    expect(failures.map((f) => f.name)).toEqual(['failure # SKIP: café 🚀', 'child fails', 'before suite', 'after suite']);
    expect(failures[0]?.message).toContain("cannot read Bob's item\nsecond detail");
  });

  it.each(['node-duplicate-spec', 'node-duplicate-tap'])('%s: tests with the same name and place are both kept', async (name) => {
    const failures = (await replay(name))['failures'] as { name: string; message: string; line: number }[];
    expect(failures).toHaveLength(2);
    expect(failures.map((f) => f.message.replace('Error: ', ''))).toEqual(['first', 'second']);
  });

  it('a test that prints a summary of another runner does not replace the real one', async () => {
    expect(await replay('node-spoof')).toMatchObject({ ok: true, parsed: true, passed: 1, failed: 0, failures: [] });
  });

  it('pytest: parametrized ids, fixture errors and several lines', async () => {
    const r = await replay('pytest-mixed');
    expect(r).toMatchObject({ parsed: true, passed: 2, failed: 4, skipped: 2 });
    expect(r['failures']).toEqual([
      { name: 'test_mixed.py::test_parameter[special [bracket] with spaces]', message: 'ValueError: first line\nsecond detail', file: 'test_mixed.py', line: 16 },
      { name: 'test_mixed.py::TestNested::test_failure', message: 'ValueError: nested detail', file: 'test_mixed.py', line: 20 },
      { name: 'test_mixed.py::test_before', message: 'RuntimeError: before failure', file: 'test_mixed.py', line: 24 },
      { name: 'test_mixed.py::test_after', message: 'RuntimeError: after failure', file: 'test_mixed.py', line: 29 },
    ]);
  });

  it('pytest: a collection error', async () => {
    expect((await replay('pytest-import'))['failures']).toEqual([{ name: 'test_import.py', message: "ModuleNotFoundError: No module named 'imaginary_missing_module'", file: 'test_import.py', line: 1 }]);
  });

  it('jest: several lines, and a suite that failed to run', async () => {
    const r = await replay('jest-mixed');
    expect(r).toMatchObject({ parsed: true, passed: 2, failed: 3 });
    expect((r['failures'] as { message: string }[])[0]?.message).toBe('first line\nsecond detail');
  });

  it('jest: a syntax error is a failure, never parsed with failed: 0', async () => {
    const r = await replay('jest-syntax');
    expect(r).toMatchObject({ ok: false, parsed: true, failed: 1 });
    expect((r['failures'] as { name: string; file: string }[])[0]).toMatchObject({ name: 'Test suite failed to run', file: 'syntax.test.js' });
  });

  it('jest: a test named Console is not taken for the console section', async () => {
    expect((await replay('jest-console'))['failures']).toEqual([{ name: 'Console', message: 'failure named Console', file: 'console.test.js', line: 1 }]);
  });

  it('jest: the real console section is not a failure', async () => {
    const stderr = 'FAIL ./a.test.js\n  ● Console\n\n    console.log\n      hello\n\n  ● fails\n\n    boom\n\n      at Object.fn (a.test.js:3:9)\n\nTest Suites: 1 failed, 1 total\nTests:       1 failed, 1 total\n';
    expect((await report({ exitCode: 1, stderr }))['failures']).toEqual([{ name: 'fails', message: 'boom', file: 'a.test.js', line: 3 }]);
  });

  it('vitest: several lines, and suite hooks', async () => {
    const r = await replay('vitest-mixed');
    expect(r).toMatchObject({ parsed: true, passed: 2, failed: 2, skipped: 3 });
    const failures = r['failures'] as { name: string; message: string }[];
    expect(failures.find((f) => f.name.endsWith('failure café 🚀'))?.message).toBe('Error: first line\nsecond detail');
  });

  it('vitest: a file that fails to import', async () => {
    const r = await replay('vitest-import');
    expect(r).toMatchObject({ parsed: true, failed: 1 });
    expect((r['failures'] as { file: string; line: number }[])[0]).toMatchObject({ file: 'import.test.mjs', line: 1 });
  });

  it('vitest: a path with spaces', async () => {
    expect((await replay('vitest-space'))['failures']).toEqual([{ name: 'space case.test.mjs > fails in file with spaces', message: 'Error: correct file', file: 'space case.test.mjs', line: 2 }]);
  });
});

const VITEST_END = ' Test Files  1 failed (1)\n      Tests  1 failed (1)\n   Start at  10:00:00\n';
const vitestBlock = (name: string, line: number): string => `⎯⎯⎯ Failed Tests 1 ⎯⎯⎯\n\n FAIL  a.test.ts > ${name}\nError: nope\n ❯ a.test.ts:${line}:3\n\n⎯⎯⎯[1/1]⎯\n\n`;

describe('test(): the verdict', () => {
  it('ok is false after a timeout, even with exit code 0', async () => {
    expect(await report({ exitCode: 0, timedOut: true, stdout: fixture('node-spec') })).toMatchObject({ ok: false, exitCode: 0, timedOut: true, parsed: false });
  });

  it('a summary that contradicts the exit code is not believed', async () => {
    expect(await report({ exitCode: 0, stdout: fixture('vitest') })).toMatchObject({ ok: true, parsed: false, passed: 0, failed: 0, failures: [] });
    const passing = ' Test Files  1 passed (1)\n      Tests  3 passed (3)\n   Start at  10:00:00\n';
    expect(await report({ exitCode: 1, stdout: passing })).toMatchObject({ ok: false, parsed: false, passed: 0, failed: 0 });
  });

  it('the last summary of the stream counts, and an incomplete block is no summary', async () => {
    const forged = ' Test Files  9 failed (9)\n      Tests  900 failed (900)\n   Start at  10:00:00\n';
    expect(await report({ exitCode: 0, stdout: `${forged}${recorded['node-spoof']?.stdout ?? ''}` })).toMatchObject({ parsed: true, passed: 1, failed: 0 });
    expect(await report({ exitCode: 1, stdout: `      Tests  900 failed (900)\n${vitestBlock('x', 1)}` })).toMatchObject({ parsed: false, failed: 0 });
  });

  it('two streams that each claim a different summary are not believed', async () => {
    const r = await report({ exitCode: 1, stdout: fixture('vitest'), stderr: fixture('jest') });
    expect(r).toMatchObject({ parsed: false, failed: 0, failures: [] });
    expect(r['output']).toBeDefined();
  });

  it('fewer failures found than the summary counts is not parsed', async () => {
    const stdout = `${vitestBlock('only', 3)} Test Files  1 failed (1)\n      Tests  2 failed (2)\n   Start at  10:00:00\n`;
    expect(await report({ exitCode: 1, stdout })).toMatchObject({ parsed: false, failed: 0, failures: [] });
  });

  it('a failing exit with failed: 0 is never parsed', async () => {
    const stdout = 'ℹ tests 1\nℹ suites 0\nℹ pass 1\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 5\n';
    expect(await report({ exitCode: 1, stdout })).toMatchObject({ ok: false, parsed: false, failed: 0 });
    expect(await report({ exitCode: 0, stdout })).toMatchObject({ ok: true, parsed: true, passed: 1 });
  });

  it('a failing exit with nothing recognized is parsed: false and carries the end of the output', async () => {
    const r = await report({ exitCode: 2, stderr: `${'x'.repeat(10_000)}\nSyntaxError: unexpected token\n` });
    expect(r).toMatchObject({ ok: false, parsed: false, passed: 0, failed: 0, failures: [] });
    expect(r['output']).toMatch(/SyntaxError: unexpected token\n*$/);
    expect(String(r['output']).length).toBeLessThanOrEqual(4_000);
  });

  it('the output ends with what was printed last, whichever stream that was', async () => {
    const r = await report({ exitCode: 4, stdout: 'FINAL', stderr: 'OLD', outputTail: 'OLDFINAL' });
    expect(r['output']).toBe('OLDFINAL');
  });

  it('the end of the output does not start in the middle of a character', async () => {
    const r = await report({ exitCode: 4, stdout: `${'😀'.repeat(3_000)}` });
    expect(String(r['output']).charCodeAt(0)).toBe('😀'.charCodeAt(0));
  });

  it('a passing run without a recognized report is ok, parsed: false and has no output', async () => {
    const r = await report({ exitCode: 0, stdout: 'all good\n' });
    expect(r).toMatchObject({ ok: true, parsed: false });
    expect(r).not.toHaveProperty('output');
  });

  it('a run killed by its timeout is not ok', async () => {
    expect(await report({ exitCode: null, signal: 'SIGKILL', timedOut: true, stdout: 'running' })).toMatchObject({ ok: false, exitCode: null, timedOut: true, parsed: false });
  });

  it('joins the start and the end of a cut stream, so a failure across the cut is listed once and whole', async () => {
    const whole = `${vitestBlock('single', 17)}${VITEST_END}`;
    const cut = whole.indexOf('a.test.ts:17');
    const r = await report({ exitCode: 1, truncated: true, stdout: whole.slice(0, cut), stdoutTail: whole.slice(cut), stdoutOmitted: 0 });
    expect(r).toMatchObject({ parsed: true, failed: 1, truncated: true });
    expect(r['failures']).toEqual([{ name: 'a.test.ts > single', message: 'Error: nope', file: 'a.test.ts', line: 17 }]);
  });

  it('does not join lines across bytes that were lost', async () => {
    const r = await report({ exitCode: 0, truncated: true, stdout: 'ℹ tests 1\nℹ suites 0\nℹ pa', stdoutTail: 'ss 1\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 5\n', stdoutOmitted: 9 });
    expect(r).toMatchObject({ parsed: false });
  });

  it('limits the failures listed, says so, and limits each message', async () => {
    const rows = Array.from({ length: 80 }, (_, i) => `FAILED t.py::test_${i} - ${'m'.repeat(900)}`).join('\n');
    const r = await report({ exitCode: 1, stdout: `==== short test summary info ====\n${rows}\n==== 80 failed in 1.00s ====\n` });
    const failures = r['failures'] as { message: string }[];
    expect(r).toMatchObject({ parsed: true, failed: 80, truncated: true });
    expect(failures).toHaveLength(50);
    expect(failures[0]?.message.length).toBeLessThan(530);
  });

  it('a list that fits is not reported as cut', async () => {
    expect(await report({ exitCode: 1, stdout: fixture('pytest') })).toMatchObject({ truncated: false });
  });

  it('removes terminal colors before reading', async () => {
    const stdout = `\u001b[31m${vitestBlock('x', 2)}\u001b[39m\u001b[2m Test Files \u001b[22m \u001b[31m1 failed\u001b[39m (1)\n\u001b[2m      Tests \u001b[22m \u001b[31m1 failed\u001b[39m (1)\n\u001b[2m   Start at \u001b[22m 10:00:00\n`;
    expect(await report({ exitCode: 1, stdout })).toMatchObject({ parsed: true, failed: 1 });
  });

  it('looks only at the end of a very long output', async () => {
    const summary = 'ℹ tests 1\nℹ suites 0\nℹ pass 1\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 5\n';
    expect(await report({ exitCode: 0, stdout: `${summary}${'noise line\n'.repeat(100_000)}` })).toMatchObject({ ok: true, parsed: false });
  });

  it('answers within the sandbox limit for megabytes of repeated failure lines', async () => {
    const line = 'not ok 1 - z\n'.repeat(190_000);
    const started = Date.now();
    const r = await report({ exitCode: 1, truncated: true, stdout: line.slice(0, 1_048_576), stdoutTail: line.slice(-65_536), stdoutOmitted: 1_000_000, stderr: line.slice(0, 1_048_576) });
    expect(r).toMatchObject({ ok: false, parsed: false });
    expect(Date.now() - started).toBeLessThan(12_000);
  });
});

describe('test(): choosing the command', () => {
  const withPackage = (content: string) => (tool: string): CallReply =>
    tool === 'read' ? { ok: true, value: { path: 'package.json', content, startLine: 1, totalLines: 1, truncated: false } } : { ok: true, value: bashResult({}) };

  it('runs the command as given, through the bash binding, with its cwd and timeout', async () => {
    const { calls } = await script('return await test({command: "make check", cwd: "pkg", timeoutMs: 5000});', ran({}));
    expect(calls).toEqual([{ tool: 'bash', args: { command: 'make check', cwd: 'pkg', timeoutMs: 5000 } }]);
  });

  it('a package.json with a test script: npm test --silent', async () => {
    const { calls } = await script('return await test();', withPackage('{"scripts":{"test":"vitest run"}}'));
    expect(calls).toEqual([
      { tool: 'read', args: { path: 'package.json', limit: 1_000_000 } },
      { tool: 'bash', args: { command: 'npm test --silent' } },
    ]);
  });

  it('looks for package.json in the given cwd', async () => {
    const { calls } = await script('return await test({cwd: "pkg"});', withPackage('{"scripts":{"test":"x"}}'));
    expect(calls[0]?.args).toMatchObject({ path: 'pkg/package.json' });
    expect(calls[1]?.args).toEqual({ command: 'npm test --silent', cwd: 'pkg' });
  });

  it('a package.json without a test script: node --test', async () => {
    const { calls } = await script('return await test();', withPackage('{"name":"x"}'));
    expect(calls[1]?.args).toEqual({ command: 'node --test' });
  });

  it('no package.json: node --test', async () => {
    const { calls } = await script('return await test();', ran({}));
    expect(calls.map((c) => c.tool)).toEqual(['read', 'bash']);
    expect(calls[1]?.args).toEqual({ command: 'node --test' });
  });

  it('a read the host refuses rejects, and nothing runs', async () => {
    const denied: CallReply = { ok: false, error: { name: 'PermissionDenied', code: 'denied', source: 'rule', message: 'denied by rule' } };
    const { value, calls } = await script('try { await test(); return "ran"; } catch (e) { return [e.name, e.code]; }', () => denied);
    expect(value).toEqual(['PermissionDenied', 'denied']);
    expect(calls.map((c) => c.tool)).toEqual(['read']);
  });

  it('a package.json too large to read whole has its own error, and nothing runs', async () => {
    const big = (tool: string): CallReply => (tool === 'read' ? { ok: true, value: { path: 'package.json', content: '{"scripts":', startLine: 1, totalLines: 2, truncated: true } } : { ok: true, value: bashResult({}) });
    const { value, calls } = await script('try { await test(); } catch (e) { return [e.name, e.message]; }', big);
    expect(value).toEqual(['ToolError', 'test: package.json is too large to read whole; pass a command']);
    expect(calls.map((c) => c.tool)).toEqual(['read']);
  });

  it('an invalid package.json and an unknown option are errors the script sees', async () => {
    const bad = await script('try { await test(); } catch (e) { return e.message; }', withPackage('{oops'));
    expect(bad.value).toContain('not valid JSON');
    const unknown = await script('try { await test({comand: "x"}); } catch (e) { return [e.name, e.message]; }', ran({}));
    expect(unknown.value).toEqual(['ToolError', 'test: unknown option comand']);
    expect(unknown.calls).toEqual([]);
  });
});
