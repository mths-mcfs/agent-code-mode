import { randomBytes } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ToolError, errorMessage } from '../core/errors.js';
import { MAX_ARG_CHARS } from '../core/schemas.js';
import type { CommittedFile, DirIdentity, FileFingerprint, RunUndo, UndoCapture, UndoOutcome, UndoSession, UndoSkip, UndoStep } from '../core/types.js';
import { shellQuote } from './bash.js';
import { type PathIdentity, atomicWrite, captureIdentity, fingerprintOf, isBinary, readRegularFile, removeEmptyDirInside, removeRegularFile, sameFingerprint, sha256, writePrivate } from './fs-ops.js';
import { releaseFile, reserveFile } from './journal.js';
import type { Jail } from './jail.js';
import type { SessionDirs } from './session-dirs.js';

/**
 * What `undo(undoId)` needs: the bytes each finished run replaced. Kept apart
 * from the crash journal (`<stateDir>/journal`), so crash recovery can never
 * restore a run that finished. The index lives in this process's memory; the
 * files under `<stateDir>/undo/<process id>/<undoId>/` go with it.
 */

/** Finished runs that can still be undone. */
export const MAX_UNDO_RUNS = 10;
/** Most bytes of originals one run keeps; above it the run gets no `undoId`. */
export const MAX_RUN_UNDO_BYTES = 64 * 1024 * 1024;
/** Most bytes of originals this process keeps; the oldest finished runs go first. */
export const MAX_TOTAL_UNDO_BYTES = 256 * 1024 * 1024;

interface FileRecord {
  readonly absPath: string;
  readonly root: string;
  readonly existed: boolean;
  /** SHA-256 of the original bytes ('' when the run created the file). */
  readonly original: string;
  readonly mode: number | null;
  /** The file the run found at the path; null when the run created it. */
  readonly before: FileFingerprint | null;
  blob: string | null;
  /** What the run's last committed write left; null until one lands. */
  committed: CommittedFile | null;
}

interface FinishedRun {
  readonly id: string;
  readonly dir: string;
  readonly files: readonly FileRecord[];
  /** Directories the run created, with the identity each had then. */
  readonly dirs: ReadonlyMap<string, DirIdentity>;
  readonly bytes: number;
  readonly bashCalls: number;
  readonly mcpCalls: number;
  busy: boolean;
}

/** One authorized change and what must still hold when it is made. */
interface Planned {
  readonly committed: CommittedFile;
  readonly identity: PathIdentity;
  readonly bytes?: Buffer;
  readonly mode?: number;
  /** The file the undone run found: what the restore brings back. */
  readonly before?: FileFingerprint;
}

export interface UndoStoreOptions {
  /** Removes a directory of saved originals (tests). */
  readonly removeDir?: (dir: string) => Promise<void>;
}

export class UndoStore {
  readonly #dirs: SessionDirs;
  readonly #removeDir: (dir: string) => Promise<void>;
  readonly #finished = new Map<string, FinishedRun>();
  readonly #recording = new Set<RunRecorder>();
  /** Removals in progress and the bytes each still holds on disk. */
  readonly #draining = new Map<Promise<void>, number>();

  constructor(dirs: SessionDirs, opts: UndoStoreOptions = {}) {
    this.#dirs = dirs;
    this.#removeDir = opts.removeDir ?? ((dir) => fs.rm(dir, { recursive: true, force: true }));
  }

  begin(): RunUndo {
    const recorder = new RunRecorder(this);
    this.#recording.add(recorder);
    return recorder;
  }

  /** Bytes of the runs kept or in progress, without those already being removed. */
  #held(): number {
    let held = 0;
    for (const run of this.#finished.values()) held += run.bytes;
    for (const recorder of this.#recording) held += recorder.bytes;
    return held;
  }

  /**
   * Reserves `size` bytes for `recorder` before anything is written, dropping
   * the oldest finished runs and waiting until their files are gone from disk.
   * False when runs in progress hold all the room.
   */
  async reserve(recorder: RunRecorder, size: number): Promise<boolean> {
    for (;;) {
      const held = this.#held();
      if (held + size > MAX_TOTAL_UNDO_BYTES) {
        const oldest = [...this.#finished.values()].find((run) => !run.busy);
        if (oldest === undefined) return false;
        this.#drop(oldest);
        continue;
      }
      let leaving = 0;
      for (const bytes of this.#draining.values()) leaving += bytes;
      if (held + leaving + size <= MAX_TOTAL_UNDO_BYTES) {
        recorder.bytes += size;
        return true;
      }
      await Promise.race(this.#draining.keys());
    }
  }

  async runDir(id: string): Promise<string> {
    const dir = path.join(await this.#dirs.undo(), id);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  stopRecording(recorder: RunRecorder): void {
    this.#recording.delete(recorder);
  }

  /** Removes saved originals; their bytes count against the total until they are gone. */
  drain(dir: string, bytes: number): void {
    const removal: Promise<void> = this.#removeDir(dir)
      .catch(() => undefined)
      .finally(() => void this.#draining.delete(removal));
    this.#draining.set(removal, bytes);
  }

  /** Files a finished run. False when it cannot be kept: every run held is being undone right now. */
  add(run: FinishedRun): boolean {
    while (this.#finished.size >= MAX_UNDO_RUNS) {
      const oldest = [...this.#finished.values()].find((held) => !held.busy);
      if (oldest === undefined) return false;
      this.#drop(oldest);
    }
    this.#finished.set(run.id, run);
    return true;
  }

  #drop(run: FinishedRun): void {
    this.#finished.delete(run.id);
    this.drain(run.dir, run.bytes);
  }

  /**
   * A restore put the file `was` back as a new inode `now`. An earlier run that
   * left `was` must still recognize it, or undoing runs newest first would stop
   * at the first one.
   */
  #restored(absPath: string, was: FileFingerprint, now: FileFingerprint): void {
    for (const run of this.#finished.values()) {
      for (const file of run.files) {
        if (file.absPath === absPath && file.committed !== null && sameFingerprint(file.committed, was)) file.committed = { ...file.committed, ...now };
      }
    }
  }

  /** Plans the undo of a finished run and reserves its files; nothing changes yet. */
  async open(undoId: string, jail: Jail): Promise<UndoSession> {
    const run = this.#finished.get(undoId);
    if (run === undefined) {
      throw new ToolError('not-found', `undo: unknown undoId ${JSON.stringify(undoId.slice(0, 64))} (it was already used, is too old, or comes from another server process)`);
    }
    if (run.busy) throw new ToolError('tool-error', `undo: ${undoId} is already being undone`);
    run.busy = true;
    const session = new Session(
      run,
      jail,
      (used) => {
        run.busy = false;
        if (used) this.#drop(run);
      },
      (absPath, was, now) => this.#restored(absPath, was, now),
    );
    try {
      await session.plan();
    } catch (err) {
      await session.close(false);
      throw err;
    }
    return session;
  }
}

class RunRecorder implements RunUndo {
  readonly #store: UndoStore;
  readonly #id = `undo_${randomBytes(16).toString('base64url')}`;
  readonly #files = new Map<string, FileRecord>();
  readonly #dirs = new Map<string, DirIdentity>();
  #dir: string | undefined;
  #lost: string | undefined;
  #ended = false;
  #blobs = 0;
  bytes = 0;

  constructor(store: UndoStore) {
    this.#store = store;
  }

  async capture(file: UndoCapture): Promise<void> {
    if (this.#ended) return;
    // A first write that never landed proves nothing about the original: the file may have changed since.
    const known = this.#files.get(file.absPath);
    if (known !== undefined && known.committed !== null) return;
    const { before } = file;
    const record: FileRecord = {
      absPath: file.absPath,
      root: file.root,
      existed: before !== null,
      original: before === null ? '' : sha256(before.bytes),
      mode: before?.mode ?? null,
      before: before?.fingerprint ?? null,
      blob: null,
      committed: null,
    };
    this.#files.set(file.absPath, record);
    if (before === null || this.#lost !== undefined) return;
    const size = before.bytes.length;
    if (this.bytes + size > MAX_RUN_UNDO_BYTES) {
      this.#lose(`the files it replaced are larger than the ${MAX_RUN_UNDO_BYTES}-byte limit of one run`);
      return;
    }
    if (!(await this.#store.reserve(this, size))) {
      this.#lose(`other runs in progress hold the ${MAX_TOTAL_UNDO_BYTES} bytes this server keeps`);
      return;
    }
    try {
      this.#dir ??= await this.#store.runDir(this.#id);
      const blob = `${++this.#blobs}.bin`;
      await writePrivate(path.join(this.#dir, blob), before.bytes);
      record.blob = blob;
    } catch (err) {
      this.#lose(`saving the original of ${file.absPath} failed: ${errorMessage(err)}`);
    }
  }

  dirCreated(dir: string, identity: DirIdentity): void {
    if (!this.#ended) this.#dirs.set(dir, identity);
  }

  #lose(why: string): void {
    this.#lost ??= why;
    this.#release();
  }

  #release(): void {
    const dir = this.#dir;
    this.#dir = undefined;
    if (dir !== undefined) this.#store.drain(dir, this.bytes);
    this.bytes = 0;
  }

  committed(absPath: string, file: CommittedFile): void {
    const record = this.#files.get(absPath);
    if (record !== undefined) record.committed = file;
  }

  async finish(stats: { readonly bashCalls: number; readonly mcpCalls: number }): Promise<UndoOutcome> {
    this.#ended = true;
    const files = [...this.#files.values()].filter((f) => f.committed !== null);
    if (files.length === 0 && this.#dirs.size === 0) {
      this.#release();
      this.#store.stopRecording(this);
      return {};
    }
    if (this.#lost !== undefined) {
      this.#release();
      this.#store.stopRecording(this);
      return { warning: `this run cannot be undone: ${this.#lost}.` };
    }
    // A run that only created files saved nothing, but its directory is still where `open` looks.
    const dir = this.#dir ?? (await this.#store.runDir(this.#id));
    const kept = this.#store.add({ id: this.#id, dir, files, dirs: this.#dirs, bytes: this.bytes, bashCalls: stats.bashCalls, mcpCalls: stats.mcpCalls, busy: false });
    this.#dir = dir;
    if (!kept) {
      this.#release();
      this.#store.stopRecording(this);
      return { warning: `this run cannot be undone: the ${MAX_UNDO_RUNS} runs this server keeps are all being undone right now.` };
    }
    this.bytes = 0;
    this.#store.stopRecording(this);
    return { undoId: this.#id };
  }

  async discard(): Promise<void> {
    this.#ended = true;
    this.#release();
    this.#store.stopRecording(this);
  }
}

function dirIdentityMatches(st: BigIntStats, identity: DirIdentity): boolean {
  return st.isDirectory() && st.dev === identity.dev && st.ino === identity.ino;
}

class Session implements UndoSession {
  readonly steps: UndoStep[] = [];
  readonly skipped: UndoSkip[] = [];
  readonly bashCalls: number;
  readonly mcpCalls: number;
  readonly #run: FinishedRun;
  readonly #jail: Jail;
  readonly #done: (used: boolean) => void;
  readonly #onRestored: (absPath: string, was: FileFingerprint, now: FileFingerprint) => void;
  readonly #owner: string;
  readonly #reserved: string[] = [];
  readonly #planned = new Map<UndoStep, Planned>();
  #closed = false;

  constructor(run: FinishedRun, jail: Jail, done: (used: boolean) => void, onRestored: (absPath: string, was: FileFingerprint, now: FileFingerprint) => void) {
    this.#run = run;
    this.#jail = jail;
    this.#done = done;
    this.#onRestored = onRestored;
    this.#owner = `undo:${run.id}`;
    this.bashCalls = run.bashCalls;
    this.mcpCalls = run.mcpCalls;
  }

  #skip(p: string, reason: string): void {
    this.skipped.push({ path: p, reason });
  }

  /** Throws, with nothing changed and the `undoId` still valid, when a transaction in progress holds any of the files. */
  async plan(): Promise<void> {
    for (const file of this.#run.files) {
      if (!reserveFile(file.absPath, this.#owner)) {
        throw new ToolError('tool-error', `undo: a transaction or another undo in progress holds ${file.absPath}; nothing was changed, try again when it ends`);
      }
      this.#reserved.push(file.absPath);
    }
    const removing = new Set<string>();
    for (const file of [...this.#run.files].reverse()) {
      try {
        await this.#planFile(file, removing);
      } catch (err) {
        this.#skip(file.absPath, errorMessage(err));
      }
    }
    await this.#planDirs(removing);
  }

  async #planFile(file: FileRecord, removing: Set<string>): Promise<void> {
    const abs = file.absPath;
    const committed = file.committed;
    if (committed === null) return;
    // The path is judged again now: it must still lead to itself, inside today's roots, and be writable.
    if ((await this.#jail.resolveForWrite(abs)) !== abs) return this.#skip(abs, 'the path now leads somewhere else');
    const identity = await captureIdentity(abs, this.#jail.rootOf(abs) ?? file.root);
    const current = await readRegularFile(abs);
    if (current === null) return this.#skip(abs, 'the file no longer exists');
    // The same bytes are not enough: another file, a later write of equal content or a new mode is a change too.
    const now: FileFingerprint | null = await fingerprintOf(abs);
    if (sha256(current.bytes) !== committed.sha256 || now === null || !sameFingerprint(now, committed)) return this.#skip(abs, 'the file changed after the run');
    if (!file.existed) {
      const step: UndoStep = { kind: 'remove', path: abs, call: { tool: 'bash', args: { command: `rm -- ${shellQuote(abs)}` } } };
      this.steps.push(step);
      this.#planned.set(step, { committed, identity });
      removing.add(abs);
      return;
    }
    const bytes = file.blob === null ? null : await fs.readFile(path.join(this.#run.dir, file.blob));
    if (bytes === null || sha256(bytes) !== file.original) return this.#skip(abs, 'the saved original is damaged');
    const content = bytes.toString('utf8');
    if (isBinary(bytes) || !Buffer.from(content, 'utf8').equals(bytes)) return this.#skip(abs, 'the original is binary, which cannot be shown to the host as a write');
    if (content.length > MAX_ARG_CHARS) return this.#skip(abs, 'the original is too large to show to the host as a write');
    const step: UndoStep = { kind: 'restore', path: abs, call: { tool: 'write', args: { path: abs, content } } };
    this.steps.push(step);
    this.#planned.set(step, { committed, identity, bytes, ...(file.mode === null ? {} : { mode: file.mode }), ...(file.before === null ? {} : { before: file.before }) });
  }

  /** The directories the run created that are still the same ones and hold nothing but what this undo removes, deepest first. */
  async #planDirs(removing: Set<string>): Promise<void> {
    const dirs = [...this.#run.dirs.keys()].sort((a, b) => b.length - a.length);
    for (const dir of dirs) {
      const st = await fs.lstat(dir, { bigint: true }).catch(() => null);
      if (st === null) continue;
      const identity = this.#run.dirs.get(dir);
      try {
        const root = this.#jail.rootOf(dir);
        if (identity === undefined || !dirIdentityMatches(st, identity) || root === undefined || root === dir || (await this.#jail.resolveForWrite(dir)) !== dir) {
          this.#skip(dir, 'the directory is not the one the run created');
          continue;
        }
        const entries = await fs.readdir(dir);
        if (!entries.every((name) => removing.has(path.join(dir, name)))) {
          this.#skip(dir, 'the directory is not empty');
          continue;
        }
        removing.add(dir);
        this.steps.push({ kind: 'rmdir', path: dir, call: { tool: 'bash', args: { command: `rmdir -- ${shellQuote(dir)}` } } });
      } catch (err) {
        this.#skip(dir, errorMessage(err));
      }
    }
  }

  async apply(step: UndoStep, signal: AbortSignal): Promise<void> {
    if (step.kind === 'rmdir') {
      if (!(await removeEmptyDirInside(step.path, this.#jail.roots, this.#run.dirs.get(step.path)))) throw new ToolError('stale', 'the directory is not the empty one the run created');
      return;
    }
    const planned = this.#planned.get(step);
    if (planned === undefined) throw new ToolError('tool-error', 'this undo step was not planned');
    const { committed, identity } = planned;
    if (step.kind === 'remove') return removeRegularFile(step.path, committed.sha256, identity, committed);
    if (planned.bytes === undefined) throw new ToolError('tool-error', 'this undo step has no saved original');
    const { written } = await atomicWrite(step.path, planned.bytes, { kind: 'hash', sha256: committed.sha256 }, { signal, identity, fingerprint: committed, ...(planned.mode === undefined ? {} : { mode: planned.mode }) });
    if (planned.before !== undefined) this.#onRestored(step.path, planned.before, written);
  }

  async close(used: boolean): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const p of this.#reserved) releaseFile(p, this.#owner);
    this.#done(used);
  }
}
