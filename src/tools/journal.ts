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
import { ToolError, errorMessage } from '../core/errors.js';
import { recordOwnDir, recordOwnFile, recordOwnWrite } from '../core/own-writes.js';
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
  writeDurable,
} from './fs-ops.js';
import { isInsideDir, isInsideGitDir } from './jail.js';

/** Above this many bytes of originals a transaction refuses further writes. */
export const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
/** Slack when comparing a start time with the boot time. */
const BOOT_SLACK_MS = 10_000;
const MANIFEST = 'manifest.json';
const RECOVERING = '.recovering-';

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
  /** Real paths of every root the run was allowed to touch (session cwd, client roots, host additional directories). Recovery restores only inside these. */
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

/** Ids of transactions this process still has open; a recovery pass leaves them alone. */
const openTransactions = new Set<string>();

/**
 * Which open transaction journaled each file. A transaction may not write a
 * file another open transaction holds: rolling back two overlapping
 * snapshots of the same file would restore the wrong original.
 */
const fileOwners = new Map<string, string>();

/**
 * Claims `absPath` for `owner` (an undo in progress). False when an open
 * transaction or another undo holds it. While claimed, a transaction refuses
 * to journal the file.
 */
export function reserveFile(absPath: string, owner: string): boolean {
  const current = fileOwners.get(absPath);
  if (current !== undefined && current !== owner) return false;
  fileOwners.set(absPath, owner);
  return true;
}

/** Gives up a claim made with `reserveFile`. */
export function releaseFile(absPath: string, owner: string): void {
  if (fileOwners.get(absPath) === owner) fileOwners.delete(absPath);
}

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

  constructor(stateDir: string) {
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
    // Every change here is recorded as agent-code-mode's own, so the protected-path watch does not report it.
    if (!this.#created) {
      await fs.mkdir(path.dirname(this.dir), { recursive: true, mode: 0o700 });
      await recordOwnDir(path.dirname(this.dir));
      await fs.mkdir(this.dir, { mode: 0o700 });
      await recordOwnDir(this.dir);
      this.#created = true;
    }
    const next = path.join(this.dir, `${MANIFEST}.next`);
    const text = JSON.stringify(this.#manifest());
    await writeDurable(next, text);
    await fs.rename(next, path.join(this.dir, MANIFEST));
    recordOwnWrite(next, { kind: 'absent' });
    await recordOwnFile(path.join(this.dir, MANIFEST), sha256(text));
    await syncDir(this.dir);
  }

  /**
   * Called by a commit after the stale check and before the write. Records
   * the original on the first write to `absPath` and the hash about to be
   * written. `runRoots` are the real roots of the whole run (the root that
   * holds `absPath` among them): crash recovery restores only inside them.
   * Throws when the journal is full or closed.
   */
  record(
    absPath: string,
    root: string,
    before: { readonly bytes: Buffer; readonly mode: number } | null,
    nextHash: string,
    createdDirs: readonly string[],
    runRoots: readonly string[] = [],
  ): Promise<void> {
    return this.#serial(async () => {
      if (this.#closed) throw new ToolError('tool-error', 'the transaction is already finished');
      for (const r of [root, ...runRoots]) if (!this.#roots.includes(r)) this.#roots.push(r);
      const existing = this.#entries.get(absPath);
      if (existing) {
        existing.entry.written.push(nextHash);
        await this.#persist();
        return;
      }
      const owner = fileOwners.get(absPath);
      if (owner !== undefined && owner !== this.id) {
        throw new ToolError(
          'tool-error',
          `${absPath} is being changed by another transactional run that has not finished; the write was refused so both runs can still roll back. Retry after that run ends.`,
        );
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
        await recordOwnFile(path.join(this.dir, blob), sha256(before.bytes));
      }
      this.#bytes += size;
      for (const d of createdDirs) if (!this.#dirs.includes(d)) this.#dirs.push(d);
      fileOwners.set(absPath, this.id);
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
      this.#releaseFiles();
      return { restored, skipped };
    });
  }

  dispose(): Promise<void> {
    return this.#serial(async () => {
      this.#closed = true;
      openTransactions.delete(this.id);
      await this.#removeRecord();
      this.#releaseFiles();
    });
  }

  #releaseFiles(): void {
    for (const p of this.#entries.keys()) if (fileOwners.get(p) === this.id) fileOwners.delete(p);
  }

  async #removeRecord(): Promise<void> {
    if (!this.#created) return;
    await fs.rm(this.dir, { recursive: true, force: true });
    recordOwnWrite(this.dir, { kind: 'tree-absent' });
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

export function isProcessAlive(pid: number): boolean {
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
  if (!isProcessAlive(manifest.pid)) return true;
  // A pid alone does not say: the system hands a dead process's id to a new one.
  const bootedAt = Date.now() - os.uptime() * 1000;
  return bootedAt > manifest.startedAt + BOOT_SLACK_MS;
}

/** What a recovery pass did for one stale journal. */
export interface RecoveredJournal {
  readonly id: string;
  readonly report: RollbackReport;
  /** True when some entry could not be restored (reason `error`): the journal is kept for a later pass. */
  readonly kept: boolean;
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

/**
 * The journal's own roots that still resolve to themselves. A root recorded
 * as a real path that now resolves elsewhere (replaced by a link, removed) is
 * dropped, so nothing is restored through it.
 */
async function trustedRoots(manifest: Manifest): Promise<string[]> {
  const out: string[] = [];
  for (const root of manifest.roots) {
    if (!path.isAbsolute(root)) continue;
    try {
      if ((await fs.realpath(root)) === root) out.push(root);
    } catch {
      // Gone: nothing to restore there.
    }
  }
  return out;
}

async function undoRecord(manifest: Manifest, dir: string): Promise<RollbackReport> {
  const restored: string[] = [];
  const skipped: { path: string; reason: 'changed-externally' | 'error'; detail?: string }[] = [];
  const roots = await trustedRoots(manifest);
  for (const entry of [...manifest.entries].reverse()) {
    try {
      // The record is data on disk: each path is checked like a tool argument,
      // against the roots of the run that wrote it.
      if (!path.isAbsolute(entry.path) || !roots.some((root) => isInsideDir(root, entry.path))) {
        skipped.push({ path: entry.path, reason: 'error', detail: 'outside the roots the journal was written for (or a root no longer resolves to itself); not touched' });
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
  await removeCreatedDirs(manifest.dirs, roots);
  return { restored, skipped };
}

/**
 * Restores every journal left by a server process that is gone and whose run
 * shared a root with `roots` (newest first, so two cut-off runs that changed
 * the same file unwind in order). Each journal is restored inside the roots
 * of its own run, recorded in it, never through a root that now resolves
 * elsewhere. Files are restored only when they still hold what that run
 * wrote; anything else is reported in `skipped`. A journal with an entry that
 * could not be restored (reason `error`) is kept for a later pass and marked
 * `kept`. Never throws.
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
        if (claimer !== process.pid && isProcessAlive(claimer)) continue;
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
      const report = await undoRecord(manifest, claimed);
      const kept = report.skipped.some((s) => s.reason === 'error');
      if (kept) await fs.rename(claimed, path.join(base, record.id));
      else await fs.rm(claimed, { recursive: true, force: true });
      out.push({ id: record.id, report, kept });
    } catch {
      // One bad record must not stop the others.
    }
  }
  return out;
}
