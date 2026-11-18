import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { ensureStateDir } from '../core/state-dir.js';
import { isProcessAlive } from './journal.js';

/**
 * Directories that live as long as one server process: its scratch directory,
 * private and directly in the system temp directory (so nothing of the state
 * dir ever has to open for scripts), and the saved originals of `undo`
 * (`<stateDir>/undo/<id>`). The id is random and unguessable. The owner record
 * (`<stateDir>/scratch/<id>.json`) names the scratch directory; it is written
 * first and removed last, outside what scripts can write, so a directory
 * without a record never belongs to a live process.
 */

const OwnerSchema = z.object({
  pid: z.number().int(),
  host: z.string(),
  startedAt: z.number(),
  /** When the owner process started, in the kernel's clock ticks since boot (Linux). */
  processStart: z.string().optional(),
  /** Real path of the scratch directory. */
  scratch: z.string().optional(),
});
const ID_PATTERN = /^[0-9a-f]{32}$/;
const RECORD_PATTERN = /^([0-9a-f]{32})\.json$/;
/** Slack when comparing a start time with the boot time. */
const BOOT_SLACK_MS = 10_000;

/** Name of the scratch directory of session `id`. */
export function scratchName(id: string): string {
  return `agent-code-mode-scratch-${id}`;
}

/** Temp directories a recorded scratch directory may sit directly in. */
async function tempDirs(): Promise<Set<string>> {
  const dirs = [os.tmpdir(), '/tmp', '/var/tmp'];
  const real = await Promise.all(dirs.map((d) => fs.realpath(d).catch(() => d)));
  return new Set([...dirs, ...real]);
}

/** The scratch directory a record names, when it is exactly what session `id` would have created. */
async function recordedScratch(id: string, recorded: string | undefined): Promise<string | undefined> {
  if (recorded === undefined || !path.isAbsolute(recorded)) return undefined;
  if (path.basename(recorded) !== scratchName(id) || !(await tempDirs()).has(path.dirname(recorded))) return undefined;
  const st = await fs.lstat(recorded).catch(() => null);
  return st !== null && st.isDirectory() && (process.getuid === undefined || st.uid === process.getuid()) ? recorded : undefined;
}

export function scratchBase(stateDir: string): string {
  return path.join(stateDir, 'scratch');
}

export function undoBase(stateDir: string): string {
  return path.join(stateDir, 'undo');
}

/** Clock ticks per second of `/proc/<pid>/stat` (`USER_HZ`, 100 on every Linux architecture Node runs on). */
const PROC_TICKS_PER_SECOND = 100;

/** Field 22 of `/proc/<pid>/stat`, when the kernel start time of `pid` can be read here. */
export function processStartTicks(pid: number, procRoot = '/proc'): string | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    // The command name (field 2) may hold spaces and parentheses: fields are counted after its closing one.
    const stat = readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8');
    return /^\d+$/.exec(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? '')?.[0];
  } catch {
    return undefined;
  }
}

/** Milliseconds since the epoch at which `pid` started, from the boot time and its start ticks. */
function processStartMs(pid: number, ticks: string, procRoot = '/proc'): number | undefined {
  try {
    const btime = /^btime (\d+)$/m.exec(readFileSync(path.join(procRoot, 'stat'), 'utf8'))?.[1];
    return btime === undefined ? undefined : Number(btime) * 1000 + (Number(ticks) * 1000) / PROC_TICKS_PER_SECOND;
  } catch {
    return undefined;
  }
}

/** Sessions of this process that are still open. */
const open = new Set<SessionDirs>();

interface Ready {
  readonly scratch: string;
  readonly undo: string;
}

export class SessionDirs {
  readonly id = randomBytes(16).toString('hex');
  readonly #stateDir: string;
  #ready: Promise<Ready> | undefined;
  #scratchPath: string | undefined;
  #closed = false;

  constructor(stateDir: string) {
    this.#stateDir = stateDir;
  }

  /** Real path of the scratch directory, created on the first call. */
  async scratch(): Promise<string> {
    return (await this.#init()).scratch;
  }

  /** Real path of the directory that holds saved originals, created on the first call. */
  async undo(): Promise<string> {
    return (await this.#init()).undo;
  }

  #init(): Promise<Ready> {
    if (this.#closed) return Promise.reject(new Error('the server session is closed'));
    this.#ready ??= this.#create();
    return this.#ready;
  }

  async #create(): Promise<Ready> {
    open.add(this);
    await ensureStateDir(this.#stateDir);
    await sweepDeadSessions(this.#stateDir);
    const records = scratchBase(this.#stateDir);
    const undoParent = undoBase(this.#stateDir);
    await fs.mkdir(records, { recursive: true, mode: 0o700 });
    await fs.mkdir(undoParent, { recursive: true, mode: 0o700 });
    const scratch = path.join(await fs.realpath(os.tmpdir()), scratchName(this.id));
    this.#scratchPath = scratch;
    const record = path.join(records, `${this.id}.json`);
    const next = `${record}.next`;
    const processStart = processStartTicks(process.pid);
    await fs.writeFile(next, JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: Date.now(), scratch, ...(processStart === undefined ? {} : { processStart }) }), { mode: 0o600, flag: 'wx' });
    await fs.rename(next, record);
    // Without `recursive`, an entry that already exists at the random name is an error instead of being adopted.
    await fs.mkdir(scratch, { mode: 0o700 });
    const st = await fs.lstat(scratch);
    if (!st.isDirectory() || (process.getuid !== undefined && st.uid !== process.getuid())) throw new Error(`${scratch} is not a private directory of this user`);
    if (process.platform !== 'win32') await fs.chmod(scratch, 0o700);
    await fs.mkdir(path.join(undoParent, this.id), { mode: 0o700 });
    const ready = { scratch: await fs.realpath(scratch), undo: await fs.realpath(path.join(undoParent, this.id)) };
    if (this.#closed) {
      this.#remove();
      throw new Error('the server session is closed');
    }
    return ready;
  }

  /** Removes both directories and the owner record. Synchronous, so it also works while the process exits. Idempotent. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    open.delete(this);
    this.#remove();
  }

  #remove(): void {
    const targets = [...(this.#scratchPath === undefined ? [] : [this.#scratchPath]), path.join(undoBase(this.#stateDir), this.id), path.join(scratchBase(this.#stateDir), `${this.id}.json`)];
    for (const target of targets) {
      try {
        rmSync(target, { recursive: true, force: true });
      } catch {
        // Left for the sweep of a later start.
      }
    }
  }
}

/** Closes every session of this process. */
export function closeAllSessions(): void {
  for (const session of [...open]) session.close();
}

function ownerGone(id: string, owner: z.infer<typeof OwnerSchema>): boolean {
  if (owner.pid === process.pid) return ![...open].some((s) => s.id === id);
  if (!isProcessAlive(owner.pid)) return true;
  // A pid alone does not say: the system hands a dead process's id to a new one.
  if (Date.now() - os.uptime() * 1000 > owner.startedAt + BOOT_SLACK_MS) return true;
  const ticks = processStartTicks(owner.pid);
  // Where the start time cannot be read, a live pid keeps its directories.
  if (ticks === undefined) return false;
  if (owner.processStart !== undefined) return owner.processStart !== ticks;
  const started = processStartMs(owner.pid, ticks);
  return started !== undefined && started > owner.startedAt + BOOT_SLACK_MS;
}

async function names(dir: string): Promise<string[]> {
  return fs.readdir(dir).catch(() => []);
}

/**
 * Removes the directories of server processes that are gone. A record that
 * cannot be read, or that names another machine (a state dir on a shared
 * disk), is left alone: its owner may be alive. Never throws.
 */
export async function sweepDeadSessions(stateDir: string): Promise<void> {
  const scratch = scratchBase(stateDir);
  const undo = undoBase(stateDir);
  // Directories are listed before records: an owner writes its record first, so a listed directory's record is seen.
  const undoEntries = await names(undo);
  const entries = await names(scratch);
  const recorded = new Set<string>();
  for (const name of entries) {
    const id = RECORD_PATTERN.exec(name)?.[1];
    if (id === undefined) continue;
    recorded.add(id);
    let owner: z.infer<typeof OwnerSchema>;
    try {
      const parsed = OwnerSchema.safeParse(JSON.parse(await fs.readFile(path.join(scratch, name), 'utf8')));
      if (!parsed.success) continue;
      owner = parsed.data;
    } catch {
      continue;
    }
    if (owner.host !== os.hostname() || !ownerGone(id, owner)) continue;
    const dir = await recordedScratch(id, owner.scratch);
    if (dir !== undefined) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(path.join(undo, id), { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(path.join(scratch, name), { force: true }).catch(() => undefined);
  }
  // The record is written first and removed last: a directory without one has no live owner.
  for (const name of undoEntries) {
    if (!ID_PATTERN.test(name) || recorded.has(name)) continue;
    // A listing is not atomic: the record of a session that started meanwhile may have been missed.
    const owned = await fs.access(path.join(scratch, `${name}.json`)).then(() => true, () => false);
    if (!owned) await fs.rm(path.join(undo, name), { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The part of `process` `closeSessionsOnExit` listens on. */
export interface SessionExitHooks {
  readonly stdin: { once(event: 'end', listener: () => void): unknown };
  on(event: 'exit' | 'SIGINT' | 'SIGTERM' | 'SIGHUP', listener: () => void): unknown;
  exit(code: number): void;
}

/**
 * Removes this process's session directories when the client goes away (stdin
 * EOF), on a stop signal and at exit. `exitOnSignal` is false when something
 * else already ends the process after a signal.
 */
export function closeSessionsOnExit(proc: SessionExitHooks, exitOnSignal: boolean): void {
  proc.stdin.once('end', closeAllSessions);
  proc.on('exit', closeAllSessions);
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const) {
    proc.on(signal, () => {
      closeAllSessions();
      if (exitOnSignal) proc.exit(code);
    });
  }
}
