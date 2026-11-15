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
  return st;
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
    handle = await fs.open(abs, FS.O_RDONLY | NOFOLLOW);
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
    if (st.size > maxBytes) throw new ToolError('tool-error', `${abs} is ${st.size} bytes, more than the ${maxBytes}-byte limit`);
    const bytes = await handle.readFile();
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
  /** Directories created to hold the file, outermost first. */
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

/**
 * Atomically replaces (or creates) `abs` with `bytes`:
 * 1. the parent directory must still resolve to itself (no symlink swapped in);
 * 2. the current content must match `expect` (else `ToolError('stale')`, no write);
 * 3. the bytes go to a temp file in the same directory (fsync), keep the old mode,
 *    and are renamed over the target; a create uses `link` so it never replaces
 *    a file that appeared meanwhile.
 * `beforeWrite` runs after the checks and before anything is written (the
 * transaction journal snapshots the original there).
 */
export async function atomicWrite(
  abs: string,
  bytes: Buffer,
  expect: Expectation,
  beforeWrite?: (before: RegularFile | null, createdDirs: readonly string[]) => Promise<void>,
): Promise<WriteOutcome> {
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

  for (const d of toCreate) {
    try {
      await fs.mkdir(d);
    } catch (err) {
      if (errnoCode(err) !== 'EEXIST') throw err;
    }
    await assertDirUnchanged(d);
  }
  await assertDirUnchanged(dir);

  const tmp = path.join(dir, `.${path.basename(abs)}.acm-${randomBytes(6).toString('hex')}.tmp`);
  const mode = before?.mode ?? 0o666;
  const handle = await fs.open(tmp, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | NOFOLLOW, mode);
  let placed = false;
  try {
    try {
      await handle.writeFile(bytes);
      if (before && !IS_WINDOWS) await handle.chmod(before.mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertDirUnchanged(dir);
    if (expect.kind === 'absent') {
      try {
        await fs.link(tmp, abs);
        placed = true;
      } catch (err) {
        const code = errnoCode(err);
        if (code === 'EEXIST') throw new ToolError('stale', `file changed since prepared: ${abs} was created meanwhile`);
        // File systems without hard links: fall back to rename.
        if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'EXDEV') throw err;
      }
    }
    if (!placed) await fs.rename(tmp, abs);
    return { before, createdDirs: toCreate };
  } finally {
    // After `link` the temp name is still there; after `rename` it is gone.
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

/** Removes `abs` if it is a regular file (never follows a link). */
export async function removeRegularFile(abs: string): Promise<void> {
  const st = await fs.lstat(abs).catch(() => null);
  if (!st) return;
  if (!st.isFile()) throw new ToolError('stale', `${abs} is no longer a regular file`);
  await fs.unlink(abs);
}

/** fsyncs a directory where the platform allows it. */
export async function syncDir(dir: string): Promise<void> {
  if (IS_WINDOWS) return;
  try {
    const handle = await fs.open(dir, FS.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Not every file system lets a directory be flushed.
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
