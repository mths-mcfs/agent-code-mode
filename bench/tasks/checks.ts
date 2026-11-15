import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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

/** The text after the last `ANSWER:` marker, or the whole answer when there is none. */
export function answerSection(answer: string): string {
  const i = answer.lastIndexOf('ANSWER:');
  return i === -1 ? answer : answer.slice(i + 'ANSWER:'.length);
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

/** Runs `node --test` in the workspace (same Node as the harness), with a timeout. */
export function runNodeTests(workspace: string, timeoutMs = 60_000): Promise<NodeTestRun> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test'], { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '' } });
    let output = '';
    child.stdout.on('data', (d: Buffer) => (output += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (output += d.toString('utf8')));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      const num = (label: string): number => Number(new RegExp(`^ℹ ${label} (\\d+)`, 'm').exec(output)?.[1] ?? '0');
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
