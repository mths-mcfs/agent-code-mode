/*
 * The journal design (original bytes written durably before the first change,
 * restore only files that still hold what this process wrote, recovery of a
 * record whose process is gone) follows Turnpack's src/journal.ts
 * (https://github.com/OnlyTerp/turnpack, Copyright 2026 OnlyTerp, Apache-2.0).
 * Modified by the agent-code-mode authors: the record grows one file at a time
 * across a run instead of being written once per call, and it is restored
 * through the workspace jail checks of this project.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { ToolError, TransactionFinalizeError, errorMessage } from '../core/errors.js';
import type { RollbackReport, Transaction } from '../core/types.js';
import {
  type DirId,
  type FileId,
  type InstallId,
  type RegularFile,
  currentDirId,
  installIdFrom,
  tempLeftover,
  atomicWrite,
  errnoCode,
  readRegularFile,
  removeEmptyDirInside,
  removeRegularFile,
  sha256,
  syncDirStrict,
  writeDurable,
} from './fs-ops.js';
import { findMatchingPattern } from '../core/paths.js';
import { expandTilde, isInsideDir, isInsideGitDir } from './jail.js';
import { type RootedPath, rooted } from './rooted.js';

/** Above this many bytes of originals a transaction refuses further writes. */
export const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
/** Slack when comparing a start time with the boot time. */
const BOOT_SLACK_MS = 10_000;
const MANIFEST = 'manifest.json';
const RECOVERING = '.recovering-';
/**
 * Suffix of a finalized transaction directory. Renaming `<txid>` to
 * `<txid>.committed` is the commit point: recovery never undoes such a
 * directory, whatever is left in it, and only deletes it.
 */
export const COMMITTED = '.committed';

const EntrySchema = z.object({
  path: z.string().min(1),
  existed: z.boolean(),
  /** SHA-256 of the original bytes ('' when absent). */
  original: z.string(),
  mode: z.number().int().nullable(),
  /** Blob file name holding the original bytes (null when absent). */
  blob: z.string().regex(/^[0-9]+\.bin$/).nullable(),
  /** Wall-clock time (ms) of the latest write to the file; recovery undoes writes newest first across journals. */
  at: z.number().optional(),
  /** Identity of the original when the transaction first wrote the file (null when absent): a file still with it was never touched. */
  originalId: z.string().nullable().optional(),
  /**
   * Each install at the path: the temp file and its identity, recorded before
   * the rename, and the file's identity once the install was confirmed.
   * Recovery restores only a file whose identity is the last confirmed one.
   */
  installs: z.array(z.object({ id: z.string(), temp: z.string().optional(), confirmed: z.string().optional() })).optional(),
});

const ManifestSchema = z.object({
  version: z.literal(1),
  pid: z.number().int(),
  host: z.string(),
  startedAt: z.number(),
  roots: z.array(z.string()),
  /** Directories the transaction created, outermost first. */
  dirs: z.array(z.string()),
  entries: z.array(EntrySchema),
});

type Manifest = z.infer<typeof ManifestSchema>;
type Entry = z.infer<typeof EntrySchema>;

/** Journal directory under the server state dir. */
export function journalRoot(stateDir: string): string {
  return path.join(stateDir, 'journal');
}

/** File system steps of finalization; replaceable in tests. */
export interface JournalIo {
  /** fsyncs a directory (checking it is still `expected` when given) and rejects when that fails or the file system cannot do it. */
  readonly syncDir: (dir: string, expected?: DirId) => Promise<void>;
  /** Deletes a finalized transaction directory. */
  readonly removeDir: (dir: string) => Promise<void>;
}

const defaultIo: JournalIo = {
  syncDir: syncDirStrict,
  removeDir: (dir) => fs.rm(dir, { recursive: true, force: true }),
};

/** Per journal root, the first directory a `mkdir` created whose parents are not yet known to be flushed. */
const unflushedAncestors = new Map<string, string>();

/** Ids of transactions this process still has open; a recovery pass leaves them alone. */
const openTransactions = new Set<string>();

const TXID = /^[0-9a-z]+-\d+-[0-9a-f]+$/;

function writeTime(): number {
  return performance.timeOrigin + performance.now();
}

/**
 * Throws unless `dir` is a real directory (not a link) that only this user
 * can write: journals are restored from and deleted in it.
 */
async function assertPrivateDir(dir: string): Promise<void> {
  const st = await fs.lstat(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new ToolError('tool-error', `journal directory ${dir} is not a real directory`);
  if (process.platform === 'win32') return;
  const uid = process.getuid?.();
  if ((uid !== undefined && st.uid !== uid) || (st.mode & 0o022) !== 0) {
    throw new ToolError('tool-error', `journal directory ${dir} is not private to this user (owner ${st.uid}, mode ${(st.mode & 0o777).toString(8)})`);
  }
}

interface LiveEntry {
  readonly entry: Entry;
  /** Workspace root the file is reached from. */
  readonly root: string;
  /** Original bytes, kept in memory for the in-process rollback. */
  readonly bytes: Buffer | null;
  /** What this transaction last wrote, or null after a failed write. */
  last: { readonly hash: string; readonly id: FileId } | null;
}

/** How finalization ended, once it did. */
type Finalized = { readonly durable: true } | { readonly durable: false; readonly error: TransactionFinalizeError };

/**
 * A per-run journal. The first write to a file snapshots its original bytes
 * (or "absent") in memory and durably under `<stateDir>/journal/<txid>/`
 * before the file is touched.
 */
export class FileTransaction implements Transaction {
  readonly id: string;
  readonly dir: string;
  readonly #roots: string[] = [];
  readonly #startedAt = Date.now();
  readonly #entries = new Map<string, LiveEntry>();
  readonly #dirs: string[] = [];
  /** Directories this transaction's writes really created, with their identity; only those are removed by the in-process rollback. */
  readonly #ownDirs = new Map<string, DirId>();
  /** Identity of each directory whose entries this transaction changed, when it changed them; finalization flushes only those still there. */
  readonly #changedDirs = new Map<string, DirId>();
  readonly #flushable = new Set<string>();
  #bytes = 0;
  #created = false;
  /** Whether the journal root was flushed after this journal's directory was created in it. */
  #dirFlushed = false;
  #closed = false;
  #finalized: Finalized | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  readonly #io: JournalIo;

  constructor(stateDir: string, io: JournalIo = defaultIo) {
    this.#io = io;
    this.id = `${this.#startedAt.toString(36)}-${process.pid}-${randomBytes(4).toString('hex')}`;
    this.dir = path.join(journalRoot(stateDir), this.id);
    openTransactions.add(this.id);
  }

  /** True once rolled back or disposed. */
  get closed(): boolean {
    return this.#closed;
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(fn, fn);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  #manifest(): Manifest {
    return {
      version: 1,
      pid: process.pid,
      host: os.hostname(),
      startedAt: this.#startedAt,
      roots: [...this.#roots],
      dirs: [...this.#dirs],
      entries: [...this.#entries.values()].map((live) => live.entry),
    };
  }

  /** Writes the manifest; once it resolves, the record survives a crash (where directories can be flushed). */
  async #persist(): Promise<void> {
    if (!this.#created) {
      const root = path.dirname(this.dir);
      const firstCreated = (await firstMissing(root)) ?? unflushedAncestors.get(root);
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      await assertPrivateDir(root);
      if (firstCreated !== undefined) unflushedAncestors.set(root, firstCreated);
      await syncParentsOfCreated(root, firstCreated, this.#io.syncDir);
      unflushedAncestors.delete(root);
      await fs.mkdir(this.dir, { mode: 0o700 });
      this.#created = true;
    }
    if (!this.#dirFlushed) {
      await this.#io.syncDir(path.dirname(this.dir));
      this.#dirFlushed = true;
    }
    const next = path.join(this.dir, `${MANIFEST}.next`);
    await writeDurable(next, JSON.stringify(this.#manifest()));
    await fs.rename(next, path.join(this.dir, MANIFEST));
    await this.#io.syncDir(this.dir);
  }

  /**
   * Called by a commit after the stale check and before the write. Records
   * the original on the first write to `absPath`. Throws when the journal is
   * full or closed.
   */
  record(
    absPath: string,
    root: string,
    before: RegularFile | null,
    createdDirs: readonly string[],
  ): Promise<void> {
    return this.#serial(async () => {
      if (this.#closed) throw new ToolError('tool-error', 'the transaction is already finished');
      await this.#assertFlushable(path.dirname(createdDirs[0] ?? absPath), absPath);
      if (!this.#roots.includes(root)) this.#roots.push(root);
      const existing = this.#entries.get(absPath);
      if (existing) {
        // Another writer changed the file since this transaction last wrote it: restoring the
        // original later would discard that change, so the write is refused.
        const current = before ? sha256(before.bytes) : null;
        const ours = existing.last?.hash ?? (existing.entry.existed ? existing.entry.original : null);
        if (current !== ours || (existing.last !== null && before?.id !== existing.last.id)) {
          throw new ToolError('stale', `${absPath} was changed by another writer since this transaction last wrote it`);
        }
        existing.entry.at = writeTime();
        await this.#persist();
        return;
      }
      const size = before?.bytes.length ?? 0;
      if (this.#bytes + size > MAX_JOURNAL_BYTES) {
        throw new ToolError(
          'tool-error',
          `transaction journal is full: snapshotting ${absPath} (${size} bytes) would exceed ${MAX_JOURNAL_BYTES} bytes, so the write was refused to keep rollback possible`,
        );
      }
      let blob: string | null = null;
      if (before) {
        if (!this.#created) await this.#persist();
        blob = `${this.#entries.size}.bin`;
        await writeDurable(path.join(this.dir, blob), before.bytes);
      }
      this.#bytes += size;
      for (const d of createdDirs) if (!this.#dirs.includes(d)) this.#dirs.push(d);
      this.#entries.set(absPath, {
        entry: {
          path: absPath,
          existed: before !== null,
          original: before ? sha256(before.bytes) : '',
          mode: before?.mode ?? null,
          blob,
          at: writeTime(),
          originalId: before?.id ?? null,
          installs: [],
        },
        root,
        bytes: before?.bytes ?? null,
        last: null,
      });
      await this.#persist();
    });
  }

  async #assertFlushable(dir: string, absPath: string): Promise<void> {
    if (this.#flushable.has(dir)) return;
    try {
      await this.#io.syncDir(dir);
    } catch (err) {
      throw new ToolError('tool-error', `refused to write ${absPath} in a transaction: ${errorMessage(err)}`);
    }
    this.#flushable.add(dir);
  }

  /** Called as soon as a write of this transaction creates a directory, with its parent's identity. */
  dirCreated(dir: string, id: DirId, parent: DirId | undefined): void {
    this.#ownDirs.set(dir, id);
    if (parent !== undefined && !this.#changedDirs.has(path.dirname(dir))) this.#changedDirs.set(path.dirname(dir), parent);
  }

  /** Called right before a write installs its temp file at `absPath`: the record of that identity reaches disk first. */
  installing(absPath: string, install: InstallId, temp: string): Promise<void> {
    return this.#serial(async () => {
      const live = this.#entries.get(absPath);
      if (!live || this.#closed) throw new ToolError('tool-error', 'the transaction is already finished');
      (live.entry.installs ??= []).push({ id: install, temp });
      await this.#persist();
    });
  }

  /** Called after a write installed its file; `id` is the file's identity, undefined when another writer replaced it at once. */
  written(absPath: string, hash: string, id: FileId | undefined, dir: DirId): Promise<void> {
    const live = this.#entries.get(absPath);
    if (!live) return Promise.resolve();
    live.last = id === undefined ? null : { hash, id };
    if (!this.#changedDirs.has(path.dirname(absPath))) this.#changedDirs.set(path.dirname(absPath), dir);
    const install = live.entry.installs?.at(-1);
    if (id === undefined || install === undefined || install.id !== installIdFrom(id)) return Promise.resolve();
    install.confirmed = id;
    return this.#serial(async () => {
      if (!this.#closed) await this.#persist();
    });
  }

  rollback(): Promise<RollbackReport> {
    return this.#serial(async () => {
      if (this.#closed) return { restored: [], skipped: [] };
      this.#closed = true;
      openTransactions.delete(this.id);
      const restored: string[] = [];
      const skipped: { path: string; reason: 'changed-externally' | 'error'; detail?: string }[] = [];
      for (const live of [...this.#entries.values()].reverse()) {
        const { entry } = live;
        try {
          const file = rooted(live.root, entry.path);
          const current = await readRegularFile(file);
          const currentHash = current ? sha256(current.bytes) : null;
          const originalHash = entry.existed ? entry.original : null;
          if (currentHash === originalHash) continue;
          if (live.last === null || currentHash !== live.last.hash || current?.id !== live.last.id) {
            skipped.push({ path: entry.path, reason: 'changed-externally', detail: 'the file no longer holds what this run wrote' });
            continue;
          }
          await restoreEntry(file, entry, live.bytes, currentHash);
          restored.push(entry.path);
        } catch (err) {
          skipped.push({ path: entry.path, reason: 'error', detail: errorMessage(err) });
        }
      }
      const ownDirs = [...this.#ownDirs.keys()];
      await removeCreatedDirs(this.#ownDirs, this.#roots);
      const restoresOnDisk = await flushes(touchedDirs(restored, ownDirs), this.#io.syncDir);
      const needsRecovery = !restoresOnDisk || skipped.some((s) => s.reason === 'error');
      if (needsRecovery) await this.#flushRecord();
      else await this.#removeRecord();
      return { restored, skipped };
    });
  }

  /**
   * Commits the journal: fsyncs every workspace directory the run changed,
   * renames the journal directory to `<id>.committed`, which recovery never
   * undoes, then fsyncs the journal root so the rename is durable. The
   * recursive delete of the renamed directory runs afterwards and is not
   * awaited. Rejects with `TransactionFinalizeError`: not committed when a
   * flush before the rename or the rename failed (the journal stays open for
   * a rollback), committed when only the last fsync failed. Called again, it
   * settles the same way.
   */
  dispose(): Promise<void> {
    return this.#serial(async () => {
      if (this.#finalized) {
        if (this.#finalized.durable) return;
        throw this.#finalized.error;
      }
      if (this.#closed) return;
      if (!this.#created) {
        this.#closed = true;
        this.#finalized = { durable: true };
        openTransactions.delete(this.id);
        return;
      }
      const committed = `${this.dir}${COMMITTED}`;
      try {
        for (const [dir, id] of this.#changedDirs) {
          await this.#io.syncDir(dir, id);
          if ((await currentDirId(dir)) !== id) throw new Error(`${dir} was moved or replaced after the run changed it`);
        }
        await fs.rename(this.dir, committed);
      } catch (err) {
        throw new TransactionFinalizeError(false, `could not finalize the transaction journal: ${errorMessage(err)}`);
      }
      this.#closed = true;
      this.#created = false;
      openTransactions.delete(this.id);
      try {
        await this.#io.syncDir(path.dirname(this.dir));
      } catch (err) {
        // The committed record stays: recovery deletes it without undoing anything.
        const error = new TransactionFinalizeError(
          true,
          `the transaction journal was finalized, but flushing it to disk failed (${errorMessage(err)}); the changes are on disk, but their durability is not guaranteed`,
        );
        this.#finalized = { durable: false, error };
        throw error;
      }
      this.#finalized = { durable: true };
      void this.#io.removeDir(committed).catch(() => undefined);
    });
  }

  /** Keeps the record on disk for a recovery pass and stops tracking it here. */
  async #flushRecord(): Promise<void> {
    if (!this.#created) return;
    await this.#persist().catch(() => undefined);
    this.#created = false;
  }

  async #removeRecord(): Promise<void> {
    if (!this.#created) return;
    await fs.rm(this.dir, { recursive: true, force: true });
    this.#created = false;
  }
}

async function restoreEntry(file: RootedPath, entry: Entry, bytes: Buffer | null, currentHash: string | null): Promise<void> {
  if (isInsideGitDir(entry.path)) throw new ToolError('protected-path', 'inside a .git directory');
  if (!entry.existed) {
    if (currentHash !== null) await removeRegularFile(file, currentHash);
    return;
  }
  if (bytes === null || sha256(bytes) !== entry.original) throw new ToolError('tool-error', 'the saved original is damaged');
  const expect = currentHash === null ? ({ kind: 'absent' } as const) : ({ kind: 'hash', sha256: currentHash } as const);
  await atomicWrite(file, bytes, expect, entry.mode !== null ? { mode: entry.mode } : {});
}

function touchedDirs(files: readonly string[], createdDirs: readonly string[]): string[] {
  return [...new Set([...files, ...createdDirs].map((p) => path.dirname(p)))];
}

function isGone(err: unknown): boolean {
  const code = errnoCode(err);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** The outermost missing directory on the way to `dir`; `mkdir`'s own answer is not reliable on Windows. */
async function firstMissing(dir: string): Promise<string | undefined> {
  let missing: string | undefined;
  for (let d = dir; ; d = path.dirname(d)) {
    if (await fs.lstat(d).then(() => true, (err: unknown) => !isGone(err))) return missing;
    missing = d;
    if (path.dirname(d) === d) return missing;
  }
}

function depth(p: string): number {
  return path.resolve(p).split(/[\\/]+/).filter(Boolean).length;
}

/** Counts levels rather than comparing names, which can be spelled differently (case, Windows 8.3 names). */
async function syncParentsOfCreated(dir: string, firstCreated: string | undefined, sync: (dir: string) => Promise<void>): Promise<void> {
  const created = firstCreated === undefined ? 0 : Math.max(0, depth(dir) - depth(firstCreated));
  let parent = path.dirname(dir);
  await sync(parent);
  for (let i = 0; i < created; i++) {
    parent = path.dirname(parent);
    await sync(parent);
  }
}

function flushes(dirs: readonly string[], sync: (dir: string) => Promise<void>): Promise<boolean> {
  return syncExisting(dirs, sync).then(
    () => true,
    () => false,
  );
}

async function syncExisting(dirs: readonly string[], sync: (dir: string) => Promise<void>): Promise<void> {
  for (const dir of dirs) {
    try {
      await sync(dir);
    } catch (err) {
      if (!isGone(err)) throw err;
    }
  }
}

/** Removes created directories that are empty, real, strictly inside `roots` and still the ones created, deepest first. */
async function removeCreatedDirs(dirs: ReadonlyMap<string, DirId>, roots: readonly string[]): Promise<void> {
  for (const [d, id] of [...dirs].sort(([a], [b]) => b.length - a.length)) await removeEmptyDirInside(d, roots, id);
}

// ---------------------------------------------------------------------------
// Crash recovery.
// ---------------------------------------------------------------------------

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errnoCode(err) === 'EPERM';
  }
}

/** Whether the process that wrote a record can no longer be running it. */
function ownerGone(manifest: Manifest, openHere: ReadonlySet<string>, id: string): boolean {
  if (manifest.pid === process.pid) return !openHere.has(id);
  if (!isAlive(manifest.pid)) return true;
  // A pid alone does not say: the system hands a dead process's id to a new one.
  const bootedAt = Date.now() - os.uptime() * 1000;
  return bootedAt > manifest.startedAt + BOOT_SLACK_MS;
}

/** A temp file a cut install left: a wrong delete would lose data, so it is only reported. */
export interface LeftoverTemp {
  readonly path: string;
  readonly identityMatches: boolean;
}

/** What a recovery pass did for one stale journal. */
export interface RecoveredJournal {
  readonly id: string;
  readonly report: RollbackReport;
  /** Set for a finalized run's leftover journal, which is only deleted. */
  readonly finalized?: true;
  /** Recorded temp paths of installs the crash cut that still exist; recovery never deletes them. */
  readonly leftoverTemps?: readonly LeftoverTemp[];
}

async function realOrSelf(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return p;
  }
}

async function readOriginal(dir: string, entry: Entry): Promise<Buffer | null> {
  if (entry.blob === null) return null;
  return fs.readFile(path.join(dir, entry.blob));
}

/** A claimed stale journal and what undoing it has done so far. */
interface Claimed {
  readonly id: string;
  readonly dir: string;
  readonly manifest: Manifest;
  readonly restored: string[];
  readonly skipped: { path: string; reason: 'changed-externally' | 'error'; detail?: string }[];
  readonly leftoverTemps: LeftoverTemp[];
}

async function undoEntry(
  record: Claimed,
  entry: Entry,
  roots: readonly string[],
  protectedPaths: readonly string[],
): Promise<void> {
  const { manifest, dir, restored, skipped, leftoverTemps } = record;
  try {
    // The record is data on disk: each path is checked like a tool argument.
    const root = path.isAbsolute(entry.path) ? roots.find((r) => isInsideDir(r, entry.path)) : undefined;
    if (root === undefined) {
      skipped.push({ path: entry.path, reason: 'error', detail: 'outside the workspace roots; not touched' });
      return;
    }
    if (!manifest.roots.some((root) => isInsideDir(root, entry.path))) {
      skipped.push({ path: entry.path, reason: 'error', detail: 'outside the roots the journal was written for; not touched' });
      return;
    }
    const hit = findMatchingPattern(entry.path, protectedPaths);
    if (hit !== undefined) {
      skipped.push({ path: entry.path, reason: 'error', detail: `a protected host policy path (${hit}); not touched` });
      return;
    }
    for (const install of entry.installs ?? []) {
      const left = install.temp === undefined ? undefined : await tempLeftover(install.temp, install.id);
      if (install.temp !== undefined && left !== undefined) leftoverTemps.push({ path: install.temp, ...left });
    }
    const file = rooted(root, entry.path);
    const current = await readRegularFile(file);
    const untouched = current === null ? !entry.existed : current.id === entry.originalId;
    if (untouched) return;
    const lastConfirmed = (entry.installs ?? []).findLast((install) => install.confirmed !== undefined)?.confirmed;
    if (current === null || current.id !== lastConfirmed) {
      skipped.push({
        path: entry.path,
        reason: 'changed-externally',
        detail: 'conflict: the file is not the one the crashed run last installed, so it was left as it is and the record kept',
      });
      return;
    }
    const bytes = await readOriginal(dir, entry);
    await restoreEntry(file, entry, bytes, sha256(current.bytes));
    restored.push(entry.path);
  } catch (err) {
    skipped.push({ path: entry.path, reason: 'error', detail: errorMessage(err) });
  }
}

function isCommitted(name: string): boolean {
  return name.endsWith(COMMITTED);
}

/**
 * Restores every journal left by a server process that is gone and that
 * touched one of `roots`. Writes are undone newest first across journals, so
 * two cut-off runs that changed the same file unwind in order. Files are
 * restored only when they still hold what that run wrote and are not
 * protected by `protectedPaths` (host policy patterns, `~` expanded);
 * anything else is reported in `skipped`. A journal with a file that could not
 * be handled is kept for a later pass. Nothing is read or deleted unless the
 * journal directory is private to this user. Never throws.
 */
export async function recoverStaleJournals(
  stateDir: string,
  roots: readonly string[],
  protectedPaths: readonly string[],
): Promise<RecoveredJournal[]> {
  const base = journalRoot(stateDir);
  let names: string[];
  try {
    await assertPrivateDir(base);
    names = await fs.readdir(base);
  } catch {
    return [];
  }
  const realRoots = await Promise.all(roots.filter((r) => path.isAbsolute(r)).map(realOrSelf));
  const patterns = protectedPaths.map((p) => expandTilde(p));
  const out: RecoveredJournal[] = [];
  // A finalized run is never undone, whatever its directory still holds; it is only deleted.
  for (const name of names.filter(isCommitted)) {
    const id = name.slice(0, -COMMITTED.length);
    if (!TXID.test(id)) continue;
    const dir = path.join(base, name);
    const st = await fs.lstat(dir).catch(() => null);
    if (!st?.isDirectory()) continue;
    const removed = await fs.rm(dir, { recursive: true, force: true }).then(
      () => true,
      () => false,
    );
    if (removed) out.push({ id, report: { restored: [], skipped: [] }, finalized: true });
  }
  // The id pattern below also rejects `<txid>.committed`, so a finalized run is never read as pending.
  const records = names
    .map((name) => ({ name, id: name.includes(RECOVERING) ? name.slice(0, name.indexOf(RECOVERING)) : name }))
    .filter((r) => TXID.test(r.id));
  const claimed: Claimed[] = [];
  for (const record of records) {
    const dir = path.join(base, record.name);
    try {
      const st = await fs.lstat(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) continue;
      const raw: unknown = JSON.parse(await fs.readFile(path.join(dir, MANIFEST), 'utf8'));
      const parsed = ManifestSchema.safeParse(raw);
      if (!parsed.success) continue;
      const manifest = parsed.data;
      if (manifest.host !== os.hostname()) continue;
      if (!manifest.roots.some((r) => realRoots.some((root) => isInsideDir(root, r) || isInsideDir(r, root)))) continue;
      if (record.name.includes(RECOVERING)) {
        const claimer = Number(record.name.slice(record.name.indexOf(RECOVERING) + RECOVERING.length));
        if (claimer !== process.pid && isAlive(claimer)) continue;
      } else if (!ownerGone(manifest, openTransactions, record.id)) {
        continue;
      }
      const target = path.join(base, `${record.id}${RECOVERING}${process.pid}`);
      if (target !== dir) {
        try {
          await fs.rename(dir, target);
        } catch {
          continue;
        }
      }
      claimed.push({ id: record.id, dir: target, manifest, restored: [], skipped: [], leftoverTemps: [] });
    } catch {
      // One bad record must not stop the others.
    }
  }
  const writes = claimed
    .flatMap((record) => record.manifest.entries.map((entry) => ({ record, entry })))
    .sort((a, b) => (b.entry.at ?? b.record.manifest.startedAt) - (a.entry.at ?? a.record.manifest.startedAt));
  for (const { record, entry } of writes) await undoEntry(record, entry, realRoots, patterns);
  for (const record of claimed) {
    try {
      // The journal contains planned directory names and cannot establish ownership after a crash.
      const restoresOnDisk = await flushes(touchedDirs(record.restored, []), syncDirStrict);
      const needsRecovery = !restoresOnDisk || record.skipped.length > 0;
      if (!needsRecovery) await fs.rm(record.dir, { recursive: true, force: true });
      out.push({
        id: record.id,
        report: { restored: record.restored, skipped: record.skipped },
        ...(record.leftoverTemps.length > 0 ? { leftoverTemps: record.leftoverTemps } : {}),
      });
    } catch {
      // One bad record must not stop the others.
    }
  }
  return out;
}
