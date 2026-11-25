import { createHash, randomBytes } from 'node:crypto';
import { constants as FS, type Stats } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { ToolError } from '../core/errors.js';

/**
 * File operations that do not let a symlink or a race widen what was
 * prepared. Every open of a final component uses `O_NOFOLLOW` where the
 * platform has it; the opened file is then checked to be the one at the path
 * (Linux: `/proc/self/fd`; elsewhere: `fstat` vs `lstat` identity).
 */

const NOFOLLOW = FS.O_NOFOLLOW ?? 0;
/** Opening a FIFO or a device for reading must not wait for a writer before the type check. */
const NONBLOCK = FS.O_NONBLOCK ?? 0;
const IS_LINUX = process.platform === 'linux';
const IS_WINDOWS = process.platform === 'win32';

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function errnoCode(err: unknown): string | undefined {
  if (err !== null && typeof err === 'object' && 'code' in err && typeof err.code === 'string') return err.code;
  return undefined;
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.ino === b.ino && a.dev === b.dev;
}

/** Throws `stale` unless the real path of `dir` is still exactly `dir`. */
export async function assertDirUnchanged(dir: string): Promise<void> {
  let real: string;
  try {
    real = await fs.realpath(dir);
  } catch (err) {
    throw new ToolError('stale', `${dir} changed since prepared (${errnoCode(err) ?? 'unresolvable'})`);
  }
  const same = IS_WINDOWS ? real.toLowerCase() === dir.toLowerCase() : real === dir;
  if (!same) throw new ToolError('stale', `file changed since prepared: ${dir} now resolves to ${real}`);
}

/** Verifies an open handle is the file at `abs` and not something reached through a link. */
async function assertHandleAt(handle: FileHandle, abs: string): Promise<Stats> {
  const st = await handle.stat();
  if (IS_LINUX) {
    let actual: string | undefined;
    try {
      actual = await fs.readlink(`/proc/self/fd/${handle.fd}`);
    } catch {
      actual = undefined;
    }
    if (actual !== undefined && actual !== abs) {
      throw new ToolError('stale', `file changed since prepared: ${abs} opened as ${actual}`);
    }
  }
  const lst = await fs.lstat(abs).catch(() => null);
  if (!lst || lst.isSymbolicLink() || !sameFile(st, lst)) {
    throw new ToolError('stale', `file changed since prepared: ${abs} was replaced while it was opened`);
  }
  // Without /proc, the directory holding the opened file must still be itself:
  // a parent swapped for a link would make `lstat(abs)` agree with the handle.
  if (!IS_LINUX) await assertDirUnchanged(path.dirname(abs));
  return st;
}

/**
 * Opens a regular file for reading and checks the handle is the file at
 * `abs` reached without any link (final component or parent). Returns null
 * when the file is not there or not a regular file reachable that way.
 */
export async function readFileInside(abs: string, maxBytes: number): Promise<Buffer | null> {
  let handle: FileHandle;
  try {
    handle = await fs.open(abs, FS.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = await assertHandleAt(handle, abs);
    if (!st.isFile() || st.size > maxBytes) return null;
    return await readAtMost(handle, maxBytes);
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/** Reads an open file to its end, or returns null once it holds more than `maxBytes` (it may grow after the size check). */
async function readAtMost(handle: FileHandle, maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(64 * 1024);
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) return Buffer.concat(chunks, total);
    total += bytesRead;
    if (total > maxBytes) return null;
    chunks.push(chunk.subarray(0, bytesRead));
  }
}

// ---------------------------------------------------------------------------
// Identity: what a commit checks to know the path still names what prepare saw.
// ---------------------------------------------------------------------------

/** dev+ino of a path and of each directory above it up to a root. */
export interface PathIdentity {
  readonly entries: readonly { readonly path: string; readonly dev: bigint; readonly ino: bigint }[];
}

/**
 * Records the identity of `abs` (when it exists) and of every existing
 * directory from its parent up to `root` (inclusive).
 */
export async function captureIdentity(abs: string, root: string): Promise<PathIdentity> {
  const entries: { path: string; dev: bigint; ino: bigint }[] = [];
  let cursor = abs;
  for (;;) {
    const st = await fs.lstat(cursor, { bigint: true }).catch(() => null);
    if (st) entries.push({ path: cursor, dev: st.dev, ino: st.ino });
    const same = IS_WINDOWS ? cursor.toLowerCase() === root.toLowerCase() : cursor === root;
    const parent = path.dirname(cursor);
    if (same || parent === cursor) break;
    cursor = parent;
  }
  return { entries };
}

/** Throws `stale` when any path recorded by `captureIdentity` now names something else. */
export async function assertIdentity(identity: PathIdentity): Promise<void> {
  for (const e of identity.entries) {
    const st = await fs.lstat(e.path, { bigint: true }).catch(() => null);
    if (!st || st.dev !== e.dev || st.ino !== e.ino) {
      throw new ToolError('stale', `file changed since prepared: ${e.path} was replaced`);
    }
  }
}

// ---------------------------------------------------------------------------
// Per-path lock: check-and-replace of one path is atomic within the process.
// ---------------------------------------------------------------------------

const locks = new Map<string, Promise<unknown>>();

/** Runs `fn` while holding the in-process lock of `abs`. */
export function withPathLock<T>(abs: string, fn: () => Promise<T>): Promise<T> {
  const key = IS_WINDOWS || process.platform === 'darwin' ? abs.toLowerCase() : abs;
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => undefined);
  locks.set(key, tail);
  void tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return next;
}

export interface RegularFile {
  readonly bytes: Buffer;
  readonly mode: number;
}

/**
 * Reads a regular file without following a link at its final component.
 * Returns null when it does not exist. `maxBytes` bounds the read.
 */
export async function readRegularFile(abs: string, maxBytes = Number.MAX_SAFE_INTEGER): Promise<RegularFile | null> {
  let handle: FileHandle;
  try {
    handle = await fs.open(abs, FS.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP' || code === 'EMLINK') throw new ToolError('stale', `${abs} is a symbolic link`);
    if (code === 'EISDIR') throw new ToolError('invalid-args', `${abs} is a directory`);
    throw new ToolError('tool-error', `cannot open ${abs}: ${code ?? String(err)}`);
  }
  try {
    const st = await assertHandleAt(handle, abs);
    if (st.isDirectory()) throw new ToolError('invalid-args', `${abs} is a directory`);
    if (!st.isFile()) throw new ToolError('invalid-args', `${abs} is not a regular file`);
    const tooBig = (size: number | string): ToolError => new ToolError('tool-error', `${abs} is ${size} bytes, more than the ${maxBytes}-byte limit`);
    if (st.size > maxBytes) throw tooBig(st.size);
    const bytes = await readAtMost(handle, maxBytes);
    if (bytes === null) throw tooBig(`over ${maxBytes}`);
    return { bytes, mode: st.mode & 0o7777 };
  } finally {
    await handle.close();
  }
}

/** What a commit expects to find at the path before it writes. */
export type Expectation = { readonly kind: 'absent' } | { readonly kind: 'hash'; readonly sha256: string };

export interface WriteOutcome {
  /** Bytes that were there before (null when absent). */
  readonly before: RegularFile | null;
  /** Directories this write created to hold the file (not ones that appeared meanwhile), outermost first. */
  readonly createdDirs: readonly string[];
}

async function missingDirs(dir: string): Promise<string[]> {
  const missing: string[] = [];
  let cursor = dir;
  for (;;) {
    const st = await fs.lstat(cursor).catch(() => null);
    if (st) {
      if (st.isSymbolicLink() || !st.isDirectory()) {
        throw new ToolError('stale', `file changed since prepared: ${cursor} is not a directory`);
      }
      break;
    }
    missing.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return missing.reverse();
}

export interface AtomicWriteOptions {
  /** Runs after the checks and before anything is written (the journal snapshots there). */
  readonly beforeWrite?: (before: RegularFile | null, createdDirs: readonly string[]) => Promise<void>;
  /** Checked again right before the rename; an abort refuses the write. */
  readonly signal?: AbortSignal;
  /** Identity recorded at prepare; checked before writing and right before the rename. */
  readonly identity?: PathIdentity;
  /** Mode of the new file; defaults to the mode of the file it replaces. */
  readonly mode?: number;
}

function hashMatches(expect: Expectation, current: RegularFile | null): boolean {
  if (expect.kind === 'absent') return current === null;
  return current !== null && sha256(current.bytes) === expect.sha256;
}

/** Atomically replaces (or creates) `abs` under its per-path lock; see `writeLocked`. */
export function atomicWrite(abs: string, bytes: Buffer, expect: Expectation, opts: AtomicWriteOptions = {}): Promise<WriteOutcome> {
  return withPathLock(abs, () => writeLocked(abs, bytes, expect, opts));
}

function assertNotAborted(signal: AbortSignal | undefined, abs: string): void {
  if (signal?.aborted) throw new ToolError('cancelled', `the run was stopped before ${abs} was written`);
}

/**
 * Replaces (or creates) `abs` with `bytes`, holding its per-path lock:
 * 1. the parent directory must still resolve to itself (no symlink swapped in);
 * 2. the identity recorded at prepare and the content must match (else `stale`, no write);
 * 3. the bytes go to a temp file in the same directory (fsync), keep the old mode,
 *    and are renamed over the target; a create uses `link` so it never replaces
 *    a file that appeared meanwhile.
 * Right before the rename the signal, the identity and the content hash are
 * checked again. `beforeWrite` runs after the checks and before anything is written (the
 * transaction journal snapshots the original there).
 */
async function writeLocked(abs: string, bytes: Buffer, expect: Expectation, opts: AtomicWriteOptions): Promise<WriteOutcome> {
  const { beforeWrite, signal, identity } = opts;
  assertNotAborted(signal, abs);
  if (identity) await assertIdentity(identity);
  const dir = path.dirname(abs);
  const toCreate = await missingDirs(dir);
  const existingAncestor = toCreate.length > 0 ? path.dirname(toCreate[0] ?? dir) : dir;
  await assertDirUnchanged(existingAncestor);

  const before = await readRegularFile(abs);
  if (expect.kind === 'absent' && before !== null) {
    throw new ToolError('stale', `file changed since prepared: ${abs} was created after the call was prepared`);
  }
  if (expect.kind === 'hash') {
    if (before === null) throw new ToolError('stale', `file changed since prepared: ${abs} no longer exists`);
    if (sha256(before.bytes) !== expect.sha256) throw new ToolError('stale', `file changed since prepared: ${abs}`);
  }

  await beforeWrite?.(before, toCreate);

  const createdDirs: string[] = [];
  for (const d of toCreate) {
    try {
      await fs.mkdir(d);
      createdDirs.push(d);
    } catch (err) {
      if (errnoCode(err) !== 'EEXIST') throw err;
    }
    await assertDirUnchanged(d);
  }
  await assertDirUnchanged(dir);

  const tmp = path.join(dir, `.acm-${randomBytes(6).toString('hex')}.tmp`);
  const mode = opts.mode ?? before?.mode ?? 0o666;
  const handle = await fs.open(tmp, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | NOFOLLOW, mode);
  try {
    try {
      await handle.writeFile(bytes);
      if ((opts.mode !== undefined || before) && !IS_WINDOWS) await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Last checks before the irreversible step.
    await assertDirUnchanged(dir);
    if (identity) await assertIdentity(identity);
    if (!hashMatches(expect, await readRegularFile(abs))) {
      throw new ToolError('stale', `file changed since prepared: ${abs} changed while it was being written`);
    }
    assertNotAborted(signal, abs);
    if (expect.kind === 'absent') {
      try {
        await fs.link(tmp, abs);
      } catch (err) {
        const code = errnoCode(err);
        if (code === 'EEXIST') throw new ToolError('stale', `file changed since prepared: ${abs} was created meanwhile`);
        throw err;
      }
    } else {
      await fs.rename(tmp, abs);
    }
    return { before, createdDirs };
  } finally {
    // After `link` the temp name is still there; after `rename` it is gone.
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

/**
 * Removes `abs` when it is a regular file holding `expectHash`, reached
 * without any link (its directory must still resolve to itself).
 */
export function removeRegularFile(abs: string, expectHash: string): Promise<void> {
  return withPathLock(abs, async () => {
    await assertDirUnchanged(path.dirname(abs));
    const current = await readRegularFile(abs);
    if (current === null) return;
    if (sha256(current.bytes) !== expectHash) throw new ToolError('stale', `${abs} changed; not removed`);
    await fs.unlink(abs);
  });
}

/**
 * Removes `dir` when it is an empty real directory (not a link, not reached
 * through one) strictly inside one of `roots`. Returns whether it was removed.
 */
export async function removeEmptyDirInside(dir: string, roots: readonly string[]): Promise<boolean> {
  if (!path.isAbsolute(dir)) return false;
  const st = await fs.lstat(dir).catch(() => null);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return false;
  const real = await fs.realpath(dir).catch(() => null);
  const same = real !== null && (IS_WINDOWS ? real.toLowerCase() === dir.toLowerCase() : real === dir);
  if (!same) return false;
  const inside = roots.some((root) => {
    const rel = path.relative(IS_WINDOWS ? root.toLowerCase() : root, IS_WINDOWS ? dir.toLowerCase() : dir);
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  });
  if (!inside) return false;
  try {
    await fs.rmdir(dir);
    return true;
  } catch {
    return false;
  }
}

async function flushDir(dir: string): Promise<void> {
  const handle = await fs.open(dir, FS.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Errors that mean the file system cannot fsync a directory at all (FUSE, 9p, some NFS). */
const UNSUPPORTED_SYNC = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP']);

/**
 * fsyncs a directory, so the entries renamed, linked or removed in it survive
 * a crash. Rejects when the flush fails, and with a `ToolError` on Windows
 * and on file systems that cannot flush a directory at all: there a rename is
 * atomic but not durable, so nothing that must survive a crash may rely on it.
 * Node on Windows has no directory flush that confirms one directory.
 */
export async function syncDirStrict(dir: string, flush: (dir: string) => Promise<void> = flushDir): Promise<void> {
  if (IS_WINDOWS) throw new ToolError('tool-error', `Windows cannot flush the directory ${dir} to disk, so changes there cannot be made durable`);
  try {
    await flush(dir);
  } catch (err) {
    const code = errnoCode(err);
    if (code !== undefined && UNSUPPORTED_SYNC.has(code)) {
      throw new ToolError('tool-error', `the file system of ${dir} cannot flush a directory to disk (${code}), so changes there cannot be made durable`);
    }
    throw err;
  }
}

/** Writes and fsyncs a private file (journal records). */
export async function writeDurable(file: string, data: Buffer | string): Promise<void> {
  const handle = await fs.open(file, FS.O_WRONLY | FS.O_CREAT | FS.O_TRUNC, 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Whether a buffer looks like binary data: a NUL byte in the first 8 KiB, or invalid UTF-8. */
export function isBinary(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 8192);
  if (head.includes(0)) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return false;
  } catch {
    return true;
  }
}

/** Decodes UTF-8 text, throwing `ToolError('tool-error', 'binary file')` for binary data. */
export function decodeText(abs: string, bytes: Buffer): string {
  if (isBinary(bytes)) throw new ToolError('tool-error', `binary file: ${abs}`);
  return bytes.toString('utf8');
}
