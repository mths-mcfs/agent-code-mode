import { realpathSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BashContainment } from '../../src/core/types.js';
import '../lib/register-src.mjs';
import type { VerifyResult } from './types.ts';

export class Checks {
  private readonly lines: string[] = [];
  private failed = false;

  check(ok: boolean, message: string): boolean {
    this.lines.push(`${ok ? 'ok' : 'FAIL'} ${message}`);
    if (!ok) this.failed = true;
    return ok;
  }

  result(): VerifyResult {
    return { pass: !this.failed && this.lines.length > 0, details: [...this.lines] };
  }
}

export async function readWorkspaceFile(workspace: string, rel: string): Promise<string | undefined> {
  try {
    return await readFile(path.join(workspace, ...rel.split('/')), 'utf8');
  } catch {
    return undefined;
  }
}

export function answerBlock(answer: string, opts: { readonly lastLine: boolean }): string | undefined {
  const lines = answer.replace(/\r\n/g, '\n').split('\n');
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*ANSWER:/.test(lines[i] ?? '')) {
      at = i;
      break;
    }
  }
  if (at === -1) return undefined;
  const first = (lines[at] ?? '').replace(/^\s*ANSWER:/, '');
  const rest = lines.slice(at + 1);
  if (opts.lastLine) return rest.every((l) => l.trim() === '') ? first : undefined;
  return [first, ...rest].join('\n');
}

export function squash(text: string): string {
  return text.replace(/[\s`*]+/g, '');
}

export interface NodeTestRun {
  readonly ok: boolean;
  readonly pass: number;
  readonly fail: number;
  readonly output: string;
}

/**
 * The command that runs the tests: none of the operator's environment beyond PATH, temp files in `tmp`.
 * `SystemRoot` is what Node needs on Windows.
 */
function testCommand(tmp: string, shellQuote: (s: string) => string): string {
  const vars = [`PATH="$PATH"`, ...['TMPDIR', 'TMP', 'TEMP'].map((k) => `${k}=${shellQuote(tmp)}`), 'NODE_OPTIONS=', ...(process.platform === 'win32' ? ['SystemRoot="$SYSTEMROOT"'] : [])];
  return `exec env -i ${vars.join(' ')} ${shellQuote(process.execPath)} --test --test-reporter=spec`;
}

/**
 * Runs `node --test` on the agent's code in the containment the runtime gives `bash`: writes only inside
 * the workspace and a temp dir of its own, no network, and the whole process tree killed on timeout.
 * Windows has no such sandbox, so there the tests run unconfined, with the same environment and tree
 * cleanup. A run that cannot start, containment that is unavailable included, is a failed run.
 */
export async function runNodeTests(workspace: string, timeoutMs = 60_000): Promise<NodeTestRun> {
  let tmp: string | undefined;
  try {
    // Loaded on first use, once the hook above lets plain Node resolve src/'s `.js` imports to its sources.
    const { findBash, runBash, shellQuote } = await import('../../src/tools/bash.js');
    const cwd = realpathSync.native(workspace);
    tmp = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), 'bench-tests-')));
    const containment: BashContainment = process.platform === 'win32' ? { mode: 'none' } : { mode: 'sandbox', readOnly: false, writableRoots: [cwd, tmp], network: false };
    const r = await runBash({ command: testCommand(tmp, shellQuote), shell: { path: findBash() ?? 'bash', args: ['-c'] }, cwd, timeoutMs, containment }, new AbortController().signal);
    let output = `${r.stdout}${r.stderr}`;
    if (r.timedOut) output += `\nError: node --test timed out after ${timeoutMs} ms`;
    // Spec reporter prints `ℹ pass 13`, TAP prints `# pass 13` (Node 22 without a TTY).
    const num = (label: string): number => Number(new RegExp(`^(?:ℹ|#) ${label} (\\d+)`, 'm').exec(output)?.[1] ?? '0');
    return { ok: r.exitCode === 0 && !r.timedOut, pass: num('pass'), fail: num('fail'), output: output.slice(-4000) };
  } catch (err) {
    return { ok: false, pass: 0, fail: 0, output: `Error: node --test could not start: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    if (tmp !== undefined) await rm(tmp, { recursive: true, force: true });
  }
}

/** Runs `node --test` and checks that it passes; a failure names the first failing tests and their errors. */
export async function checkNodeTests(checks: Checks, workspace: string): Promise<void> {
  const tests = await runNodeTests(workspace);
  const passed = tests.ok && tests.fail === 0;
  const failures = tests.output.split('\n').map((l) => l.trim()).filter((l) => /^✖|^not ok|Error|signal|exit code/.test(l)).slice(0, 4);
  checks.check(passed, `node --test passes (pass ${tests.pass}, fail ${tests.fail})${passed || failures.length === 0 ? '' : `: ${failures.join(' | ')}`}`);
}

export async function checkUnchanged(checks: Checks, workspace: string, initial: ReadonlyMap<string, string>, files: readonly string[], label: string): Promise<void> {
  const changed: string[] = [];
  for (const file of files) if ((await readWorkspaceFile(workspace, file)) !== initial.get(file)) changed.push(file);
  checks.check(changed.length === 0, changed.length === 0 ? `${label} unchanged` : `${label} changed: ${changed.join(', ')}`);
}

export function replaceOnce(text: string, from: string, to: string, where: string): string {
  const first = text.indexOf(from);
  if (first === -1 || text.indexOf(from, first + 1) !== -1) throw new Error(`expected exactly one ${JSON.stringify(from)} in ${where}`);
  return text.slice(0, first) + to + text.slice(first + from.length);
}

export function getFile(tree: ReadonlyMap<string, string>, file: string): string {
  const text = tree.get(file);
  if (text === undefined) throw new Error(`fixture has no ${file}`);
  return text;
}

export interface TreeChanges {
  readonly modified: readonly string[];
  readonly deleted: readonly string[];
  readonly added: readonly string[];
}

async function listFiles(root: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(path.join(root, ...rel.split('/').filter(Boolean)), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const child = rel === '' ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) {
      if (child !== '.git') out.push(...(await listFiles(root, child)));
    } else {
      out.push(child);
    }
  }
  return out;
}

export async function treeChanges(workspace: string, initial: ReadonlyMap<string, string>): Promise<TreeChanges> {
  const now = new Set(await listFiles(workspace));
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const [file, text] of initial) {
    if (!now.has(file)) deleted.push(file);
    else if ((await readWorkspaceFile(workspace, file)) !== text) modified.push(file);
  }
  const added = [...now].filter((f) => !initial.has(f)).sort();
  return { modified: modified.sort(), deleted: deleted.sort(), added };
}

export async function checkScope(checks: Checks, workspace: string, initial: ReadonlyMap<string, string>, allowed?: (file: string) => boolean): Promise<void> {
  const c = await treeChanges(workspace, initial);
  if (allowed === undefined) {
    const all = [...c.modified.map((f) => `modified ${f}`), ...c.deleted.map((f) => `deleted ${f}`), ...c.added.map((f) => `added ${f}`)];
    checks.check(all.length === 0, all.length === 0 ? 'workspace unchanged (read-only task)' : `read-only task changed the workspace: ${all.join(', ')}`);
    return;
  }
  const outside = [...c.modified.filter((f) => !allowed(f)).map((f) => `modified ${f}`), ...c.deleted.map((f) => `deleted ${f}`)];
  checks.check(outside.length === 0, outside.length === 0 ? 'no file outside the task changed' : `changed outside the task: ${outside.join(', ')}`);
  if (c.added.length > 0) checks.check(true, `new files (allowed): ${c.added.join(', ')}`);
}
