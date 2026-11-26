import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';

export interface ProcessSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs: number;
  readonly stdoutFile: string;
  readonly stderrFile: string;
  readonly stdin?: string;
}

export interface ProcessOutcome {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly wallMs: number;
}

const liveChildren = new Set<number>();

/** Kills a child and its descendants: the group it leads off Windows (it was spawned detached), its tree on Windows. */
export function killGroup(pid: number): void {
  try {
    if (process.platform !== 'win32') process.kill(-pid, 'SIGKILL');
    else if (spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }).status !== 0) process.kill(pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
    }
  }
}

export function killLiveChildren(): void {
  for (const pid of [...liveChildren]) killGroup(pid);
  liveChildren.clear();
}

/**
 * Runs the host with its output streamed to files. Settles once: an error of the child, its stdin or either
 * output file (ENOSPC, say) kills the process group and rejects the run with that error.
 */
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
    let settled = false;
    let timedOut = false;
    const stop = (): void => {
      clearTimeout(timer);
      if (child.pid !== undefined) {
        killGroup(child.pid);
        liveChildren.delete(child.pid);
      }
    };
    const fail = (e: Error): void => {
      if (settled) return;
      settled = true;
      stop();
      out.destroy();
      err.destroy();
      reject(e);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) killGroup(child.pid);
    }, spec.timeoutMs);
    out.on('error', fail);
    err.on('error', fail);
    child.on('error', fail);
    // A host that exits without reading its prompt closes stdin early; that is not a harness failure.
    child.stdin.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code !== 'EPIPE') fail(e);
    });
    child.stdout.pipe(out);
    child.stderr.pipe(err);
    child.on('close', (exitCode, signal) => {
      if (settled) return;
      clearTimeout(timer);
      if (child.pid !== undefined) liveChildren.delete(child.pid);
      const wallMs = Math.round(performance.now() - started);
      // The pipes end both files when the child's output ends; resolve once both are on disk.
      Promise.all([finished(out), finished(err)]).then(() => {
        if (settled) return;
        settled = true;
        resolve({ exitCode, signal, timedOut, wallMs });
      }, fail);
    });
    child.stdin.end(spec.stdin ?? '');
  });
}
