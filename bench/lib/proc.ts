import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';

export interface ProcessSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs: number;
  /** stdout is streamed into this file. */
  readonly stdoutFile: string;
  readonly stderrFile: string;
  readonly stdin?: string;
}

export interface ProcessOutcome {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  /** Wall time measured by the harness, from spawn to exit. */
  readonly wallMs: number;
}

const liveChildren = new Set<number>();

function killGroup(pid: number): void {
  try {
    if (process.platform !== 'win32') process.kill(-pid, 'SIGKILL');
    else process.kill(pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

/** Kills every host process (and its process group) still running. Used by the signal handlers. */
export function killLiveChildren(): void {
  for (const pid of [...liveChildren]) killGroup(pid);
  liveChildren.clear();
}

/** Runs a process with a wall timeout; on timeout kills its whole process group. */
export function runProcess(spec: ProcessSpec): Promise<ProcessOutcome> {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(spec.stdoutFile);
    const err = createWriteStream(spec.stderrFile);
    const started = performance.now();
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: Object.fromEntries(Object.entries(spec.env).filter((e): e is [string, string] => e[1] !== undefined)),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    if (child.pid !== undefined) liveChildren.add(child.pid);
    let timedOut = false;
    const kill = (): void => {
      timedOut = true;
      try {
        if (process.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(kill, spec.timeoutMs);
    child.stdout.pipe(out);
    child.stderr.pipe(err);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      if (child.pid !== undefined) liveChildren.delete(child.pid);
      const wallMs = Math.round(performance.now() - started);
      let pending = 2;
      const done = (): void => {
        if (--pending === 0) resolve({ exitCode, signal, timedOut, wallMs });
      };
      out.end(done);
      err.end(done);
    });
    child.stdin.end(spec.stdin ?? '');
  });
}
