import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { errorMessage } from '../core/errors.js';
import type { ScratchDir } from '../core/types.js';
import { errnoCode } from './fs-ops.js';

/** Most bytes on disk one run's scratch directory may hold. */
export const MAX_SCRATCH_BYTES = 512 * 1024 * 1024;
/** Most entries (files, directories, links) one run's scratch directory may hold. */
export const MAX_SCRATCH_ENTRIES = 20_000;

const NAME = /^(\d+)-[0-9a-f]{32}$/;

/**
 * Where runs' scratch directories live: next to the server state directory
 * (`~/.local/state/agent-code-mode-scratch` by default), so on disk rather
 * than in the system temp directory, which is often a small tmpfs, and
 * outside the state directory itself, which scripts never write.
 */
export function scratchBase(stateDir: string): string {
  return path.join(path.dirname(stateDir), `${path.basename(stateDir)}-scratch`);
}

async function assertPrivate(dir: string): Promise<void> {
  const st = await fs.lstat(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} is not a real directory`);
  if (process.platform === 'win32') return;
  if (st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) {
    throw new Error(`${dir} is not private to this user (owner ${st.uid}, mode ${(st.mode & 0o777).toString(8)})`);
  }
}

/** Creates an empty directory only this user can open, named after this process so a later start can remove it if this one dies. */
export async function createScratch(base: string, limits: ScratchLimits = DEFAULT_LIMITS): Promise<ScratchDir> {
  await fs.mkdir(base, { recursive: true, mode: 0o700 });
  await assertPrivate(base);
  const dir = path.join(base, `${process.pid}-${randomBytes(16).toString('hex')}`);
  // Without `recursive`, an entry already at the random name is an error instead of being adopted.
  await fs.mkdir(dir, { mode: 0o700 });
  const real = await fs.realpath(dir);
  return new Scratch(real, limits);
}

export interface ScratchLimits {
  readonly bytes: number;
  readonly entries: number;
}

const DEFAULT_LIMITS: ScratchLimits = { bytes: MAX_SCRATCH_BYTES, entries: MAX_SCRATCH_ENTRIES };

class Scratch implements ScratchDir {
  readonly path: string;
  readonly #limits: ScratchLimits;
  #removed = false;

  constructor(dir: string, limits: ScratchLimits) {
    this.path = dir;
    this.#limits = limits;
  }

  async enforceLimit(): Promise<string | undefined> {
    if (this.#removed) return undefined;
    const over = await overLimit(this.path, this.#limits);
    if (over === undefined) return undefined;
    const left = await emptyDir(this.path);
    return `the scratch directory passed ${over} and was emptied${left === undefined ? '' : `, but not all of it could be removed (${left})`}`;
  }

  async remove(): Promise<string | undefined> {
    if (this.#removed) return undefined;
    const failed = await removeTree(this.path);
    if (failed === undefined) this.#removed = true;
    return failed;
  }
}

async function overLimit(dir: string, limits: ScratchLimits): Promise<string | undefined> {
  let bytes = 0;
  let entries = 0;
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop() ?? dir;
    const names = await fs.readdir(current).catch(() => [] as string[]);
    for (const name of names) {
      entries++;
      if (entries > limits.entries) return `${limits.entries} entries`;
      const full = path.join(current, name);
      const st = await fs.lstat(full).catch(() => null);
      if (st === null) continue;
      // Space on disk, so a sparse file counts for what it uses.
      bytes += process.platform === 'win32' ? st.size : st.blocks * 512;
      if (bytes > limits.bytes) return `${limits.bytes} bytes`;
      if (st.isDirectory()) pending.push(full);
    }
  }
  return undefined;
}

async function emptyDir(dir: string): Promise<string | undefined> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  let failed: string | undefined;
  for (const name of names) failed = (await removeTree(path.join(dir, name))) ?? failed;
  return failed;
}

/** `rm -rf`, after making the directories of the tree writable again when a script took that away. */
async function removeTree(target: string): Promise<string | undefined> {
  try {
    await fs.rm(target, { recursive: true, force: true, maxRetries: 2 });
    return undefined;
  } catch (err) {
    if (errnoCode(err) !== 'EACCES' && errnoCode(err) !== 'EPERM') return errorMessage(err);
  }
  await restoreDirModes(target);
  try {
    await fs.rm(target, { recursive: true, force: true, maxRetries: 2 });
    return undefined;
  } catch (err) {
    return errorMessage(err);
  }
}

async function restoreDirModes(dir: string): Promise<void> {
  const st = await fs.lstat(dir).catch(() => null);
  if (st === null || !st.isDirectory()) return;
  await fs.chmod(dir, 0o700).catch(() => undefined);
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  for (const name of names) await restoreDirModes(path.join(dir, name));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errnoCode(err) === 'EPERM';
  }
}

/**
 * Removes the scratch directories of server processes that are gone. A
 * directory of a live process (this one included) is left alone; a reused
 * pid keeps a dead run's directory until that process ends too. Never throws.
 */
export async function sweepScratch(base: string): Promise<void> {
  const names = await fs.readdir(base).catch(() => [] as string[]);
  for (const name of names) {
    const pid = Number(NAME.exec(name)?.[1]);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || isAlive(pid)) continue;
    await removeTree(path.join(base, name));
  }
}
