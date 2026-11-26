import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { killLiveChildren } from './proc.ts';

/**
 * Temporary CODEX_HOME directories for benchmark runs.
 *
 * Each home gets a 0600 copy of the user's auth.json and a marker recording the real file's path and
 * the hash of the bytes copied. Codex may refresh the token during a run and rewrite auth.json (by
 * atomic rename), which can rotate the refresh token and invalidate the old one. So before a home is
 * deleted, `syncBack` applies one rule: if the temp copy changed and the real file still has the hash
 * recorded at copy time, the temp copy is written back to the real path atomically (temp file +
 * rename, mode 0600); if both changed, the real file wins and a warning is printed. The same rule runs
 * when the run ends, on SIGINT/SIGTERM/SIGHUP, at process exit, and in `sweepStaleHomes`, which
 * cleans homes left by a harness that was killed (SIGKILL) at the next start.
 */

export const HOME_MARKER = '.bench-temp-home';
const live = new Set<string>();

const MarkerSchema = z.object({
  pid: z.number().int(),
  source: z.string().min(1),
  file: z.string().min(1).default('auth.json'),
  copiedSha256: z.string().regex(/^[0-9a-f]{64}$/),
});
type Marker = z.infer<typeof MarkerSchema>;

export type SyncOutcome = 'unchanged' | 'written-back' | 'conflict-kept-real' | 'no-auth';

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function readOrNull(file: string): Buffer | null {
  try {
    return readFileSync(file);
  } catch {
    return null;
  }
}

function readMarker(dir: string): Marker | null {
  try {
    const parsed = MarkerSchema.safeParse(JSON.parse(readFileSync(path.join(dir, HOME_MARKER), 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function atomicWrite(file: string, data: Buffer): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.bench-${process.pid}-${randomBytes(4).toString('hex')}`);
  writeFileSync(tmp, data, { mode: 0o600, flag: 'wx' });
  try {
    if (process.platform !== 'win32') chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export function createCodexHome(dir: string, sourceHome: string, file = 'auth.json'): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const source = path.resolve(sourceHome, file);
  const bytes = readFileSync(source);
  const marker: Marker = { pid: process.pid, source, file, copiedSha256: sha256(bytes) };
  writeFileSync(path.join(dir, HOME_MARKER), `${JSON.stringify(marker)}\n`, { mode: 0o600 });
  live.add(dir);
  writeFileSync(path.join(dir, file), bytes, { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(path.join(dir, file), 0o600);
}

export function syncBack(dir: string, warn: (message: string) => void = (m) => process.stderr.write(`${m}\n`)): SyncOutcome {
  const marker = readMarker(dir);
  if (marker === null) return 'no-auth';
  const temp = readOrNull(path.join(dir, marker.file));
  if (temp === null) return 'no-auth';
  if (sha256(temp) === marker.copiedSha256) return 'unchanged';
  const real = readOrNull(marker.source);
  if (real !== null && sha256(real) === marker.copiedSha256) {
    atomicWrite(marker.source, temp);
    return 'written-back';
  }
  warn(`bench: the host refreshed ${marker.file} in a temp home, but ${marker.source} also changed since it was copied; kept the real file and discarded the temp copy`);
  return 'conflict-kept-real';
}

export function removeCodexHome(dir: string): SyncOutcome {
  let outcome: SyncOutcome = 'no-auth';
  try {
    outcome = syncBack(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    live.delete(dir);
  }
  return outcome;
}

export function removeAllHomes(): void {
  for (const dir of [...live]) {
    try {
      removeCodexHome(dir);
    } catch (err) {
      process.stderr.write(`bench: could not clean ${dir}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
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

function markerPid(dir: string): number {
  const marker = readMarker(dir);
  if (marker !== null) return marker.pid;
  try {
    return Number(readFileSync(path.join(dir, HOME_MARKER), 'utf8').trim());
  } catch {
    return NaN;
  }
}

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
      const pid = markerPid(dir);
      if (pid === process.pid || !alive(pid)) {
        removeCodexHome(dir);
        removed.push(dir);
      }
      return;
    }
    if (depth >= maxDepth) return;
    for (const e of entries) if (e.isDirectory() && !e.isSymbolicLink() && e.name !== 'ws' && e.name !== '.git') walk(path.join(dir, e.name), depth + 1);
  };
  if (existsSync(root)) walk(root, 0);
  return removed;
}

let installed = false;

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
