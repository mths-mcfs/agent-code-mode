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
  type RegularFile,
  assertDirUnchanged,
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
  /** Hashes this transaction wrote (or was about to write) to the file, oldest first. */
  written: z.array(z.string()),
  /** Wall-clock time (ms) of the latest write to the file; recovery undoes writes newest first across journals. */
  at: z.number().optional(),
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
  /** fsyncs a directory and rejects when that fails or the file system cannot do it. */
  readonly syncDir: (dir: string) => Promise<void>;
  /** Deletes a finalized transaction directory. */
  readonly removeDir: (dir: string) => Promise<void>;
}

const defaultIo: JournalIo = {
  syncDir: syncDirStrict,
  removeDir: (dir) => fs.rm(dir, { recursive: true, force: true }),
};

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
  /** Original bytes, kept in memory for the in-process rollback. */
  readonly bytes: Buffer | null;
  /** Hash of what this transaction last wrote, or null after a failed write. */
  last: string | null;
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
  /** Directories this transaction's writes really created; only those are removed by the in-process rollback. */
  readonly #ownDirs = new Set<string>();
  /** Workspace directories already shown to flush to disk. */
  readonly #flushable = new Set<string>();
  #bytes = 0;
  #created = false;
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
      const first = await fs.mkdir(root, { recursive: true, mode: 0o700 });
      await assertPrivateDir(root);
      // Each directory mkdir created must be durable in its parent, or a crash loses the record.
      let parent = path.dirname(root);
      await this.#io.syncDir(parent);
      while (first !== undefined && parent !== path.dirname(first)) {
        parent = path.dirname(parent);
        await this.#io.syncDir(parent);
      }
      await fs.mkdir(this.dir, { mode: 0o700 });
      this.#created = true;
      await this.#io.syncDir(root);
    }
    const next = path.join(this.dir, `${MANIFEST}.next`);
    await writeDurable(next, JSON.stringify(this.#manifest()));
    await fs.rename(next, path.join(this.dir, MANIFEST));
    await this.#io.syncDir(this.dir);
  }

  /**
   * Called by a commit after the stale check and before the write. Records
   * the original on the first write to `absPath` and the hash about to be
   * written. Throws when the journal is full or closed.
   */
  record(
    absPath: string,
    root: string,
    before: { readonly bytes: Buffer; readonly mode: number } | null,
    nextHash: string,
    createdDirs: readonly string[],
  ): Promise<void> {
    return this.#serial(async () => {
      if (this.#closed) throw new ToolError('tool-error', 'the transaction is already finished');
      // Finalization flushes this directory; where it cannot, the write is refused before the file changes.
      const dir = path.dirname(createdDirs[0] ?? absPath);
      if (!this.#flushable.has(dir)) {
        try {
          await this.#io.syncDir(dir);
        } catch (err) {
          throw new ToolError('tool-error', `refused to write ${absPath} in a transaction: ${errorMessage(err)}`);
        }
        this.#flushable.add(dir);
      }
      if (!this.#roots.includes(root)) this.#roots.push(root);
      const existing = this.#entries.get(absPath);
      if (existing) {
        // Another writer changed the file since this transaction last wrote it: restoring the
        // original later would discard that change, so the write is refused.
        const current = before ? sha256(before.bytes) : null;
        const ours = existing.last ?? (existing.entry.existed ? existing.entry.original : null);
        if (current !== ours) {
          throw new ToolError('stale', `${absPath} was changed by another writer since this transaction last wrote it`);
        }
        existing.entry.written.push(nextHash);
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
          written: [nextHash],
          at: writeTime(),
        },
        bytes: before?.bytes ?? null,
        last: null,
      });
      await this.#persist();
    });
  }

  /** Called after a successful write, with the directories it created. */
  written(absPath: string, hash: string, createdDirs: readonly string[] = []): void {
    const live = this.#entries.get(absPath);
    if (live) live.last = hash;
    for (const d of createdDirs) this.#ownDirs.add(d);
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
          const current = await currentContent(entry.path);
          const currentHash = current ? sha256(current.bytes) : null;
          const originalHash = entry.existed ? entry.original : null;
          if (currentHash === originalHash) continue;
          if (live.last === null || currentHash !== live.last) {
            skipped.push({ path: entry.path, reason: 'changed-externally', detail: 'the file no longer holds what this run wrote' });
            continue;
          }
          await restoreEntry(entry, live.bytes, currentHash);
          restored.push(entry.path);
        } catch (err) {
          skipped.push({ path: entry.path, reason: 'error', detail: errorMessage(err) });
        }
      }
      const ownDirs = this.#dirs.filter((d) => this.#ownDirs.has(d));
      await removeCreatedDirs(ownDirs, this.#roots);
      const durable = await syncExisting(touchedDirs(restored, ownDirs), this.#io.syncDir).then(
        () => true,
        () => false,
      );
      // A file whose restore failed or is not yet on disk keeps the record, so a recovery pass can still restore it.
      if (!durable || skipped.some((s) => s.reason === 'error')) await this.#flushRecord();
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
        // The changes must be on disk before the journal stops protecting them.
        await syncExisting(touchedDirs([...this.#entries.keys()], this.#dirs), this.#io.syncDir);
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

/**
 * Content at `abs`, read only through real directories: null when the file
 * (or its directory) is gone; `stale` when its directory now resolves
 * elsewhere (a link was swapped in), so nothing outside is read or touched.
 */
async function currentContent(abs: string): Promise<RegularFile | null> {
  const parent = await fs.lstat(path.dirname(abs)).catch(() => null);
  if (!parent) return null;
  await assertDirUnchanged(path.dirname(abs));
  return readRegularFile(abs);
}

async function restoreEntry(entry: Entry, bytes: Buffer | null, currentHash: string | null): Promise<void> {
  if (isInsideGitDir(entry.path)) throw new ToolError('protected-path', 'inside a .git directory');
  if (!entry.existed) {
    if (currentHash !== null) await removeRegularFile(entry.path, currentHash);
    return;
  }
  if (bytes === null || sha256(bytes) !== entry.original) throw new ToolError('tool-error', 'the saved original is damaged');
  const expect = currentHash === null ? ({ kind: 'absent' } as const) : ({ kind: 'hash', sha256: currentHash } as const);
  await atomicWrite(entry.path, bytes, expect, entry.mode !== null ? { mode: entry.mode } : {});
}

/** Directories whose entries changed: the directory of each file and the parent of each created directory. */
function touchedDirs(files: readonly string[], createdDirs: readonly string[]): string[] {
  return [...new Set([...files, ...createdDirs].map((p) => path.dirname(p)))];
}

/** fsyncs each directory; one that is gone holds none of the changes, so it is skipped. */
async function syncExisting(dirs: readonly string[], sync: (dir: string) => Promise<void>): Promise<void> {
  for (const dir of dirs) {
    try {
      await sync(dir);
    } catch (err) {
      const code = errnoCode(err);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
    }
  }
}

/** Removes created directories that are empty, real and strictly inside `roots`, deepest first. */
async function removeCreatedDirs(dirs: readonly string[], roots: readonly string[]): Promise<void> {
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) await removeEmptyDirInside(d, roots);
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

/** What a recovery pass did for one stale journal. */
export interface RecoveredJournal {
  readonly id: string;
  readonly report: RollbackReport;
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
}

async function undoEntry(record: Claimed, entry: Entry, roots: readonly string[], protectedPaths: readonly string[]): Promise<void> {
  const { manifest, dir, restored, skipped } = record;
  try {
    // The record is data on disk: each path is checked like a tool argument.
    if (!path.isAbsolute(entry.path) || !roots.some((root) => isInsideDir(root, entry.path))) {
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
    const current = await currentContent(entry.path);
    const currentHash = current ? sha256(current.bytes) : null;
    const originalHash = entry.existed ? entry.original : null;
    if (currentHash === originalHash) return;
    if (currentHash === null || !entry.written.includes(currentHash)) {
      skipped.push({ path: entry.path, reason: 'changed-externally', detail: 'the file no longer holds what the crashed run wrote' });
      return;
    }
    const bytes = await readOriginal(dir, entry);
    await restoreEntry(entry, bytes, currentHash);
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
  // A finalized run is never undone, whatever its directory still holds; it is only deleted.
  for (const name of names.filter(isCommitted)) {
    if (!TXID.test(name.slice(0, -COMMITTED.length))) continue;
    const dir = path.join(base, name);
    const st = await fs.lstat(dir).catch(() => null);
    if (st?.isDirectory()) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
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
      claimed.push({ id: record.id, dir: target, manifest, restored: [], skipped: [] });
    } catch {
      // One bad record must not stop the others.
    }
  }
  const writes = claimed
    .flatMap((record) => record.manifest.entries.map((entry) => ({ record, entry })))
    .sort((a, b) => (b.entry.at ?? b.record.manifest.startedAt) - (a.entry.at ?? a.record.manifest.startedAt));
  for (const { record, entry } of writes) await undoEntry(record, entry, realRoots, patterns);
  const out: RecoveredJournal[] = [];
  for (const record of claimed) {
    try {
      // The journal contains planned directory names and cannot establish ownership after a crash.
      // A file that could not be handled or whose restore is not yet on disk keeps the record for a later pass.
      const durable = await syncExisting(touchedDirs(record.restored, []), syncDirStrict).then(
        () => true,
        () => false,
      );
      if (durable && !record.skipped.some((s) => s.reason === 'error')) await fs.rm(record.dir, { recursive: true, force: true });
      out.push({ id: record.id, report: { restored: record.restored, skipped: record.skipped } });
    } catch {
      // One bad record must not stop the others.
    }
  }
  return out;
}
