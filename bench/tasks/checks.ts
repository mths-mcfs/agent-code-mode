import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
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

export function runNodeTests(workspace: string, timeoutMs = 60_000): Promise<NodeTestRun> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', '--test-reporter=spec'], { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '' } });
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
