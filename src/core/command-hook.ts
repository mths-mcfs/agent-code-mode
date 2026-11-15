import { spawn, type ChildProcess } from 'node:child_process';

/** Default cap of captured stdout and stderr, each. */
export const DEFAULT_HOOK_MAX_OUTPUT_BYTES = 1024 * 1024;

export interface CommandHookOptions {
  /** Shell command line, run with `/bin/sh -c` on POSIX and the default shell on Windows. */
  readonly command: string;
  /** Written to stdin, then stdin is closed. */
  readonly stdin: string;
  /** Added to the server's environment. */
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly timeoutMs: number;
  /** Cap of captured bytes, for stdout and stderr each. */
  readonly maxOutputBytes?: number;
  /** Aborting kills the hook like a timeout (but `timedOut` stays false). */
  readonly signal?: AbortSignal;
}

export interface CommandHookResult {
  /** Exit code, or null when killed by a signal or not started. */
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly timedOut: boolean;
  /** True when `signal` aborted the hook. */
  readonly aborted: boolean;
  /** Set when the process could not be started (e.g. missing cwd). */
  readonly spawnError: string | null;
}

/** After the process exits, how long to wait for its pipes to close (a detached grandchild may hold them). */
const PIPE_GRACE_MS = 200;

class Capture {
  readonly #chunks: Buffer[] = [];
  #bytes = 0;
  truncated = false;

  constructor(readonly max: number) {}

  push(chunk: Buffer): void {
    const room = this.max - this.#bytes;
    if (room <= 0) {
      this.truncated = true;
      return;
    }
    const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
    if (kept.length < chunk.length) this.truncated = true;
    this.#chunks.push(kept);
    this.#bytes += kept.length;
  }

  text(): string {
    return Buffer.concat(this.#chunks).toString('utf8');
  }
}

/**
 * POSIX: kills whatever is left of the hook's process group (the hook is the
 * group leader). Called on every completion path, so a backgrounded
 * descendant cannot keep running after the hook returned. ESRCH (nothing
 * left) is ignored.
 */
function killGroup(child: ChildProcess): void {
  if (process.platform === 'win32' || child.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // The group is already empty.
  }
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => undefined);
    } else {
      // Negative pid: the whole process group (the child is a group leader).
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

/**
 * Runs a command hook: JSON on stdin, output captured up to a cap, killed
 * with its whole process group on timeout or abort. Never rejects.
 */
export function runCommandHook(opts: CommandHookOptions): Promise<CommandHookResult> {
  const max = opts.maxOutputBytes ?? DEFAULT_HOOK_MAX_OUTPUT_BYTES;
  const stdout = new Capture(max);
  const stderr = new Capture(max);

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let timer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    let child: ChildProcess;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;

    const finish = (spawnError: string | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      killGroup(child);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
      resolve({
        exitCode: exit?.code ?? null,
        signal: exit?.signal ?? null,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        timedOut,
        aborted,
        spawnError,
      });
    };

    const onAbort = (): void => {
      aborted = true;
      killTree(child);
    };

    try {
      child = spawn(opts.command, {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        shell: process.platform === 'win32' ? true : '/bin/sh',
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      resolve({
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
        aborted: false,
        spawnError: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (err) => {
      // 'error' without a pid means the process never started.
      if (child.pid === undefined) finish(err.message);
    });
    child.on('exit', (code, signal) => {
      exit = { code, signal };
      // The hook is done: nothing it started may outlive it.
      killGroup(child);
      // Give the pipes a moment to flush; a grandchild that escaped the group may keep them open.
      graceTimer = setTimeout(() => finish(null), PIPE_GRACE_MS);
    });
    child.on('close', (code, signal) => {
      exit ??= { code, signal };
      finish(null);
    });

    timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, Math.max(1, opts.timeoutMs));

    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdin?.on('error', () => undefined); // EPIPE when the hook does not read stdin.
    child.stdin?.end(opts.stdin);
  });
}
