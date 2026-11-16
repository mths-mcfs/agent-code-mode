import { chmodSync, copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { killLiveChildren } from './proc.ts';

/**
 * Temporary CODEX_HOME directories. Each holds the user's auth.json as a symlink to the real file
 * (Codex reads it through the link; checked with Codex CLI 0.169), so no credential copy exists on
 * disk; where symlinks are not allowed (e.g. Windows without the privilege) it falls back to a 0600
 * copy. Every home is removed when the run ends, when the harness gets SIGINT/SIGTERM/SIGHUP, at
 * process exit, and, for homes left by a killed harness (SIGKILL), by `sweepStaleHomes` at the next start.
 */

export const HOME_MARKER = '.bench-temp-home';
const live = new Set<string>();

export type AuthMode = 'symlink' | 'copy';

export function createCodexHome(dir: string, sourceHome: string): AuthMode {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  live.add(dir);
  writeFileSync(path.join(dir, HOME_MARKER), `${process.pid}\n`);
  const source = path.join(sourceHome, 'auth.json');
  const target = path.join(dir, 'auth.json');
  try {
    symlinkSync(source, target);
    return 'symlink';
  } catch {
    copyFileSync(source, target);
    if (process.platform !== 'win32') chmodSync(target, 0o600);
    return 'copy';
  }
}

/** True when auth.json in the home is no longer the symlink it was created as (the host replaced it). */
export function authWasReplaced(dir: string, mode: AuthMode): boolean {
  try {
    return mode === 'symlink' && !lstatSync(path.join(dir, 'auth.json')).isSymbolicLink();
  } catch {
    return false;
  }
}

export function removeCodexHome(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  live.delete(dir);
}

export function removeAllHomes(): void {
  for (const dir of [...live]) removeCodexHome(dir);
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err instanceof Error && 'code' in err && err.code === 'EPERM';
  }
}

/** Removes temp homes under `root` whose owning harness process is gone. Returns the removed paths. */
export function sweepStaleHomes(root: string, maxDepth = 6): string[] {
  const removed: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === HOME_MARKER)) {
      let pid = NaN;
      try {
        pid = Number(readFileSync(path.join(dir, HOME_MARKER), 'utf8').trim());
      } catch {
        // unreadable marker: treat as stale
      }
      if (pid === process.pid || !alive(pid)) {
        rmSync(dir, { recursive: true, force: true });
        removed.push(dir);
      }
      return;
    }
    if (depth >= maxDepth) return;
    for (const e of entries) if (e.isDirectory() && !e.isSymbolicLink() && e.name !== 'ws' && e.name !== '.git') walk(path.join(dir, e.name), depth + 1);
  };
  walk(root, 0);
  return removed;
}

let installed = false;

/** On SIGINT/SIGTERM/SIGHUP: kill running hosts, remove every temp home, then die by the same signal. */
export function installCleanupHandlers(): void {
  if (installed) return;
  installed = true;
  process.on('exit', () => {
    killLiveChildren();
    removeAllHomes();
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(signal, () => {
      killLiveChildren();
      removeAllHomes();
      process.kill(process.pid, signal);
    });
  }
}
