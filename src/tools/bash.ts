import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, type BigIntStats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ToolError } from '../core/errors.js';
import type { BashEffect, BashExpandedEntry, BashGlobPlan, BashResult } from '../core/types.js';
import { errnoCode } from './fs-ops.js';
import type { Jail } from './jail.js';
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
    // A cut in the middle of a multi-byte character becomes U+FFFD.
    return Buffer.concat(this.#chunks).toString('utf8');
  }
}

/** Kills the whole process group of `child` (POSIX) or its tree (Windows). */
function killGroup(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

export interface BashRunOptions {
  readonly outputCapBytes?: number;
  /** Paths a sandboxed command may never write (from the host's protected paths). */
  readonly denyWrite?: readonly string[];
}

function spawnAndWait(
  argv: readonly string[],
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
    const [file, ...args] = argv;
    if (file === undefined) {
      reject(new ToolError('tool-error', 'empty command line'));
      return;
    }
    const child = spawn(file, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    const out = new Capture(cap);
    const err = new Capture(cap);
    child.stdout?.on('data', (c: Buffer) => out.push(c));
    child.stderr?.on('data', (c: Buffer) => err.push(c));

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
      // No process of the call outlives it: background children are killed too.
      killGroup(child);
      if (signal.aborted && !timedOut) {
        reject(new ToolError('cancelled', 'bash was stopped because the run stopped'));
        return;
      }
      resolve({
        exitCode: exit.code,
        signal: exit.signal,
        stdout: out.text(),
        stderr: err.text(),
        truncated: out.truncated || err.truncated,
        timedOut,
      });
    };
    const onAbort = (): void => killGroup(child);
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
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

/** Most entries one command's globs may expand to. */
export const MAX_EXPANDED_ENTRIES = 1000;

function identityOf(st: BigIntStats): string {
  const type = st.isFile() ? 'file' : st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'link' : 'other';
  return `${st.dev}:${st.ino}:${type}`;
}

/** Environment variables that make bash run code at startup; dropped so expanding has no side effect. */
const STARTUP_CODE_VARS = ['BASH_ENV', 'ENV'];

/**
 * Matches of one glob word, from the bash that runs the command, in `cwd`,
 * with the same environment (locale, `GLOBIGNORE`, `BASHOPTS`): exactly the
 * words, in the order, that bash would pass the command. The word holds only
 * literal text, quotes and glob characters (the planner refused anything
 * else), so expanding it runs no code. Empty when nothing matches.
 */
function bashGlob(raw: string, cwd: string, shell: string): Promise<string[]> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of STARTUP_CODE_VARS) delete env[name];
  const script = `shopt -u failglob 2>/dev/null; shopt -s nullglob; for f in ${raw}; do printf '%s\\0' "$f"; done`;
  return new Promise((resolve, reject) => {
    execFile(shell, ['--noprofile', '--norc', '-c', script], { cwd, env, encoding: 'buffer', timeout: 10_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) {
        reject(new ToolError('tool-error', `bash could not expand ${raw}: ${err.message}`));
        return;
      }
      const words = stdout.toString('utf8').split('\0');
      words.pop();
      resolve(words);
    });
  });
}

/** An expanded command and the identity of each entry it names. */
export interface ExpandedCommand {
  readonly command: string;
  readonly entries: readonly BashExpandedEntry[];
}

/**
 * Expands `plan` against `cwd` (the real directory the command runs in).
 * Undefined when a glob matches nothing (bash would pass it as written, so
 * the command stays as it is). Throws `ToolError` when a match is outside the
 * workspace (symbolic links resolved), is not a regular file (or a directory,
 * where the reader lists directories), names a directory the host's Read rules
 * refuse to list, or there are too many matches.
 */
export async function expandBashGlobs(
  plan: BashGlobPlan,
  cwd: string,
  jail: Jail,
  readFilter: ((realAbsPath: string) => boolean) | undefined,
  platform: NodeJS.Platform = process.platform,
): Promise<ExpandedCommand | undefined> {
  // Git Bash on Windows: paths, inodes and links are not those the checks below rely on.
  if (platform === 'win32') return undefined;
  const shell = findBash();
  if (shell === null) return undefined;
  const lists: string[][] = [];
  const entries: BashExpandedEntry[] = [];
  for (const glob of plan.globs) {
    const matches = await bashGlob(glob.raw, cwd, shell);
    if (matches.length === 0) return undefined;
    if (entries.length + matches.length > MAX_EXPANDED_ENTRIES) {
      throw new ToolError('invalid-args', `the globs of this command match more than ${MAX_EXPANDED_ENTRIES} entries; narrow them or use glob()`);
    }
    for (const rel of matches) {
      const abs = path.resolve(cwd, rel);
      const shown = JSON.stringify(rel);
      // Identity first, then the jail: what is recorded is what was found inside the workspace.
      let own: BigIntStats;
      let target: BigIntStats;
      try {
        own = await fs.lstat(abs, { bigint: true });
        target = await fs.stat(abs, { bigint: true });
      } catch (err) {
        throw new ToolError('not-found', `${shown} (matched by ${glob.raw}) cannot be read: ${errnoCode(err) ?? String(err)}`);
      }
      const real = await jail.resolve(abs).catch((err: unknown) => {
        if (err instanceof ToolError) throw new ToolError(err.code, `${shown} (matched by ${glob.raw}): ${err.message}`);
        throw err;
      });
      const atReal = await fs.stat(real, { bigint: true }).catch(() => null);
      if (!atReal || identityOf(atReal) !== identityOf(target)) {
        throw new ToolError('stale', `${shown} (matched by ${glob.raw}) changed while it was being checked`);
      }
      if (target.isDirectory()) {
        if (!glob.directories) throw new ToolError('invalid-args', `${shown} (matched by ${glob.raw}) is a directory; the command reads only regular files`);
      } else if (!target.isFile()) {
        throw new ToolError('invalid-args', `${shown} (matched by ${glob.raw}) is not a regular file`);
      }
      if (glob.directories && readFilter) {
        // A listing shows names and metadata: refuse an entry, or a directory child, the Read rules refuse.
        const shownPaths = [abs, real];
        if (target.isDirectory()) {
          for (const child of await fs.readdir(real).catch(() => [])) shownPaths.push(path.join(abs, child), path.join(real, child));
        }
        const refused = shownPaths.find((p) => !readFilter(p));
        if (refused !== undefined) {
          throw new ToolError('invalid-args', `${shown} (matched by ${glob.raw}) would list ${refused}, which the host's Read rules refuse`);
        }
      }
      entries.push({ path: abs, identity: identityOf(own), targetIdentity: identityOf(target) });
    }
    lists.push(matches);
  }
  return { command: plan.render(lists), entries };
}

/**
 * Refuses to run when an expanded entry is no longer the one that was
 * authorized: replaced, turned into a symbolic link, or a link retargeted.
 * What remains is the time between this check and the moment the command
 * opens the file (see README, "Security model and limits").
 */
export async function assertEntriesUnchanged(entries: readonly BashExpandedEntry[]): Promise<void> {
  for (const entry of entries) {
    let own: string;
    let target: string;
    try {
      own = identityOf(await fs.lstat(entry.path, { bigint: true }));
      target = identityOf(await fs.stat(entry.path, { bigint: true }));
    } catch (err) {
      throw new ToolError('stale', `${entry.path} changed after the command was authorized (${errnoCode(err) ?? String(err)}); nothing ran`);
    }
    if (own !== entry.identity || target !== entry.targetIdentity) {
      throw new ToolError('stale', `${entry.path} changed after the command was authorized (it is no longer the same file); nothing ran`);
    }
  }
}

/** Runs a prepared `bash` effect. */
export async function runBash(effect: BashEffect, signal: AbortSignal, opts: BashRunOptions = {}): Promise<BashResult> {
  if (signal.aborted) throw new ToolError('cancelled', 'the run was stopped before bash started');
  if (effect.expansion) await assertEntriesUnchanged(effect.expansion.entries);
  const shell = findBash();
  if (shell === null) {
    throw new ToolError('tool-error', process.platform === 'win32' ? 'bash requires Git Bash, which was not found' : 'bash was not found');
  }
  const cap = opts.outputCapBytes ?? DEFAULT_OUTPUT_CAP_BYTES;
  const containment = effect.containment;
  const shown = (r: BashResult): BashResult => (effect.expansion ? { ...r, command: effect.command } : r);
  if (containment.mode === 'none') {
    return shown(await spawnAndWait([shell, '-c', effect.command], process.env, effect.cwd, effect.timeoutMs, signal, cap));
  }
  return shown(
    await withSandbox(effect.command, shell, effect.cwd, containment, opts.denyWrite ?? [], async (wrapped) => {
      if (signal.aborted) throw new ToolError('cancelled', 'the run was stopped before bash started');
      // The sandbox setup took time: check the entries again right before the spawn.
      if (effect.expansion) await assertEntriesUnchanged(effect.expansion.entries);
      return spawnAndWait(wrapped.argv, { ...process.env, ...wrapped.env }, effect.cwd, effect.timeoutMs, signal, cap);
    }),
  );
}
