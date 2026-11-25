import { createHash, randomBytes } from 'node:crypto';
import nodeFs, { constants as FS, type BigIntStats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ToolError } from '../core/errors.js';
import { type RootedPath, childOf, lstatRooted, openRooted, rooted, splitParent, within } from './rooted.js';

/**
 * File operations that do not let a symlink or a race widen what was
 * prepared. Every workspace path is reached through `rooted.ts`: no
 * directory on the way is a link, and none is looked up again by path
 * between the check and the use.
 */

/** Opening a FIFO or a device for reading must not wait for a writer before the type check. */
const NONBLOCK = FS.O_NONBLOCK ?? 0;
const IS_WINDOWS = process.platform === 'win32';

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function errnoCode(err: unknown): string | undefined {
  if (err !== null && typeof err === 'object' && 'code' in err && typeof err.code === 'string') return err.code;
  return undefined;
}

function settle<T>(run: (done: (err: NodeJS.ErrnoException | null, value: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => run((err, value) => (err ? reject(err) : resolve(value))));
}

const fdStat = (fd: number): Promise<BigIntStats> => settle((done) => nodeFs.fstat(fd, { bigint: true }, done));
const fdSync = (fd: number): Promise<void> => settle((done) => nodeFs.fsync(fd, (err) => done(err, undefined)));
const fdRead = (fd: number, buf: Buffer): Promise<number> => settle((done) => nodeFs.read(fd, buf, 0, buf.length, null, done));

async function fdWriteAll(fd: number, bytes: Buffer): Promise<void> {
  for (let off = 0; off < bytes.length; ) {
    off += await settle<number>((done) => nodeFs.write(fd, bytes, off, bytes.length - off, null, done));
  }
}

/** Reads an open file to its end, or returns null once it holds more than `maxBytes` (it may grow after the size check). */
async function readAtMost(fd: number, maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(64 * 1024);
    const bytesRead = await fdRead(fd, chunk);
    if (bytesRead === 0) return Buffer.concat(chunks, total);
    total += bytesRead;
    if (total > maxBytes) return null;
    chunks.push(chunk.subarray(0, bytesRead));
  }
}

function openForRead(file: RootedPath): number | null {
  try {
    return openRooted(file, FS.O_RDONLY | NONBLOCK);
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw err;
  }
}

/**
 * Reads a regular file of at most `maxBytes` (grep). Returns null when it is
 * missing, not a regular file, a link, or larger.
 */
export async function readFileInside(file: RootedPath, maxBytes: number): Promise<Buffer | null> {
  let fd: number | null;
  try {
    fd = openForRead(file);
  } catch {
    return null;
  }
  if (fd === null) return null;
  try {
    const st = await fdStat(fd);
    if (!st.isFile() || st.size > BigInt(maxBytes)) return null;
    return await readAtMost(fd, maxBytes);
  } catch {
    return null;
  } finally {
    nodeFs.closeSync(fd);
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

interface IdStats {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

/**
 * Identity of a file as it is now: `dev:ino:size:mtime:ctime`. A replacement
 * changes the inode, and a rewrite in place changes the times.
 */
export type FileId = string;
/**
 * Identity of a temp file before it is installed: `dev:ino:size:mtime`. The
 * rename or link that installs it keeps these and changes the ctime.
 */
export type InstallId = string;
/** `dev:ino` of a directory, which adding entries does not change. */
export type DirId = string;

function installIdOf(st: IdStats): InstallId {
  return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}`;
}

function fileId(st: IdStats): FileId {
  return `${installIdOf(st)}:${st.ctimeNs}`;
}

/** Whether something is at `temp`, and if so whether it still has the identity `install`; reads metadata only. */
export async function tempLeftover(temp: string, install: InstallId): Promise<{ readonly identityMatches: boolean } | undefined> {
  const st = await fs.lstat(temp, { bigint: true }).catch(() => null);
  if (st === null) return undefined;
  return { identityMatches: st.isFile() && installIdOf(st) === install };
}

/** The install identity a file identity started from. */
export function installIdFrom(id: FileId): InstallId {
  return id.slice(0, id.lastIndexOf(':'));
}

function dirId(st: { readonly dev: bigint; readonly ino: bigint }): DirId {
  return `${st.dev}:${st.ino}`;
}

/** Identity of the directory at `dir` now, or undefined when nothing is there. */
export async function currentDirId(dir: string): Promise<DirId | undefined> {
  const st = await fs.lstat(dir, { bigint: true }).catch(() => null);
  return st?.isDirectory() === true ? dirId(st) : undefined;
}

export interface RegularFile {
  readonly bytes: Buffer;
  readonly mode: number;
  readonly id: FileId;
}

/**
 * Reads a regular file without following a link anywhere on its path.
 * Returns null when it does not exist. `maxBytes` bounds the read.
 */
export async function readRegularFile(file: RootedPath, maxBytes = Number.MAX_SAFE_INTEGER): Promise<RegularFile | null> {
  const abs = file.abs;
  let fd: number | null;
  try {
    fd = openForRead(file);
  } catch (err) {
    if (err instanceof ToolError) throw err;
    const code = errnoCode(err);
    if (code === 'ELOOP' || code === 'EMLINK') throw new ToolError('stale', `${abs} is a symbolic link`);
    if (code === 'EISDIR') throw new ToolError('invalid-args', `${abs} is a directory`);
    throw new ToolError('tool-error', `cannot open ${abs}: ${code ?? String(err)}`);
  }
  if (fd === null) return null;
  try {
    const st = await fdStat(fd);
    if (st.isDirectory()) throw new ToolError('invalid-args', `${abs} is a directory`);
    if (!st.isFile()) throw new ToolError('invalid-args', `${abs} is not a regular file`);
    const tooBig = (size: bigint | string): ToolError => new ToolError('tool-error', `${abs} is ${size} bytes, more than the ${maxBytes}-byte limit`);
    if (st.size > BigInt(maxBytes)) throw tooBig(st.size);
    const bytes = await readAtMost(fd, maxBytes);
    if (bytes === null) throw tooBig(`over ${maxBytes}`);
    return { bytes, mode: Number(st.mode) & 0o7777, id: fileId(await fdStat(fd)) };
  } finally {
    nodeFs.closeSync(fd);
  }
}

/** What a commit expects to find at the path before it writes. */
export type Expectation = { readonly kind: 'absent' } | { readonly kind: 'hash'; readonly sha256: string };

export interface WriteOutcome {
  /** Bytes that were there before (null when absent). */
  readonly before: RegularFile | null;
  /** Directories this write created to hold the file (not ones that appeared meanwhile), outermost first. */
  readonly createdDirs: readonly string[];
  /** Identity of the temp file that was installed. */
  readonly install: InstallId;
  /** Identity of the file at the path right after the install, when it is still the installed one. */
  readonly id: FileId | undefined;
  /** Identity of the file's directory right before the install. */
  readonly dirId: DirId;
}

function missingDirs(dir: RootedPath): RootedPath[] {
  const missing: RootedPath[] = [];
  for (let cursor = dir; ; ) {
    try {
      within(cursor, () => undefined);
      break;
    } catch (err) {
      if (errnoCode(err) === 'ENOTDIR') throw new ToolError('stale', `file changed since prepared: ${cursor.abs} is not a directory`);
      if (errnoCode(err) !== 'ENOENT' || cursor.parts.length === 0) throw err;
    }
    missing.push(cursor);
    cursor = splitParent(cursor).dir;
  }
  return missing.reverse();
}

function dirIdAt(dir: RootedPath): DirId {
  return within(dir, (at) => dirId(nodeFs.lstatSync(at('.'), { bigint: true })));
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
  /** Told about each directory as soon as this write creates it (and its parent's identity), even when the write fails later. */
  readonly onDirCreated?: (dir: string, id: DirId, parent: DirId | undefined) => void;
  /** Runs once the temp file holds the bytes and right before it is installed (the journal records its identity there). */
  readonly beforeInstall?: (install: InstallId, temp: string) => Promise<void>;
}

function hashMatches(expect: Expectation, current: RegularFile | null): boolean {
  if (expect.kind === 'absent') return current === null;
  return current !== null && sha256(current.bytes) === expect.sha256;
}

/** Atomically replaces (or creates) `file` under its per-path lock; see `writeLocked`. */
export function atomicWrite(file: RootedPath, bytes: Buffer, expect: Expectation, opts: AtomicWriteOptions = {}): Promise<WriteOutcome> {
  return withPathLock(file.abs, () => writeLocked(file, bytes, expect, opts));
}

function assertNotAborted(signal: AbortSignal | undefined, abs: string): void {
  if (signal?.aborted) throw new ToolError('cancelled', `the run was stopped before ${abs} was written`);
}

/**
 * Replaces (or creates) `file` with `bytes`, holding its per-path lock:
 * 1. the identity recorded at prepare and the content must match (else `stale`, no write);
 * 2. missing directories are created one at a time, each in the rooted directory above it;
 * 3. the bytes go to a temp file in the same rooted directory (fsync), keep the old mode,
 *    and are renamed over the target; a create uses `link` so it never replaces
 *    a file that appeared meanwhile.
 * Right before the rename the signal, the identity and the content hash are
 * checked again, and the temp file must still be the one written. `beforeWrite`
 * runs after the checks and before anything is written (the transaction journal
 * snapshots the original there).
 */
async function writeLocked(file: RootedPath, bytes: Buffer, expect: Expectation, opts: AtomicWriteOptions): Promise<WriteOutcome> {
  const { beforeWrite, signal, identity } = opts;
  const abs = file.abs;
  assertNotAborted(signal, abs);
  if (identity) await assertIdentity(identity);
  const { dir, name } = splitParent(file);
  const toCreate = missingDirs(dir);

  const before = await readRegularFile(file);
  if (expect.kind === 'absent' && before !== null) {
    throw new ToolError('stale', `file changed since prepared: ${abs} was created after the call was prepared`);
  }
  if (expect.kind === 'hash') {
    if (before === null) throw new ToolError('stale', `file changed since prepared: ${abs} no longer exists`);
    if (sha256(before.bytes) !== expect.sha256) throw new ToolError('stale', `file changed since prepared: ${abs}`);
  }

  await beforeWrite?.(before, toCreate.map((d) => d.abs));

  const createdDirs: string[] = [];
  for (const d of toCreate) {
    const { dir: parent, name: dirName } = splitParent(d);
    try {
      within(parent, (at) => nodeFs.mkdirSync(at(dirName)));
    } catch (err) {
      if (errnoCode(err) !== 'EEXIST') throw err;
      continue;
    }
    createdDirs.push(d.abs);
    opts.onDirCreated?.(d.abs, dirIdAt(d), dirIdAt(parent));
  }

  const tmpName = `.acm-${randomBytes(6).toString('hex')}.tmp`;
  const tmp = childOf(dir, tmpName);
  const mode = opts.mode ?? before?.mode ?? 0o666;
  const fd = openRooted(tmp, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL, mode);
  let install: InstallId;
  let dirIdentity: DirId;
  try {
    try {
      await fdWriteAll(fd, bytes);
      if (opts.mode !== undefined || before) nodeFs.fchmodSync(fd, mode);
      await fdSync(fd);
      install = installIdOf(await fdStat(fd));
    } finally {
      nodeFs.closeSync(fd);
    }
    await opts.beforeInstall?.(install, tmp.abs);
    // Last checks before the irreversible step.
    if (identity) await assertIdentity(identity);
    if (!hashMatches(expect, await readRegularFile(file))) {
      throw new ToolError('stale', `file changed since prepared: ${abs} changed while it was being written`);
    }
    assertNotAborted(signal, abs);
    dirIdentity = within(dir, (at) => {
      const temp = nodeFs.lstatSync(at(tmpName), { bigint: true });
      if (!temp.isFile() || installIdOf(temp) !== install) throw new ToolError('stale', `the temp file for ${abs} was replaced before it was installed`);
      const here = dirId(nodeFs.lstatSync(at('.'), { bigint: true }));
      if (expect.kind === 'absent') {
        try {
          nodeFs.linkSync(at(tmpName), at(name));
        } catch (err) {
          if (errnoCode(err) === 'EEXIST') throw new ToolError('stale', `file changed since prepared: ${abs} was created meanwhile`);
          throw err;
        }
      } else {
        nodeFs.renameSync(at(tmpName), at(name));
      }
      return here;
    });
  } finally {
    // After `link` the temp name is still there; after `rename` it is gone.
    removeTempIfReachable(dir, tmpName);
  }
  const st = lstatOrNull(file);
  const id = st !== null && installIdOf(st) === install ? fileId(st) : undefined;
  return { before, createdDirs, install, id, dirId: dirIdentity };
}

/** A temp file whose directory can no longer be reached without a link stays where it is. */
function removeTempIfReachable(dir: RootedPath, name: string): void {
  try {
    within(dir, (at) => nodeFs.rmSync(at(name), { force: true }));
  } catch {
    return;
  }
}

function lstatOrNull(p: RootedPath): BigIntStats | null {
  try {
    return lstatRooted(p);
  } catch {
    return null;
  }
}

/**
 * Removes `file` when it is a regular file holding `expectHash`, reached
 * without any link, and still the file that was read.
 */
export function removeRegularFile(file: RootedPath, expectHash: string): Promise<void> {
  return withPathLock(file.abs, async () => {
    const current = await readRegularFile(file);
    if (current === null) return;
    if (sha256(current.bytes) !== expectHash) throw new ToolError('stale', `${file.abs} changed; not removed`);
    const { dir, name } = splitParent(file);
    within(dir, (at) => {
      if (fileId(nodeFs.lstatSync(at(name), { bigint: true })) !== current.id) throw new ToolError('stale', `${file.abs} changed; not removed`);
      nodeFs.unlinkSync(at(name));
    });
  });
}

/**
 * Removes `dir` when it is an empty real directory strictly inside one of
 * `roots`, reached without any link, and, when `id` is given, still the
 * directory with that identity. Returns whether it was removed.
 */
export async function removeEmptyDirInside(dir: string, roots: readonly string[], id?: DirId): Promise<boolean> {
  if (!path.isAbsolute(dir)) return false;
  const root = roots.find((r) => {
    const rel = path.relative(r, dir);
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  });
  if (root === undefined) return false;
  const { dir: parent, name } = splitParent(rooted(root, dir));
  try {
    return within(parent, (at) => {
      const st = nodeFs.lstatSync(at(name), { bigint: true });
      if (!st.isDirectory() || (id !== undefined && dirId(st) !== id)) return false;
      nodeFs.rmdirSync(at(name));
      return true;
    });
  } catch {
    return false;
  }
}

/**
 * fsyncs the directory at `dir`, after checking through the same handle that
 * it is still the directory `expected` names. Windows flushes a directory
 * only through a handle opened for writing.
 */
async function flushDir(dir: string, expected?: DirId): Promise<void> {
  const handle = await fs.open(dir, IS_WINDOWS ? 'r+' : 'r');
  try {
    if (expected !== undefined && dirId(await handle.stat({ bigint: true })) !== expected) {
      throw new ToolError('stale', `${dir} was moved or replaced after the run changed it, so its changes cannot be flushed`);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Errors that mean the file system cannot fsync a directory at all (FUSE, 9p, some NFS, a Windows volume without it). */
const UNSUPPORTED_SYNC = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', ...(IS_WINDOWS ? ['EISDIR', 'EPERM', 'EACCES'] : [])]);

/**
 * fsyncs a directory, so the entries renamed, linked or removed in it survive
 * a crash. Rejects when the flush fails, and with a `ToolError` when the file
 * system cannot flush a directory at all: there a rename is atomic but not
 * durable, so nothing that must survive a crash may rely on it.
 */
export async function syncDirStrict(
  dir: string,
  expected?: DirId,
  flush: (dir: string, expected?: DirId) => Promise<void> = flushDir,
): Promise<void> {
  try {
    await flush(dir, expected);
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
