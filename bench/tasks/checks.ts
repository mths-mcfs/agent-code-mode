import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { VerifyResult } from './types.ts';

/** Collects check lines; `pass` is true only when every check passed. */
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

/**
 * The answer block the prompts ask for: the text after the last line that starts with `ANSWER:`
 * (leading spaces allowed), or undefined when there is no such line. With `lastLine`, the `ANSWER:`
 * line must also be the last non-empty line and only its own text is returned ("End your reply with
 * a line `ANSWER: <value>`").
 */
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

/** Removes whitespace, backticks and asterisks, so formatting does not matter. */
export function squash(text: string): string {
  return text.replace(/[\s`*]+/g, '');
}

export interface NodeTestRun {
  readonly ok: boolean;
  readonly pass: number;
  readonly fail: number;
  readonly output: string;
}

/** Runs `node --test` in the workspace (same Node as the harness), with a timeout; `files` limits it to those test files. */
export function runNodeTests(workspace: string, timeoutMs = 60_000, files: readonly string[] = []): Promise<NodeTestRun> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', '--test-reporter=spec', ...files], { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '' } });
    let output = '';
    child.stdout.on('data', (d: Buffer) => (output += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (output += d.toString('utf8')));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      // Spec reporter prints `ℹ pass 13`, TAP prints `# pass 13` (Node 22 without a TTY).
      const num = (label: string): number => Number(new RegExp(`^(?:ℹ|#) ${label} (\\d+)`, 'm').exec(output)?.[1] ?? '0');
      resolve({ ok: code === 0, pass: num('pass'), fail: num('fail'), output: output.slice(-4000) });
    });
  });
}

/** Checks that each file still has its initial content. */
export async function checkUnchanged(checks: Checks, workspace: string, initial: ReadonlyMap<string, string>, files: readonly string[], label: string): Promise<void> {
  const changed: string[] = [];
  for (const file of files) if ((await readWorkspaceFile(workspace, file)) !== initial.get(file)) changed.push(file);
  checks.check(changed.length === 0, changed.length === 0 ? `${label} unchanged` : `${label} changed: ${changed.join(', ')}`);
}

/** Replaces exactly one occurrence of `from`, failing loudly when it is missing or repeated. */
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

/** Every difference between the workspace and its initial tree (`.git` excluded), like `git status --untracked-files=all`. */
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

/**
 * Checks that nothing outside `allowed` changed. Read-only tasks pass no `allowed` and also forbid new
 * files (the workspace must equal its initial commit); edit tasks may leave new files (listed, not failed)
 * but may not modify or delete any file they were not asked to touch.
 */
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

/**
 * Runs hidden tests: tests the agent never saw. The workspace is copied (without `.git`) to a temporary
 * directory, the hidden files are added there under `hidden-tests/`, and only they run. The workspace
 * itself is never written, so the recorded diff is the agent's alone.
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

/** Failing test names from spec-reporter output (lines starting with the cross mark). */
export function failedTests(output: string): string[] {
  return [...new Set([...output.matchAll(/^\s*✖ (.+?)(?: \([\d.]+m?s\))?$/gm)].map((m) => (m[1] ?? '').trim()))].filter((n) => n !== '' && !/^failing tests:?$/.test(n));
}
