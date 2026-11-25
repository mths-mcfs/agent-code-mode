import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ToolError, errorMessage } from '../core/errors.js';
import type { BashEffect, BashResult } from '../core/types.js';
import { killPosixTree, startInWindowsJob, type WindowsJob } from './process-tree.js';
import { withSandbox } from './sandbox.js';

/** Default `bash` timeout. */
export const DEFAULT_BASH_TIMEOUT_MS = 120_000;
/** Largest `bash` timeout. */
export const MAX_BASH_TIMEOUT_MS = 600_000;
/** Bytes kept of each of stdout and stderr. */
export const DEFAULT_OUTPUT_CAP_BYTES = 1024 * 1024;
/** After the shell exits, how long to wait for the output pipes to close. */
const DRAIN_MS = 200;

/** Quotes a string for POSIX sh as one word. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

let cachedShell: string | null | undefined;

/** The bash to run commands with: `/bin/bash` or `bash` on PATH; Git Bash on Windows. Null when none. */
export function findBash(): string | null {
  if (cachedShell !== undefined) return cachedShell;
  if (process.platform === 'win32') {
    const candidates = [
      process.env['ProgramFiles'] && path.join(process.env['ProgramFiles'], 'Git', 'bin', 'bash.exe'),
      process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
      process.env['LOCALAPPDATA'] && path.join(process.env['LOCALAPPDATA'], 'Programs', 'Git', 'bin', 'bash.exe'),
    ].filter((p): p is string => typeof p === 'string' && p !== '');
    cachedShell = candidates.find((p) => existsSync(p)) ?? null;
    return cachedShell;
  }
  if (existsSync('/bin/bash')) cachedShell = '/bin/bash';
  else {
    const which = spawnSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' });
    const found = which.status === 0 ? which.stdout.trim() : '';
    cachedShell = found !== '' ? found : null;
  }
  return cachedShell;
}

class Capture {
  readonly #chunks: Buffer[] = [];
  #size = 0;
  truncated = false;

  constructor(private readonly cap: number) {}

  push(chunk: Buffer): void {
    if (this.#size >= this.cap) {
      this.truncated = true;
      return;
    }
    const room = this.cap - this.#size;
    const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
    if (kept.length < chunk.length) this.truncated = true;
    this.#chunks.push(kept);
    this.#size += kept.length;
  }

  text(): string {
    const all = Buffer.concat(this.#chunks);
    return (this.truncated ? all.subarray(0, completeUtf8Length(all)) : all).toString('utf8');
  }
}

/** Length of `bytes` without a UTF-8 character the cut left incomplete at its end. */
function completeUtf8Length(bytes: Buffer): number {
  let start = bytes.length - 1;
  while (start >= 0 && start > bytes.length - 4 && ((bytes[start] ?? 0) & 0xc0) === 0x80) start--;
  if (start < 0) return bytes.length;
  const lead = bytes[start] ?? 0;
  const size = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return start + size > bytes.length ? start : bytes.length;
}

export interface BashRunOptions {
  readonly outputCapBytes?: number;
  /** Paths a sandboxed command may never write (from the host's protected paths). */
  readonly denyWrite?: readonly string[];
}

/**
 * The script `bash -c` runs on Windows: it waits for one line on stdin, sent
 * once the process sits in its Job Object, then runs the command as
 * `bash -c <command>` with stdin closed, as on POSIX.
 */
const WINDOWS_GATE = 'IFS= read -r _ || exit 1; exec "$BASH" -c "$1" </dev/null';

export function spawnAndWait(
  shell: string,
  script: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
  cap: number,
): Promise<BashResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ToolError('cancelled', 'the run was stopped before bash started'));
      return;
    }
    const windows = process.platform === 'win32';
    const args = windows ? ['-c', WINDOWS_GATE, 'bash', script] : ['-c', script];
    const child = spawn(shell, args, {
      cwd,
      env,
      stdio: [windows ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      detached: !windows,
      windowsHide: true,
    });
    const out = new Capture(cap);
    const err = new Capture(cap);
    child.stdout?.on('data', (c: Buffer) => out.push(c));
    child.stderr?.on('data', (c: Buffer) => err.push(c));
    child.stdin?.on('error', () => undefined);

    let startError: ToolError | undefined;
    let killing = false;
    let job: Promise<WindowsJob | undefined> = Promise.resolve(undefined);
    if (windows) {
      job = startInWindowsJob(child, () => killing).catch((e: unknown) => {
        startError ??= new ToolError('tool-error', errorMessage(e));
        return undefined;
      });
    }
    const killAll = async (): Promise<void> => {
      killing = true;
      const pid = child.pid;
      if (pid === undefined) return;
      if (!windows) return killPosixTree(pid);
      await (await job)?.kill();
    };

    let timedOut = false;
    let settled = false;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let drainTimer: NodeJS.Timeout | undefined;

    const finish = (): void => {
      if (settled || !exit) return;
      settled = true;
      clearTimeout(timer);
      if (drainTimer) clearTimeout(drainTimer);
      signal.removeEventListener('abort', onAbort);
      const result: BashResult = {
        exitCode: exit.code,
        signal: exit.signal,
        stdout: out.text(),
        stderr: err.text(),
        truncated: out.truncated || err.truncated,
        timedOut,
      };
      void killAll().then(() => {
        if (startError) reject(startError);
        else if (signal.aborted && !timedOut) reject(new ToolError('cancelled', 'bash was stopped because the run stopped'));
        else resolve(result);
      });
    };
    const onAbort = (): void => void killAll();
    const timer = setTimeout(() => {
      // The shell already exited: only its output was still draining.
      if (exit) return finish();
      timedOut = true;
      void killAll();
    }, timeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });

    child.once('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new ToolError('tool-error', `bash failed to start: ${e.message}`));
    });
    child.once('exit', (code, sig) => {
      exit = { code, signal: sig };
      // Background children may keep the pipes open; do not wait for them long.
      drainTimer = setTimeout(finish, DRAIN_MS);
    });
    child.once('close', () => finish());
  });
}

/**
 * The environment of the sandbox bootstrap: the wrapper runs `<shell> -c`
 * before the sandbox applies, so nothing may make that shell run code of its
 * own first (startup files, exported functions, shell options).
 */
export function bootstrapEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key === 'BASH_ENV' || key === 'ENV' || key === 'SHELLOPTS' || key === 'BASHOPTS' || key.startsWith('BASH_FUNC_')) continue;
    out[key] = value;
  }
  return out;
}

/** Runs a prepared `bash` effect. */
export async function runBash(effect: BashEffect, signal: AbortSignal, opts: BashRunOptions = {}): Promise<BashResult> {
  if (signal.aborted) throw new ToolError('cancelled', 'the run was stopped before bash started');
  const shell = findBash();
  if (shell === null) {
    throw new ToolError('tool-error', process.platform === 'win32' ? 'bash requires Git Bash, which was not found' : 'bash was not found');
  }
  const cap = opts.outputCapBytes ?? DEFAULT_OUTPUT_CAP_BYTES;
  const containment = effect.containment;
  if (containment.mode === 'none') {
    return spawnAndWait(shell, effect.command, process.env, effect.cwd, effect.timeoutMs, signal, cap);
  }
  return withSandbox(effect.command, shell, effect.cwd, containment, opts.denyWrite ?? [], signal, (wrapped) => {
    if (signal.aborted) throw new ToolError('cancelled', 'the run was stopped before bash started');
    return spawnAndWait(wrapped.shell, wrapped.script, bootstrapEnv({ ...process.env, ...wrapped.env }), effect.cwd, effect.timeoutMs, signal, cap);
  });
}
