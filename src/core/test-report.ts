import type { BashResult, TestFailure, TestResult } from './types.js';

/** Most failures one `test()` result lists. */
export const MAX_TEST_FAILURES = 50;
/** Only the end of the output is read: runners print their totals last. */
const MAX_PARSE_CHARS = 256 * 1024;
/** Longer lines are cut before any pattern runs on them. */
const MAX_LINE_CHARS = 2_000;
const MAX_NAME_CHARS = 300;
const MAX_MESSAGE_CHARS = 500;
const TAIL_LINES = 40;
const TAIL_CHARS = 4_000;

interface Totals {
  passed: number;
  failed: number;
  skipped: number;
}

interface Runner {
  readonly name: string;
  totals(lines: readonly string[]): Totals | undefined;
  failures(lines: readonly string[]): TestFailure[];
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function count(text: string, words: Readonly<Record<string, keyof Totals>>): Totals | undefined {
  const totals: Totals = { passed: 0, failed: 0, skipped: 0 };
  let found = false;
  for (const m of text.matchAll(/(\d+) ([a-z]+)/g)) {
    const key = words[m[2] ?? ''];
    if (key === undefined) continue;
    totals[key] += Number(m[1]);
    found = true;
  }
  return found ? totals : undefined;
}

function lastMatch(lines: readonly string[], pattern: RegExp): RegExpExecArray | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = pattern.exec(lines[i] ?? '');
    if (m) return m;
  }
  return undefined;
}

function messageAfter(lines: readonly string[], index: number, strip: RegExp = /^\s+/): string | undefined {
  for (let i = index + 1; i < Math.min(lines.length, index + 6); i++) {
    const text = (lines[i] ?? '').replace(strip, '').trim();
    if (text !== '') return clip(text, MAX_MESSAGE_CHARS);
  }
  return undefined;
}

function failure(name: string, message: string | undefined): TestFailure {
  return message === undefined ? { name: clip(name.trim(), MAX_NAME_CHARS) } : { name: clip(name.trim(), MAX_NAME_CHARS), message };
}

function collect(lines: readonly string[], pattern: RegExp, message: (i: number, m: RegExpExecArray) => string | undefined): TestFailure[] {
  const out: TestFailure[] = [];
  for (let i = 0; i < lines.length && out.length < MAX_TEST_FAILURES + 1; i++) {
    const m = pattern.exec(lines[i] ?? '');
    if (m?.[1] !== undefined) out.push(failure(m[1], message(i, m)));
  }
  return out;
}

const VITEST: Runner = {
  name: 'vitest',
  totals: (lines) => {
    const m = lastMatch(lines, /^\s*Tests\s{2,}(.+?)\s*\(\d+\)\s*$/);
    return m?.[1] === undefined ? undefined : count(m[1], { passed: 'passed', failed: 'failed', skipped: 'skipped', todo: 'skipped' });
  },
  failures: (lines) => collect(lines, /^\s*FAIL\s+(.+\S)\s*$/, (i) => messageAfter(lines, i)),
};

const JEST: Runner = {
  name: 'jest',
  totals: (lines) => {
    const m = lastMatch(lines, /^Tests:\s+(.+)$/);
    return m?.[1] === undefined ? undefined : count(m[1], { passed: 'passed', failed: 'failed', skipped: 'skipped', todo: 'skipped' });
  },
  // `● Console` heads the logs a passing test printed, not a failure.
  failures: (lines) => collect(lines, /^\s*● (?!Console\s*$)(.+\S)\s*$/, (i) => messageAfter(lines, i)),
};

const PYTEST: Runner = {
  name: 'pytest',
  totals: (lines) => {
    const m = lastMatch(lines, /^=+ (.+) in [\d.]+s(?: \([^)]*\))? =+$/);
    return m?.[1] === undefined
      ? undefined
      : count(m[1], { passed: 'passed', failed: 'failed', error: 'failed', errors: 'failed', skipped: 'skipped', xfailed: 'skipped', xpassed: 'passed', deselected: 'skipped' });
  },
  failures: (lines) => collect(lines, /^(?:FAILED|ERROR) (\S+)/, (i) => {
    const rest = / - (.+)$/.exec(lines[i] ?? '')?.[1];
    return rest === undefined ? undefined : clip(rest, MAX_MESSAGE_CHARS);
  }),
};

/** `node --test` with the spec reporter (`ℹ pass 1`) or TAP (`# pass 1`). */
function nodeTotals(lines: readonly string[], prefix: string): Totals | undefined {
  const totals: Totals = { passed: 0, failed: 0, skipped: 0 };
  const key: Readonly<Record<string, keyof Totals>> = { pass: 'passed', fail: 'failed', cancelled: 'failed', skipped: 'skipped', todo: 'skipped' };
  const pattern = new RegExp(`^${prefix} (pass|fail|cancelled|skipped|todo) (\\d+)$`);
  let found = false;
  for (const line of lines) {
    const m = pattern.exec(line);
    const k = key[m?.[1] ?? ''];
    if (m === null || k === undefined) continue;
    totals[k] += Number(m[2]);
    found = true;
  }
  return found ? totals : undefined;
}

const NODE_SPEC: Runner = {
  name: 'node:test',
  totals: (lines) => nodeTotals(lines, 'ℹ'),
  failures: (lines) => {
    const start = lines.findIndex((l) => /^✖ failing tests:/.test(l));
    if (start === -1) return [];
    return collect(lines.slice(start + 1), /^✖ (.+?)(?: \([\d.]+m?s\))?$/, (i) => messageAfter(lines.slice(start + 1), i));
  },
};

const TAP: Runner = {
  name: 'tap',
  totals: (lines) => nodeTotals(lines, '#'),
  failures: (lines) =>
    // A `# TODO` result does not fail the run.
    collect(lines, /^\s*not ok \d+ - (?!.*# TODO\b)(.+?)(?: # .*)?$/i, (i) => {
      for (let j = i + 1; j < Math.min(lines.length, i + 12); j++) {
        const m = /^\s*error: (.+)$/.exec(lines[j] ?? '');
        if (m?.[1] !== undefined && m[1] !== '|-') return clip(m[1].replace(/^'(.*)'$/, '$1'), MAX_MESSAGE_CHARS);
        if (/^\s*(?:not )?ok \d+/.test(lines[j] ?? '')) break;
      }
      return undefined;
    }),
};

const CARGO: Runner = {
  name: 'cargo',
  totals: (lines) => {
    let totals: Totals | undefined;
    for (const line of lines) {
      const m = /^test result: \w+\. (.+)$/.exec(line);
      const t = m?.[1] === undefined ? undefined : count(m[1], { passed: 'passed', failed: 'failed', ignored: 'skipped' });
      if (t === undefined) continue;
      totals ??= { passed: 0, failed: 0, skipped: 0 };
      totals.passed += t.passed;
      totals.failed += t.failed;
      totals.skipped += t.skipped;
    }
    return totals;
  },
  failures: (lines) => collect(lines, /^test (\S+) \.\.\. FAILED$/, () => undefined),
};

/** Checked in this order; the first whose summary is in the output wins. */
const RUNNERS: readonly Runner[] = [VITEST, JEST, PYTEST, NODE_SPEC, TAP, CARGO];

function tail(lines: readonly string[]): string {
  let out = lines.slice(-TAIL_LINES).join('\n');
  if (out.length > TAIL_CHARS) out = `…${out.slice(-(TAIL_CHARS - 1))}`;
  return out;
}

/**
 * Reads the result of a test command. The exit code and timeout decide
 * whether the run passed; the totals and failures found in the output only
 * add detail, and a failure found there makes it not ok. Bounded: only the
 * last 256 KiB of the output, each line cut at 2000 characters.
 */
export function testResult(result: BashResult): TestResult {
  const combined = result.stderr === '' ? result.stdout : result.stdout === '' ? result.stderr : `${result.stdout}\n${result.stderr}`;
  const clipped = combined.length > MAX_PARSE_CHARS;
  const text = (clipped ? combined.slice(-MAX_PARSE_CHARS) : combined).replace(ANSI, '');
  const lines = text.split(/\r?\n/).map((l) => (l.length > MAX_LINE_CHARS ? l.slice(0, MAX_LINE_CHARS) : l));
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  let runner: Runner | undefined;
  let totals: Totals = { passed: 0, failed: 0, skipped: 0 };
  for (const r of RUNNERS) {
    const found = r.totals(lines);
    if (found === undefined) continue;
    runner = r;
    totals = found;
    break;
  }
  // With no runner's totals, any runner's failure lines still count: a wrapper can print them and exit 0.
  const found = runner?.failures(lines) ?? RUNNERS.flatMap((r) => r.failures(lines));
  const failures = found.slice(0, MAX_TEST_FAILURES);
  // A runner's own count wins; the failures it lists also name suites, which it does not count.
  const failed = totals.failed > 0 ? totals.failed : found.length;
  const ok = result.exitCode === 0 && result.signal === null && !result.timedOut && failed === 0;
  return {
    ok,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    runner: runner?.name ?? null,
    passed: totals.passed,
    failed,
    skipped: totals.skipped,
    failures,
    truncated: result.truncated || clipped || found.length > MAX_TEST_FAILURES,
    ...(ok && runner !== undefined ? {} : { output: tail(lines) }),
  };
}
