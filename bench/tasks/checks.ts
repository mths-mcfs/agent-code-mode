import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BashContainment } from '../../src/core/types.js';
import { killGroup } from '../lib/proc.ts';
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
  /** Failing test names from the whole output: the tail in `output` loses the first ones when many fail. */
  readonly failed: readonly string[];
}

/** The tests' environment: none of the operator's beyond PATH, and temp files in `tmp`. */
function testEnv(pathVar: string, tmp: string): Record<string, string> {
  return { PATH: pathVar, TMPDIR: tmp, TMP: tmp, TEMP: tmp, NODE_OPTIONS: '', ...(process.env['SystemRoot'] === undefined ? {} : { SystemRoot: process.env['SystemRoot'] }) };
}

interface TestProcess {
  readonly exitCode: number | null;
  readonly output: string;
  readonly timedOut: boolean;
}

/**
 * Off Windows: `node --test` in the containment the runtime gives `bash` (src/tools/bash.ts), with writes
 * only inside the workspace and the temp dir, no network, and the whole process tree killed on timeout.
 */
async function runContained(cwd: string, tmp: string, timeoutMs: number, files: readonly string[]): Promise<TestProcess> {
  // Loaded on first use, once the hook above lets plain Node resolve src/'s `.js` imports to its sources.
  const { findBash, runBash, shellQuote } = await import('../../src/tools/bash.js');
  const vars = Object.entries(testEnv('', tmp)).map(([k, v]) => (k === 'PATH' ? 'PATH="$PATH"' : `${k}=${shellQuote(v)}`));
  const command = `exec env -i ${vars.join(' ')} ${shellQuote(process.execPath)} --test --test-reporter=spec${files.map((f) => ` ${shellQuote(f)}`).join('')}`;
  const containment: BashContainment = { mode: 'sandbox', readOnly: false, writableRoots: [cwd, tmp], network: false };
  const r = await runBash({ command, shell: { path: findBash() ?? 'bash', args: ['-c'] }, cwd, timeoutMs, containment }, new AbortController().signal);
  return { exitCode: r.exitCode, output: `${r.stdout}${r.stderr}`, timedOut: r.timedOut };
}

/** Windows has no such sandbox: the tests run unconfined, with the same environment, and their tree is killed on timeout. */
function runUnconfined(cwd: string, tmp: string, timeoutMs: number, files: readonly string[]): Promise<TestProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', '--test-reporter=spec', ...files], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: testEnv(process.env['PATH'] ?? '', tmp) });
    let output = '';
    let timedOut = false;
    child.stdout.on('data', (d: Buffer) => (output += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (output += d.toString('utf8')));
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) killGroup(child.pid);
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, output, timedOut });
    });
  });
}

/** Runs `node --test` on the agent's code in the workspace. A run that cannot start, containment that is unavailable included, is a failed run. */
export async function runNodeTests(workspace: string, timeoutMs = 60_000, files: readonly string[] = []): Promise<NodeTestRun> {
  let tmp: string | undefined;
  try {
    const cwd = realpathSync.native(workspace);
    tmp = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), 'bench-tests-')));
    const r = process.platform === 'win32' ? await runUnconfined(cwd, tmp, timeoutMs, files) : await runContained(cwd, tmp, timeoutMs, files);
    const output = r.timedOut ? `${r.output}\nError: node --test timed out after ${timeoutMs} ms` : r.output;
    // Spec reporter prints `ℹ pass 13`, TAP prints `# pass 13` (Node 22 without a TTY).
    const num = (label: string): number => Number(new RegExp(`^(?:ℹ|#) ${label} (\\d+)`, 'm').exec(output)?.[1] ?? '0');
    return { ok: r.exitCode === 0 && !r.timedOut, pass: num('pass'), fail: num('fail'), output: output.slice(-4000), failed: failedTests(output) };
  } catch (err) {
    return { ok: false, pass: 0, fail: 0, output: `Error: node --test could not start: ${err instanceof Error ? err.message : String(err)}`, failed: [] };
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

/** A deletion is never covered by `allowed`: a task that asks for one names the exact files in `allowedDeletions`. */
export async function checkScope(
  checks: Checks,
  workspace: string,
  initial: ReadonlyMap<string, string>,
  allowed?: (file: string) => boolean,
  opts: { readonly allowedDeletions?: readonly string[] } = {},
): Promise<void> {
  const c = await treeChanges(workspace, initial);
  if (allowed === undefined) {
    const all = [...c.modified.map((f) => `modified ${f}`), ...c.deleted.map((f) => `deleted ${f}`), ...c.added.map((f) => `added ${f}`)];
    checks.check(all.length === 0, all.length === 0 ? 'workspace unchanged (read-only task)' : `read-only task changed the workspace: ${all.join(', ')}`);
    return;
  }
  const outside = [...c.modified.filter((f) => !allowed(f)).map((f) => `modified ${f}`), ...c.deleted.filter((f) => !(opts.allowedDeletions ?? []).includes(f)).map((f) => `deleted ${f}`)];
  checks.check(outside.length === 0, outside.length === 0 ? 'no file outside the task changed' : `changed outside the task: ${outside.join(', ')}`);
  if (c.added.length > 0) checks.check(true, `new files (allowed): ${c.added.join(', ')}`);
}

/**
 * Runs tests the agent never saw: the workspace is copied without `.git` to a temporary directory, the
 * hidden files are added there under `hidden-tests/`, and only they run. The workspace itself is never
 * written, so the recorded diff is the agent's alone.
 */
export async function runHiddenTests(workspace: string, hidden: Readonly<Record<string, string>>, timeoutMs = 60_000): Promise<NodeTestRun> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'acm-hidden-'));
  try {
    await cp(workspace, dir, { recursive: true, filter: (src) => path.basename(src) !== '.git' });
    await mkdir(path.join(dir, 'hidden-tests'), { recursive: true });
    const files: string[] = [];
    for (const [name, text] of Object.entries(hidden)) {
      const rel = `hidden-tests/${name}`;
      await writeFile(path.join(dir, rel), text);
      files.push(rel);
    }
    return await runNodeTests(dir, timeoutMs, files);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function failedTests(output: string): string[] {
  return [...new Set([...output.matchAll(/^\s*✖ (.+?)(?: \([\d.]+m?s\))?$/gm)].map((m) => (m[1] ?? '').trim()))].filter((n) => n !== '' && !/^failing tests:?$/.test(n));
}
