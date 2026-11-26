import type { BashResult, TestFailure, TestResult } from './types.js';

/** Most failures one `test()` result lists. */
export const MAX_TEST_FAILURES = 50;
/** Only the end of the output is read: runners print their totals last. */
const MAX_PARSE_CHARS = 128 * 1024;
/** Longer lines are cut before any pattern runs on them, so no pattern sees more than this. */
const MAX_LINE_CHARS = 500;
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
  /** `complete`: the lines are the whole output, so result lines can bound the totals. */
  totals(lines: readonly string[], complete: boolean): Totals | undefined;
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

/** The summary text of the last line `read` accepts. */
function lastSummary(lines: readonly string[], read: (trimmed: string) => string | undefined): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const found = read((lines[i] ?? '').trim());
    if (found !== undefined) return found;
  }
  return undefined;
}

function messageAfter(lines: readonly string[], index: number): string | undefined {
  for (let i = index + 1; i < Math.min(lines.length, index + 6); i++) {
    const text = (lines[i] ?? '').trim();
    if (text !== '') return clip(text, MAX_MESSAGE_CHARS);
  }
  return undefined;
}

function failure(name: string, message: string | undefined): TestFailure {
  return message === undefined ? { name: clip(name.trim(), MAX_NAME_CHARS) } : { name: clip(name.trim(), MAX_NAME_CHARS), message };
}

/** `name` reads a failure's name from a trimmed line, or undefined when the line names none. */
function collect(lines: readonly string[], name: (trimmed: string) => string | undefined, message: (i: number) => string | undefined): TestFailure[] {
  const out: TestFailure[] = [];
  for (let i = 0; i < lines.length && out.length < MAX_TEST_FAILURES + 1; i++) {
    const found = name((lines[i] ?? '').trim());
    if (found !== undefined && found !== '') out.push(failure(found, message(i)));
  }
  return out;
}

const after = (trimmed: string, prefix: string): string | undefined => (trimmed.startsWith(prefix) ? trimmed.slice(prefix.length).trim() : undefined);
const countLines = (lines: readonly string[], test: (trimmed: string) => boolean): number => lines.reduce((n, l) => n + (test(l.trim()) ? 1 : 0), 0);

const VITEST: Runner = {
  name: 'vitest',
  totals: (lines) => {
    const body = lastSummary(lines, (t) => {
      const m = /^Tests\s{2,}/.exec(t);
      const open = t.lastIndexOf(' (');
      if (m === null || open < m[0].length || !/^ \(\d+\)$/.test(t.slice(open))) return undefined;
      return t.slice(m[0].length, open);
    });
    return body === undefined ? undefined : count(body, { passed: 'passed', failed: 'failed', skipped: 'skipped', todo: 'skipped' });
  },
  failures: (lines) => collect(lines, (t) => (/^FAIL\s/.test(t) ? t.slice(4).trim() : undefined), (i) => messageAfter(lines, i)),
};

const JEST: Runner = {
  name: 'jest',
  totals: (lines) => {
    const body = lastSummary(lines, (t) => after(t, 'Tests:'));
    return body === undefined ? undefined : count(body, { passed: 'passed', failed: 'failed', skipped: 'skipped', todo: 'skipped' });
  },
  // `● Console` heads the logs a passing test printed, not a failure.
  failures: (lines) => collect(lines, (t) => { const n = after(t, '● '); return n === 'Console' ? undefined : n; }, (i) => messageAfter(lines, i)),
};

const PYTEST: Runner = {
  name: 'pytest',
  totals: (lines) => {
    const body = lastSummary(lines, (t) => {
      if (!t.startsWith('=') || !t.endsWith('=')) return undefined;
      let a = 0;
      let b = t.length;
      while (t[a] === '=') a++;
      while (b > a && t[b - 1] === '=') b--;
      return /^(.*) in [\d.]+s(?: \([^)]*\))?$/.exec(t.slice(a, b).trim())?.[1];
    });
    return body === undefined
      ? undefined
      : count(body, { passed: 'passed', failed: 'failed', error: 'failed', errors: 'failed', skipped: 'skipped', xfailed: 'skipped', xpassed: 'passed', deselected: 'skipped' });
  },
  failures: (lines) =>
    collect(lines, (t) => (t.startsWith('FAILED ') || t.startsWith('ERROR ') ? (t.split(' ')[1] ?? '') : undefined), (i) => {
      const line = lines[i] ?? '';
      const dash = line.indexOf(' - ');
      return dash === -1 ? undefined : clip(line.slice(dash + 3), MAX_MESSAGE_CHARS);
    }),
};

/**
 * `node --test` totals from its own final summary (`ℹ pass 1` or `# pass 1`): the last value of each key, since a
 * test can print lines that look like a summary before it. On the whole output, never more passes than result lines.
 */
function nodeTotals(lines: readonly string[], complete: boolean, prefix: string, isResult: (trimmed: string) => boolean): Totals | undefined {
  const key: Readonly<Record<string, keyof Totals>> = { pass: 'passed', fail: 'failed', cancelled: 'failed', skipped: 'skipped', todo: 'skipped' };
  const last = new Map<string, number>();
  for (const line of lines) {
    const m = /^(\S+) (pass|fail|cancelled|skipped|todo) (\d+)$/.exec(line);
    if (m === null || m[1] !== prefix || m[2] === undefined) continue;
    last.set(m[2], Number(m[3]));
  }
  if (last.size === 0) return undefined;
  const totals: Totals = { passed: 0, failed: 0, skipped: 0 };
  for (const [k, n] of last) totals[key[k] ?? 'skipped'] += n;
  const results = complete ? countLines(lines, isResult) : 0;
  if (results > 0) totals.passed = Math.min(totals.passed, results);
  return totals;
}

const NODE_SPEC: Runner = {
  name: 'node:test',
  totals: (lines, complete) => nodeTotals(lines, complete, 'ℹ', (t) => t.startsWith('✔ ')),
  failures: (lines) => {
    const start = lines.findIndex((l) => l.startsWith('✖ failing tests:'));
    if (start === -1) return [];
    const rest = lines.slice(start + 1);
    return collect(rest, (t) => { const n = after(t, '✖ '); return n?.replace(/ \([\d.]+m?s\)$/, ''); }, (i) => messageAfter(rest, i));
  },
};

const TAP: Runner = {
  name: 'tap',
  totals: (lines, complete) => nodeTotals(lines, complete, '#', (t) => /^ok\b/.test(t)),
  failures: (lines) =>
    collect(
      lines,
      (t) => {
        // TAP lets a result go without its number, its ` - ` or its description.
        const m = /^not ok\b(?: +\d+)?(?: +-)? */.exec(t);
        if (m === null) return undefined;
        const rest = t.slice(m[0].length);
        const hash = rest.startsWith('# ') ? 0 : rest.indexOf(' # ');
        // A `# TODO` or `# SKIP` result does not fail the run.
        if (hash !== -1 && /^ ?# (?:todo|skip)/i.test(rest.slice(hash))) return undefined;
        const name = (hash === -1 ? rest : rest.slice(0, hash)).trim();
        return name === '' ? '(unnamed test)' : name;
      },
      (i) => {
        for (let j = i + 1; j < Math.min(lines.length, i + 12); j++) {
          const t = (lines[j] ?? '').trim();
          const err = after(t, 'error:');
          if (err !== undefined && err !== '|-') return clip(err.replace(/^'(.*)'$/, '$1'), MAX_MESSAGE_CHARS);
          if (/^(?:not )?ok \d+/.test(t)) break;
        }
        return undefined;
      },
    ),
};

const CARGO: Runner = {
  name: 'cargo',
  totals: (lines, complete) => {
    let totals: Totals | undefined;
    for (const line of lines) {
      const body = after(line.trim(), 'test result: ');
      const t = body === undefined ? undefined : count(body, { passed: 'passed', failed: 'failed', ignored: 'skipped' });
      if (t === undefined) continue;
      totals ??= { passed: 0, failed: 0, skipped: 0 };
      totals.passed += t.passed;
      totals.failed += t.failed;
      totals.skipped += t.skipped;
    }
    const results = complete ? countLines(lines, (t) => t.startsWith('test ') && t.endsWith(' ... ok')) : 0;
    if (totals !== undefined && results > 0) totals.passed = Math.min(totals.passed, results);
    return totals;
  },
  failures: (lines) => collect(lines, (t) => (t.startsWith('test ') && t.endsWith(' ... FAILED') ? t.slice(5, -' ... FAILED'.length) : undefined), () => undefined),
};

/** Checked in this order; the first whose summary is in the output wins. */
const RUNNERS: readonly Runner[] = [VITEST, JEST, PYTEST, NODE_SPEC, TAP, CARGO];

function tail(lines: readonly string[]): string {
  let out = lines.slice(-TAIL_LINES).join('\n');
  if (out.length > TAIL_CHARS) out = `…${out.slice(-(TAIL_CHARS - 1))}`;
  return out;
}

/** A long line keeps its start, where the patterns look, and its end, where a TAP directive sits. */
function cutLine(line: string): string {
  return line.length <= MAX_LINE_CHARS ? line : `${line.slice(0, MAX_LINE_CHARS - 100)} … ${line.slice(-97)}`;
}

/**
 * Reads the result of a test command. The exit code and timeout decide
 * whether the run passed; the totals and failures found in the output only
 * add detail, and a failure found anywhere in it makes it not ok. Bounded:
 * failures come from one pass over the whole output, totals from the
 * runner's final summary in its last 128 KiB, every line is cut to 500
 * characters, and every pattern runs in time linear in the line.
 */
export function testResult(result: BashResult): TestResult {
  const combined = result.stderr === '' ? result.stdout : result.stdout === '' ? result.stderr : `${result.stdout}\n${result.stderr}`;
  const raw = combined.replace(ANSI, '').split(/\r?\n/);
  const cut = raw.some((l) => l.length > MAX_LINE_CHARS);
  const lines = cut ? raw.map(cutLine) : raw;
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  let start = lines.length;
  for (let size = 0; start > 0 && size + (lines[start - 1]?.length ?? 0) + 1 <= MAX_PARSE_CHARS; start--) size += (lines[start - 1]?.length ?? 0) + 1;
  const clipped = start > 0;
  const window = clipped ? lines.slice(start) : lines;
  const complete = !clipped && !cut && !result.truncated;

  let runner: Runner | undefined;
  let totals: Totals = { passed: 0, failed: 0, skipped: 0 };
  for (const r of RUNNERS) {
    const found = r.totals(window, complete);
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
    truncated: result.truncated || clipped || cut || found.length > MAX_TEST_FAILURES,
    ...(ok && runner !== undefined ? {} : { output: tail(window) }),
  };
}
