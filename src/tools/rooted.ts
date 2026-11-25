import fs, { constants as FS, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { isMainThread } from 'node:worker_threads';
import { ToolError } from '../core/errors.js';

/**
 * Rooted file operations: a path inside a workspace root is reached from the
 * root one directory at a time, never through a symbolic link, and the final
 * syscall names its entry relative to the last directory reached. Nothing
 * re-resolves the path between that walk and the use, so a symbolic link
 * swapped into the path can make an operation fail but never lead it outside.
 *
 * Node has no `openat`. Two anchors stand in for the directory descriptor:
 * - Linux: `/proc/self/fd/<fd>/<name>`, which the kernel resolves from the
 *   directory the descriptor holds, whatever its path is now.
 * - Other POSIX systems (and Linux without a usable `/proc`): the process
 *   working directory. Each step must `lstat` as a real directory, is entered
 *   with `chdir`, and must then be the inode `lstat` saw (directories have no
 *   hard links). Inside one synchronous block, so no other JavaScript sees the
 *   changed cwd; the runtime uses absolute paths everywhere else.
 * Windows has neither, so rooted operations refuse there.
 */

export interface RootedPath {
  readonly root: string;
  readonly abs: string;
  readonly parts: readonly string[];
}

export function rooted(root: string, abs: string): RootedPath {
  const rel = path.relative(root, abs);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new ToolError('outside-workspace', `${abs} is outside ${root}`);
  }
  return { root, abs, parts: rel === '' ? [] : rel.split(path.sep) };
}

export function childOf(dir: RootedPath, name: string): RootedPath {
  return { root: dir.root, abs: path.join(dir.abs, name), parts: [...dir.parts, name] };
}

/** The directory holding `p` and the name of `p` in it; the root itself has neither. */
export function splitParent(p: RootedPath): { readonly dir: RootedPath; readonly name: string } {
  const name = p.parts.at(-1);
  if (name === undefined) throw new ToolError('invalid-args', `${p.abs} is the workspace root`);
  return { dir: { root: p.root, abs: path.dirname(p.abs), parts: p.parts.slice(0, -1) }, name };
}

/** Names an entry of the anchored directory (`'.'` for the directory itself). */
export type At = (name: string) => string;

type Anchor = <T>(dir: RootedPath, fn: (at: At) => T) => T;

/**
 * Linux `O_PATH`, which Node does not export: a walk step needs only search
 * permission on the directory, as a path lookup does. Same value on every
 * architecture Node supports.
 */
const O_PATH = 0o10000000;
const STEP_FLAGS = O_PATH | FS.O_DIRECTORY | FS.O_NOFOLLOW;

function errnoCode(err: unknown): string | undefined {
  if (err !== null && typeof err === 'object' && 'code' in err && typeof err.code === 'string') return err.code;
  return undefined;
}

function stepPath(dir: RootedPath, i: number): string {
  return path.join(dir.root, ...dir.parts.slice(0, i + 1));
}

function linkStep(dir: RootedPath, i: number): ToolError {
  return new ToolError('stale', `${stepPath(dir, i)} is a symbolic link; rooted file operations never follow one`);
}

export const procFdAnchor: Anchor = (dir, fn) => {
  let fd = fs.openSync(dir.root, STEP_FLAGS);
  try {
    for (let i = 0; i < dir.parts.length; i++) {
      const at = `/proc/self/fd/${fd}/${dir.parts[i] ?? ''}`;
      let next: number;
      try {
        next = fs.openSync(at, STEP_FLAGS);
      } catch (err) {
        if (errnoCode(err) === 'ENOTDIR' && fs.lstatSync(at, { throwIfNoEntry: false })?.isSymbolicLink() === true) throw linkStep(dir, i);
        throw err;
      }
      fs.closeSync(fd);
      fd = next;
    }
    const base = `/proc/self/fd/${fd}/`;
    return fn((name) => base + name);
  } finally {
    fs.closeSync(fd);
  }
};

export const cwdAnchor: Anchor = (dir, fn) => {
  if (!isMainThread) {
    throw new ToolError('containment-unavailable', 'rooted file operations on this platform move the working directory, which only the main thread can do');
  }
  let orig: string | undefined;
  try {
    orig = process.cwd();
  } catch {
    orig = undefined;
  }
  try {
    process.chdir(dir.root);
    for (let i = 0; i < dir.parts.length; i++) {
      const name = dir.parts[i] ?? '';
      const seen = fs.lstatSync(name, { bigint: true });
      if (seen.isSymbolicLink()) throw linkStep(dir, i);
      if (!seen.isDirectory()) throw Object.assign(new Error(`ENOTDIR: not a directory, ${stepPath(dir, i)}`), { code: 'ENOTDIR' });
      process.chdir(name);
      const entered = fs.statSync('.', { bigint: true });
      if (seen.dev !== entered.dev || seen.ino !== entered.ino) {
        throw new ToolError('stale', `${stepPath(dir, i)} was replaced while it was entered`);
      }
    }
    return fn((name) => name);
  } finally {
    if (orig !== undefined) returnToCwdIfItExists(orig);
  }
};

function returnToCwdIfItExists(dir: string): void {
  try {
    process.chdir(dir);
  } catch {
    return;
  }
}

const windowsAnchor: Anchor = () => {
  throw new ToolError(
    'containment-unavailable',
    'read, write, edit, grep and glob are not available on Windows: Node cannot open a file relative to a directory handle there, so the runtime cannot keep a path from being redirected outside the workspace while it is used',
  );
};

/** Whether `/proc/self/fd/<fd>` names the directory the descriptor holds (no `/proc`, or a foreign one, fails). */
function procFdWorks(): boolean {
  try {
    const fd = fs.openSync('/', STEP_FLAGS);
    try {
      const held = fs.fstatSync(fd, { bigint: true });
      const named = fs.statSync(`/proc/self/fd/${fd}/.`, { bigint: true });
      return held.dev === named.dev && held.ino === named.ino;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

let chosen: Anchor | undefined;

function anchor(): Anchor {
  chosen ??= process.platform === 'win32' ? windowsAnchor : process.platform === 'linux' && procFdWorks() ? procFdAnchor : cwdAnchor;
  return chosen;
}

/**
 * Runs `fn` with `dir` as the anchor. `fn` must be synchronous: what it does
 * with `at(name)` acts on the directory the walk reached. Throws `stale` when
 * a step is a symbolic link, and the step's errno (`ENOENT`, `ENOTDIR`) when
 * it is missing or not a directory.
 */
export function within<T>(dir: RootedPath, fn: (at: At) => T): T {
  return anchor()(dir, fn);
}

export function lstatRooted(p: RootedPath): BigIntStats {
  if (p.parts.length === 0) return within(p, (at) => fs.lstatSync(at('.'), { bigint: true }));
  const { dir, name } = splitParent(p);
  return within(dir, (at) => fs.lstatSync(at(name), { bigint: true }));
}

/** Opens `p` with `flags | O_NOFOLLOW` through the anchor of its directory; returns the descriptor. */
export function openRooted(p: RootedPath, flags: number, mode?: number): number {
  const { dir, name } = splitParent(p);
  return within(dir, (at) => fs.openSync(at(name), flags | FS.O_NOFOLLOW, mode));
}
