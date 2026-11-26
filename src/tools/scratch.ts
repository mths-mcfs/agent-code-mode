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

const RECORD = /^((\d+)-[0-9a-f]{32})\.owner$/;

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

function ownedByUs(st: { uid: number }): boolean {
  return process.platform === 'win32' || st.uid === process.getuid?.();
}

const recordText = (name: string): string => `agent-code-mode scratch ${name}\n`;

/** Creates an empty directory only this user can open, named after this process so a later start can remove it if this one dies. */
export async function createScratch(base: string, limits: ScratchLimits = DEFAULT_LIMITS): Promise<ScratchDir> {
  await fs.mkdir(base, { recursive: true, mode: 0o700 });
  await assertPrivate(base);
  const name = `${process.pid}-${randomBytes(16).toString('hex')}`;
  // The record says this server made the directory: the startup sweep removes only directories that have one.
  const record = path.join(base, `${name}.owner`);
  await fs.writeFile(record, recordText(name), { flag: 'wx', mode: 0o600 });
  const dir = path.join(base, name);
  try {
    // Without `recursive`, an entry already at the random name is an error instead of being adopted.
    await fs.mkdir(dir, { mode: 0o700 });
  } catch (err) {
    await fs.rm(record, { force: true });
    throw err;
  }
  const real = await fs.realpath(dir);
  return new Scratch(real, record, limits);
}

export interface ScratchLimits {
  readonly bytes: number;
  readonly entries: number;
}

const DEFAULT_LIMITS: ScratchLimits = { bytes: MAX_SCRATCH_BYTES, entries: MAX_SCRATCH_ENTRIES };

class Scratch implements ScratchDir {
  readonly path: string;
  readonly #record: string;
  readonly #limits: ScratchLimits;
  #removed = false;

  constructor(dir: string, record: string, limits: ScratchLimits) {
    this.path = dir;
    this.#record = record;
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
    if (failed !== undefined) return failed;
    this.#removed = true;
    await fs.rm(this.#record, { force: true }).catch(() => undefined);
    return undefined;
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
 * Removes the scratch directories of server processes that are gone. It acts
 * only in a base that is a real directory private to this user, and only on a
 * directory this server recorded making (`<name>.owner`, outside what scripts
 * can write), that is a real directory owned by this user, right in the base.
 * A directory of a live process (this one included) is left alone; a reused
 * pid keeps a dead run's directory until that process ends too. Never throws.
 */
export async function sweepScratch(base: string): Promise<void> {
  try {
    await assertPrivate(base);
  } catch {
    return;
  }
  const names = await fs.readdir(base).catch(() => [] as string[]);
  for (const entry of names) {
    const m = RECORD.exec(entry);
    const name = m?.[1];
    const pid = Number(m?.[2]);
    if (name === undefined || !Number.isInteger(pid) || pid <= 0 || pid === process.pid || isAlive(pid)) continue;
    const record = path.join(base, entry);
    const recorded = await fs.lstat(record).catch(() => null);
    if (recorded === null || !recorded.isFile() || !ownedByUs(recorded)) continue;
    if ((await fs.readFile(record, 'utf8').catch(() => '')) !== recordText(name)) continue;
    const dir = path.join(base, name);
    const st = await fs.lstat(dir).catch(() => null);
    if (st !== null && (!st.isDirectory() || !ownedByUs(st))) continue;
    if (st !== null && (await removeTree(dir)) !== undefined) continue;
    await fs.rm(record, { force: true }).catch(() => undefined);
  }
}
