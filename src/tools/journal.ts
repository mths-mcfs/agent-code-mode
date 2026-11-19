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
  syncDir,
  syncDirStrict,
  writeDurable,
} from './fs-ops.js';
import { isInsideDir, isInsideGitDir } from './jail.js';

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
  /** fsyncs a directory and rejects when that fails. */
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

interface LiveEntry {
  readonly entry: Entry;
  /** Original bytes, kept in memory for the in-process rollback. */
  readonly bytes: Buffer | null;
  /** Hash of what this transaction last wrote, or null after a failed write. */
  last: string | null;
}

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
  #bytes = 0;
  #created = false;
  #closed = false;
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

  async #persist(): Promise<void> {
    if (!this.#created) {
      await fs.mkdir(path.dirname(this.dir), { recursive: true, mode: 0o700 });
      await fs.mkdir(this.dir, { mode: 0o700 });
      this.#created = true;
    }
    const next = path.join(this.dir, `${MANIFEST}.next`);
    await writeDurable(next, JSON.stringify(this.#manifest()));
    await fs.rename(next, path.join(this.dir, MANIFEST));
    await syncDir(this.dir);
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
      if (!this.#roots.includes(root)) this.#roots.push(root);
      const existing = this.#entries.get(absPath);
      if (existing) {
        existing.entry.written.push(nextHash);
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
        },
        bytes: before?.bytes ?? null,
        last: null,
      });
      await this.#persist();
    });
  }

  /** Called after a successful write. */
  written(absPath: string, hash: string): void {
    const live = this.#entries.get(absPath);
    if (live) live.last = hash;
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
      await removeCreatedDirs(this.#dirs, this.#roots);
      await this.#removeRecord();
      return { restored, skipped };
    });
  }

  /**
   * Commits the journal: renames its directory to `<id>.committed`, which
   * recovery never undoes, then fsyncs the journal root so the rename is
   * durable. The recursive delete of the renamed directory runs afterwards
   * and is not awaited. Rejects with `TransactionFinalizeError`: not
   * committed when the rename failed (the journal stays open for a
   * rollback), committed when only the fsync failed.
   */
  dispose(): Promise<void> {
    return this.#serial(async () => {
      if (this.#closed) return;
      if (!this.#created) {
        this.#closed = true;
        openTransactions.delete(this.id);
        return;
      }
      const committed = `${this.dir}${COMMITTED}`;
      try {
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
        throw new TransactionFinalizeError(
          true,
          `the transaction journal was finalized, but flushing it to disk failed (${errorMessage(err)}); the changes are on disk, but their durability is not guaranteed`,
        );
      } finally {
        void this.#io.removeDir(committed).catch(() => undefined);
      }
    });
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

async function undoRecord(manifest: Manifest, dir: string, roots: readonly string[]): Promise<RollbackReport> {
  const restored: string[] = [];
  const skipped: { path: string; reason: 'changed-externally' | 'error'; detail?: string }[] = [];
  for (const entry of [...manifest.entries].reverse()) {
    try {
      // The record is data on disk: each path is checked like a tool argument.
      if (!path.isAbsolute(entry.path) || !roots.some((root) => isInsideDir(root, entry.path))) {
        skipped.push({ path: entry.path, reason: 'error', detail: 'outside the workspace roots; not touched' });
        continue;
      }
      if (!manifest.roots.some((root) => isInsideDir(root, entry.path))) {
        skipped.push({ path: entry.path, reason: 'error', detail: 'outside the roots the journal was written for; not touched' });
        continue;
      }
      const current = await currentContent(entry.path);
      const currentHash = current ? sha256(current.bytes) : null;
      const originalHash = entry.existed ? entry.original : null;
      if (currentHash === originalHash) continue;
      if (currentHash === null || !entry.written.includes(currentHash)) {
        skipped.push({ path: entry.path, reason: 'changed-externally', detail: 'the file no longer holds what the crashed run wrote' });
        continue;
      }
      const bytes = await readOriginal(dir, entry);
      await restoreEntry(entry, bytes, currentHash);
      restored.push(entry.path);
    } catch (err) {
      skipped.push({ path: entry.path, reason: 'error', detail: errorMessage(err) });
    }
  }
  // Only directories inside both the given roots and the roots the journal was written for.
  const dirs = manifest.dirs.filter((d) => manifest.roots.some((root) => isInsideDir(root, d)));
  await removeCreatedDirs(dirs, roots);
  return { restored, skipped };
}

function isCommitted(name: string): boolean {
  return name.endsWith(COMMITTED);
}

/**
 * Restores every journal left by a server process that is gone and that
 * touched one of `roots` (newest first, so two cut-off runs that changed the
 * same file unwind in order). Files are restored only when they still hold
 * what that run wrote; anything else is reported in `skipped`. Never throws.
 */
export async function recoverStaleJournals(stateDir: string, roots: readonly string[]): Promise<RecoveredJournal[]> {
  const base = journalRoot(stateDir);
  let names: string[];
  try {
    names = await fs.readdir(base);
  } catch {
    return [];
  }
  const realRoots = await Promise.all(roots.filter((r) => path.isAbsolute(r)).map(realOrSelf));
  // A finalized run is never undone, whatever its directory still holds; it is only deleted.
  for (const name of names.filter(isCommitted)) {
    await fs.rm(path.join(base, name), { recursive: true, force: true }).catch(() => undefined);
  }
  // The id pattern below also rejects `<txid>.committed`, so a finalized run is never read as pending.
  const records = names
    .map((name) => ({ name, id: name.includes(RECOVERING) ? name.slice(0, name.indexOf(RECOVERING)) : name }))
    .filter((r) => /^[0-9a-z]+-\d+-[0-9a-f]+$/.test(r.id))
    .sort((a, b) => parseInt(b.id.split('-')[0] ?? '0', 36) - parseInt(a.id.split('-')[0] ?? '0', 36));
  const out: RecoveredJournal[] = [];
  for (const record of records) {
    const dir = path.join(base, record.name);
    try {
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
      const claimed = path.join(base, `${record.id}${RECOVERING}${process.pid}`);
      if (claimed !== dir) {
        try {
          await fs.rename(dir, claimed);
        } catch {
          continue;
        }
      }
      const report = await undoRecord(manifest, claimed, realRoots);
      await fs.rm(claimed, { recursive: true, force: true });
      out.push({ id: record.id, report });
    } catch {
      // One bad record must not stop the others.
    }
  }
  return out;
}
