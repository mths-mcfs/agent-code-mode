import { createHash } from 'node:crypto';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { ToolError, errorMessage } from '../core/errors.js';
import { findMatchingPattern, isUncPath, normalizeDrivePath, normalizeSeparators, pathPatternRegExp } from '../core/paths.js';
import { MAX_ARG_CHARS } from '../core/schemas.js';
import type {
  BashEffect,
  BashResult,
  BashShell,
  PolicySnapshot,
  PreparedCall,
  RollbackReport,
  SessionContext,
  ToolCall,
  ToolResult,
  ToolRuntime,
  Transaction,
} from '../core/types.js';

const posix = path.posix;

/** SHA-256 hex of a string. */
export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Lines one prepared diff may cover, before and after together. */
export const MAX_DIFF_LINES = 200_000;
/** Replacements one prepared edit may make. */
export const MAX_EDIT_REPLACEMENTS = 50_000;

/** Where the non-overlapping literal occurrences of a needle sit in a text. */
interface Matches {
  /** Occurrences found, at most the scan limit. */
  readonly count: number;
  /** Start of the first occurrence, or -1. */
  readonly first: number;
  /** End of the last occurrence found. */
  readonly lastEnd: number;
  /** Start of the run of back-to-back occurrences that ends with the last one. */
  readonly lastRunStart: number;
}

/**
 * Scans the non-overlapping literal occurrences of `needle` (not empty) in
 * `text`, stopping after `limit`, without building arrays.
 */
function scanMatches(text: string, needle: string, limit: number): Matches {
  let count = 0;
  let first = -1;
  let lastEnd = -1;
  let lastRunStart = -1;
  for (let at = text.indexOf(needle); at !== -1 && count < limit; at = text.indexOf(needle, at + needle.length)) {
    if (count === 0) first = at;
    if (at !== lastEnd) lastRunStart = at;
    lastEnd = at + needle.length;
    count++;
  }
  return { count, first, lastEnd, lastRunStart };
}

/** Line breaks in `text`, counting at most one more than `MAX_DIFF_LINES`. */
const countNewlines = (text: string): number => scanMatches(text, '\n', MAX_DIFF_LINES + 1).count;

/** Diff rows of a text from its length, line breaks and whether it ends with one, as `simpleDiff` counts them. */
const diffRows = (length: number, newlines: number, endsWithNewline: boolean): number =>
  length === 0 ? 0 : endsWithNewline ? newlines : newlines + 1;

/** Refuses a diff over `MAX_DIFF_LINES` before any of it is built. */
function checkDiffLines(lines: number): void {
  if (lines > MAX_DIFF_LINES) {
    throw new ToolError('invalid-args', `the change would diff more than ${MAX_DIFF_LINES} lines; split it into smaller changes`);
  }
}

/**
 * Minimal whole-file unified diff, good enough for tests. Builds no per-line
 * arrays and refuses, before building anything, a diff over `MAX_DIFF_LINES`.
 */
export function simpleDiff(file: string, before: string | null, after: string): string {
  const rows = (content: string): number => diffRows(content.length, countNewlines(content), content.endsWith('\n'));
  const rowsBefore = rows(before ?? '');
  checkDiffLines(rowsBefore);
  const rowsAfter = rows(after);
  checkDiffLines(rowsBefore + rowsAfter);
  const side = (prefix: string, content: string): string => {
    if (content === '') return '';
    const newline = content.endsWith('\n');
    const body = newline ? content.slice(0, -1) : content;
    return `${prefix}${body.replaceAll('\n', `\n${prefix}`)}\n${newline ? '' : '\\ No newline at end of file\n'}`;
  };
  const head = `--- ${before === null ? '/dev/null' : `a${file}`}\n+++ b${file}\n@@ -${rowsBefore > 0 ? 1 : 0},${rowsBefore} +${rowsAfter > 0 ? 1 : 0},${rowsAfter} @@\n`;
  return head + side('-', before ?? '') + side('+', after);
}

export interface MemoryToolRuntimeOptions {
  /**
   * Absolute POSIX root that every path must stay inside, e.g. `/ws`. Without
   * it, paths must stay inside the session cwd or one of its roots.
   */
  readonly root?: string;
  readonly recordCalls?: boolean;
  /** Initial files, keyed by path relative to `root` or absolute. */
  readonly files?: Readonly<Record<string, string>>;
  /** Random delay up to this many ms inside prepare and commit, to shake out ordering bugs. */
  readonly jitterMs?: number;
  /** Fixed delay inside every mutating commit. */
  readonly commitDelayMs?: number;
  /** When false, a mutating commit ignores abort during `commitDelayMs` and applies its effect anyway. Default true. */
  readonly honorAbortInCommit?: boolean;
  /** Shell reported in bash effects. Defaults to `/bin/bash -c`. */
  readonly shell?: BashShell;
  /** Result of a committed bash call. Defaults to stdout `fake: <command>`. */
  readonly bashResult?: (effect: BashEffect) => BashResult;
}

export const MEMORY_BASH_SHELL: BashShell = { path: '/bin/bash', args: ['-c'] };

/** One committed call, for assertions. */
export interface CommitRecord {
  readonly id: string;
  readonly tool: ToolCall['tool'];
  readonly target: string;
}

interface JournalEntry {
  readonly original: string | null;
  readonly originalRevision: number;
  /** Revision of the file this transaction last wrote. */
  revision: number;
}

/**
 * Runs a grep or glob job in a worker thread, so a costly user pattern never
 * blocks the server and can be stopped. The worker first filters the file
 * names; a grep then asks for the content of the kept files only.
 */
const SEARCH_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { names, lines, maxResults, files } = workerData;
const nameRe = names === null ? null : new RegExp(names.source, names.flags);
const keep = [];
for (let i = 0; i < files.length; i++) {
  if (nameRe !== null && !files[i][1].some((name) => nameRe.test(name))) continue;
  keep.push(i);
  if (lines === null && keep.length > maxResults) break;
}
if (lines === null) {
  const truncated = keep.length > maxResults;
  parentPort.postMessage({ files: keep.slice(0, maxResults).map((i) => files[i][0]), truncated });
} else {
  const lineRe = new RegExp(lines.source, lines.flags);
  parentPort.once('message', (contents) => {
    const found = [];
    let truncated = false;
    scan: for (let k = 0; k < keep.length; k++) {
      const rows = contents[k].split('\\n');
      for (let i = 0; i < rows.length; i++) {
        if (!lineRe.test(rows[i])) continue;
        if (found.length >= maxResults) {
          truncated = true;
          break scan;
        }
        found.push({ file: files[keep[k]][0], line: i + 1, text: rows[i] });
      }
    }
    parentPort.postMessage({ matches: found, truncated });
  });
  parentPort.postMessage({ keep });
}
`;

/** Searches that may run at once per runtime; more wait for a free slot. */
const MAX_CONCURRENT_SEARCHES = 4;
/** Characters of names and content one search may copy to its worker. */
const MAX_SEARCH_CHARS = MAX_ARG_CHARS;

const KeepReplySchema = z.object({ keep: z.array(z.number().int().nonnegative()) });

const GrepReplySchema = z.object({
  matches: z.array(z.object({ file: z.string(), line: z.number(), text: z.string() })),
  truncated: z.boolean(),
});
const GlobReplySchema = z.object({ files: z.array(z.string()), truncated: z.boolean() });

interface SearchJob {
  readonly names: { readonly source: string; readonly flags: string } | null;
  readonly lines: { readonly source: string; readonly flags: string } | null;
  readonly maxResults: number;
  /** `[absolute path, names the name pattern is tried on]`, sorted. */
  readonly files: readonly (readonly [string, readonly string[]])[];
}

const tooLarge = (): ToolError =>
  new ToolError('tool-error', `the search covers more than ${MAX_SEARCH_CHARS} characters; narrow its path or glob`);

/**
 * Runs `job` in a worker. `contents` lines up with `job.files` for a grep and
 * is null for a glob. `onExit` runs once, after the worker has stopped (or at
 * once when no worker starts), so its slot is reused only then.
 */
function searchInWorker<T>(
  job: SearchJob,
  contents: readonly string[] | null,
  budget: number,
  schema: z.ZodType<T>,
  signal: AbortSignal,
  onExit: () => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(SEARCH_WORKER, { eval: true, workerData: job });
    } catch (err) {
      onExit();
      return reject(new ToolError('tool-error', `the search failed: ${errorMessage(err)}`));
    }
    worker.once('exit', onExit);
    let sentContents = false;
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      void worker.terminate().catch(() => undefined);
      settle();
    };
    const fail = (err: ToolError): void => finish(() => reject(err));
    const onAbort = (): void => fail(new ToolError('cancelled', 'the search was stopped'));
    signal.addEventListener('abort', onAbort, { once: true });
    worker.on('message', (message: unknown) => {
      if (settled) return;
      if (contents !== null && !sentContents) {
        sentContents = true;
        const want = KeepReplySchema.safeParse(message);
        if (!want.success) return fail(new ToolError('tool-error', 'the search returned an invalid reply'));
        const kept: string[] = [];
        let size = budget;
        for (const i of want.data.keep) {
          const content = contents[i];
          if (content === undefined) return fail(new ToolError('tool-error', 'the search returned an invalid reply'));
          size += content.length;
          if (size > MAX_SEARCH_CHARS) return fail(tooLarge());
          kept.push(content);
        }
        try {
          worker.postMessage(kept);
        } catch (err) {
          fail(new ToolError('tool-error', `the search failed: ${errorMessage(err)}`));
        }
        return;
      }
      const reply = schema.safeParse(message);
      finish(() => (reply.success ? resolve(reply.data) : reject(new ToolError('tool-error', 'the search returned an invalid reply'))));
    });
    worker.once('error', (err) => fail(new ToolError('tool-error', `the search failed: ${err.message}`)));
    worker.once('exit', (code) => fail(new ToolError('tool-error', `the search stopped with exit code ${code}`)));
  });
}

const regExpSource = (re: RegExp): { source: string; flags: string } => ({ source: re.source, flags: re.flags });

/**
 * Whether the edited text ends with a line break, read from where the
 * replaced occurrences sit instead of from the text, which does not exist yet.
 * The character before a replaced run is never itself replaced.
 */
function editEndsWithNewline(before: string, matches: Matches, replaceAll: boolean, oldString: string, newString: string): boolean {
  const replacedEnd = replaceAll ? matches.lastEnd : matches.first + oldString.length;
  if (replacedEnd !== before.length) return before.endsWith('\n');
  if (newString !== '') return newString.endsWith('\n');
  return before[(replaceAll ? matches.lastRunStart : matches.first) - 1] === '\n';
}

/**
 * Returns `p`, or refuses a network-share (UNC) path: POSIX resolution folds
 * its leading `//` while protected-path patterns keep it, so the two would
 * name the same share differently.
 */
function refuseUnc(p: string): string {
  if (isUncPath(p)) throw new ToolError('outside-workspace', `${p} is a network share path, which is not supported`);
  return p;
}

function isInside(abs: string, root: string): boolean {
  const rel = posix.relative(root, abs);
  return rel !== '..' && !rel.startsWith('../') && !posix.isAbsolute(rel);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ms <= 0) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new ToolError('cancelled', 'aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

class MemoryTransaction implements Transaction {
  readonly journal = new Map<string, JournalEntry>();
  disposed = false;

  constructor(private readonly runtime: MemoryToolRuntime) {}

  record(absPath: string, before: string | null, originalRevision: number, revision: number): void {
    if (this.disposed) return;
    const entry = this.journal.get(absPath);
    if (entry) entry.revision = revision;
    else this.journal.set(absPath, { original: before, originalRevision, revision });
  }

  async rollback(): Promise<RollbackReport> {
    const report = await this.undo();
    this.journal.clear();
    return report;
  }

  async undo(accept: (absPath: string) => boolean = () => true): Promise<RollbackReport> {
    const restored: string[] = [];
    const skipped: { path: string; reason: 'changed-externally' }[] = [];
    for (const [absPath, entry] of [...this.journal.entries()].reverse()) {
      if (!accept(absPath)) continue;
      // A later write by anyone else, even of the same text, has another revision.
      if (this.runtime.revision(absPath) !== entry.revision) {
        skipped.push({ path: absPath, reason: 'changed-externally' });
        continue;
      }
      this.runtime.setFile(absPath, entry.original, entry.originalRevision);
      this.journal.delete(absPath);
      restored.push(absPath);
    }
    return { restored, skipped };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.journal.clear();
  }
}

/**
 * In-memory `ToolRuntime` for tests: a virtual POSIX file system under
 * `root`, real hashing and stale checks, transactions with a journal, and
 * `bash` that only echoes the command.
 */
export class MemoryToolRuntime implements ToolRuntime {
  readonly root: string | undefined;
  readonly files = new Map<string, string>();
  readonly #revisions = new Map<string, number>();
  #nextRevision = 1;
  readonly commits: CommitRecord[] = [];
  /** Highest number of concurrent prepare/commit calls of read-only tools seen. */
  maxConcurrentReads = 0;
  #reading = 0;
  #searches = 0;
  readonly #searchQueue: (() => void)[] = [];
  readonly #opts: MemoryToolRuntimeOptions;

  constructor(opts: MemoryToolRuntimeOptions) {
    this.#opts = opts;
    this.root = opts.root === undefined ? undefined : posix.resolve(normalizeDrivePath(refuseUnc(opts.root)));
    for (const [p, content] of Object.entries(opts.files ?? {})) this.files.set(this.#abs(p), content);
  }

  #abs(p: string): string {
    return posix.resolve(this.root ?? '/', normalizeDrivePath(refuseUnc(p)));
  }

  /** Sets a file, or deletes it when `content` is null, and returns its new revision. */
  setFile(path: string, content: string | null, revision: number = this.#nextRevision++): number {
    const absPath = this.#abs(path);
    if (content === null) this.files.delete(absPath);
    else this.files.set(absPath, content);
    if (revision === 0) this.#revisions.delete(absPath);
    else this.#revisions.set(absPath, revision);
    return revision;
  }

  /** Revision of the last change made through this runtime, if any. */
  revision(path: string): number {
    return this.#revisions.get(this.#abs(path)) ?? 0;
  }

  /** Simulates a change made outside the run. */
  externalWrite(p: string, content: string): void {
    this.setFile(p, content);
  }

  read(p: string): string | undefined {
    return this.files.get(this.#abs(p));
  }

  /** Resolves `p` against the session cwd and keeps it inside the fixed root, or else the session cwd and roots. */
  #resolve(p: string, ctx: SessionContext): string {
    // The session cwd and roots are refused even when a fixed root replaces them.
    for (const root of ctx.roots) refuseUnc(root);
    const abs = posix.resolve(normalizeDrivePath(refuseUnc(ctx.cwd)), normalizeDrivePath(refuseUnc(p)));
    const roots = this.root === undefined ? [ctx.cwd, ...ctx.roots].map((root) => posix.resolve(normalizeDrivePath(root))) : [this.root];
    if (!roots.some((root) => isInside(abs, root))) {
      throw new ToolError('outside-workspace', `${p} is outside the workspace ${roots.join(', ')}`);
    }
    return abs;
  }

  async #jitter(signal?: AbortSignal): Promise<void> {
    const max = this.#opts.jitterMs ?? 0;
    if (max > 0) await sleep(Math.random() * max, signal);
  }

  async prepare(call: ToolCall, ctx: SessionContext, policy: PolicySnapshot): Promise<PreparedCall> {
    const readOnly = call.tool === 'read' || call.tool === 'grep' || call.tool === 'glob';
    if (readOnly) this.#enterRead();
    try {
      await this.#jitter();
      return this.#prepareNow(call, ctx, policy);
    } finally {
      if (readOnly) this.#reading--;
    }
  }

  #enterRead(): void {
    this.#reading++;
    this.maxConcurrentReads = Math.max(this.maxConcurrentReads, this.#reading);
  }

  #protect(absPath: string, policy: PolicySnapshot): void {
    if (findMatchingPattern(absPath, policy.protectedPaths) !== undefined) {
      throw new ToolError('protected-path', `${absPath} is a protected host policy path`);
    }
  }

  #prepareNow(call: ToolCall, ctx: SessionContext, policy: PolicySnapshot): PreparedCall {
    switch (call.tool) {
      case 'bash': {
        const cwd = this.#resolve(call.args.cwd ?? '.', ctx);
        const args = { command: call.args.command, cwd, timeoutMs: call.args.timeoutMs ?? 120_000 };
        return { id: call.id, tool: 'bash', args, effect: { ...args, shell: this.#opts.shell ?? MEMORY_BASH_SHELL, containment: policy.bashContainment } };
      }
      case 'read': {
        const absPath = this.#resolve(call.args.path, ctx);
        if (!this.files.has(absPath)) throw new ToolError('not-found', `${absPath} does not exist`);
        const offset = call.args.offset ?? 1;
        const limit = call.args.limit ?? 2000;
        return { id: call.id, tool: 'read', args: { path: absPath, offset, limit }, effect: { absPath, offset, limit } };
      }
      case 'write': {
        const absPath = this.#resolve(call.args.path, ctx);
        this.#protect(absPath, policy);
        const before = this.files.get(absPath) ?? null;
        return {
          id: call.id,
          tool: 'write',
          args: { path: absPath, content: call.args.content },
          effect: {
            absPath,
            beforeHash: before === null ? null : sha256(before),
            afterContent: call.args.content,
            diff: simpleDiff(absPath, before, call.args.content),
          },
        };
      }
      case 'edit': {
        const absPath = this.#resolve(call.args.path, ctx);
        this.#protect(absPath, policy);
        const before = this.files.get(absPath);
        if (before === undefined) throw new ToolError('not-found', `${absPath} does not exist`);
        const { oldString, newString } = call.args;
        const matches = scanMatches(before, oldString, MAX_EDIT_REPLACEMENTS + 1);
        const count = matches.count;
        if (count === 0) throw new ToolError('not-found', `oldString not found in ${absPath}`);
        if (count > MAX_EDIT_REPLACEMENTS) {
          throw new ToolError('invalid-args', `oldString matches more than ${MAX_EDIT_REPLACEMENTS} times in ${absPath}; split the edit`);
        }
        if (count > 1 && call.args.replaceAll !== true) {
          throw new ToolError('invalid-args', `oldString matches ${count} times in ${absPath}; pass replaceAll or a longer oldString`);
        }
        const replacements = call.args.replaceAll === true ? count : 1;
        const afterLength = before.length + replacements * (newString.length - oldString.length);
        if (afterLength > MAX_ARG_CHARS) throw new ToolError('invalid-args', 'edited content is too large');
        // Size the diff from counts alone, so an oversized edit builds neither its text nor its diff.
        const newlinesBefore = countNewlines(before);
        const rowsBefore = diffRows(before.length, newlinesBefore, before.endsWith('\n'));
        checkDiffLines(rowsBefore);
        const newlinesAfter = newlinesBefore + replacements * (countNewlines(newString) - countNewlines(oldString));
        checkDiffLines(rowsBefore + diffRows(afterLength, newlinesAfter, editEndsWithNewline(before, matches, call.args.replaceAll === true, oldString, newString)));
        const afterContent =
          call.args.replaceAll === true ? before.replaceAll(call.args.oldString, () => newString) : before.replace(call.args.oldString, () => newString);
        return {
          id: call.id,
          tool: 'edit',
          args: { ...call.args, path: absPath },
          effect: {
            absPath,
            beforeHash: sha256(before),
            afterContent,
            diff: simpleDiff(absPath, before, afterContent),
            matchedOldString: call.args.oldString,
            matchStrategy: 'exact',
            replacements,
          },
        };
      }
      case 'grep': {
        const absRoot = this.#resolve(call.args.path ?? '.', ctx);
        const effect = {
          absRoot,
          pattern: call.args.pattern,
          glob: call.args.glob ?? null,
          ignoreCase: call.args.ignoreCase ?? false,
          maxResults: call.args.maxResults ?? 200,
        };
        try {
          new RegExp(effect.pattern);
        } catch {
          throw new ToolError('invalid-args', `invalid regular expression ${effect.pattern}`);
        }
        return { id: call.id, tool: 'grep', args: { ...call.args, path: absRoot }, effect };
      }
      case 'glob': {
        const absRoot = this.#resolve(call.args.path ?? '.', ctx);
        const effect = { absRoot, pattern: call.args.pattern, maxResults: call.args.maxResults ?? 200 };
        return { id: call.id, tool: 'glob', args: { ...call.args, path: absRoot }, effect };
      }
    }
  }

  async commit(prepared: PreparedCall, signal: AbortSignal, tx?: Transaction): Promise<ToolResult> {
    if (signal.aborted) throw new ToolError('cancelled', 'the run was stopped before commit');
    switch (prepared.tool) {
      case 'read':
      case 'grep':
      case 'glob': {
        this.#enterRead();
        try {
          await this.#jitter(signal);
          return prepared.tool === 'read' ? this.#commitRead(prepared) : await this.#search(prepared, signal);
        } finally {
          this.#reading--;
        }
      }
      case 'bash':
      case 'write':
      case 'edit': {
        const delay = this.#opts.commitDelayMs ?? 0;
        await sleep(delay, this.#opts.honorAbortInCommit === false ? undefined : signal);
        await this.#jitter(this.#opts.honorAbortInCommit === false ? undefined : signal);
        return this.#commitMutation(prepared, tx);
      }
    }
  }

  /** Waits, cancelably, for a search slot and returns its release, which runs at most once. */
  async #takeSearchSlot(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw new ToolError('cancelled', 'the search was stopped');
    if (this.#searches < MAX_CONCURRENT_SEARCHES) this.#searches++;
    else {
      await new Promise<void>((resolve, reject) => {
        const grant = (): void => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = (): void => {
          this.#searchQueue.splice(this.#searchQueue.indexOf(grant), 1);
          reject(new ToolError('cancelled', 'the search was stopped'));
        };
        this.#searchQueue.push(grant);
        signal.addEventListener('abort', onAbort, { once: true });
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#searchQueue.shift();
      if (next === undefined) this.#searches--;
      else next();
    };
  }

  async #search(prepared: Extract<PreparedCall, { tool: 'grep' | 'glob' }>, signal: AbortSignal): Promise<ToolResult> {
    const release = await this.#takeSearchSlot(signal);
    let pending: Promise<ToolResult>;
    try {
      if (signal.aborted) throw new ToolError('cancelled', 'the search was stopped');
      pending = this.#startSearch(prepared, signal, release);
    } catch (err) {
      // No worker started, so the slot is free again.
      release();
      throw err;
    }
    const result = await pending;
    this.#recordCommit(prepared, prepared.effect.absRoot);
    return result;
  }

  /** Builds the job once a slot is held; the content stays here until the worker asks for it. */
  #startSearch(prepared: Extract<PreparedCall, { tool: 'grep' | 'glob' }>, signal: AbortSignal, release: () => void): Promise<ToolResult> {
    const { absRoot, maxResults } = prepared.effect;
    const inRoot = [...this.files.entries()].filter(([file]) => isInside(file, absRoot) && (prepared.tool === 'grep' || file !== absRoot));
    inRoot.sort(([a], [b]) => (prepared.tool === 'grep' ? a.localeCompare(b) : a < b ? -1 : a > b ? 1 : 0));
    let budget = 0;
    const files = inRoot.map(([file]) => {
      const rel = normalizeSeparators(posix.relative(absRoot, file));
      const names = prepared.tool === 'grep' ? [normalizeSeparators(posix.basename(file)), rel] : [rel];
      budget += file.length + names.reduce((sum, name) => sum + name.length, 0);
      return [file, names] as const;
    });
    if (budget > MAX_SEARCH_CHARS) throw tooLarge();
    if (prepared.tool === 'grep') {
      const { pattern, ignoreCase, glob } = prepared.effect;
      const names = glob === null ? null : regExpSource(pathPatternRegExp(glob, false));
      const job = { names, lines: { source: pattern, flags: ignoreCase ? 'i' : '' }, maxResults, files };
      const contents = inRoot.map(([, content]) => content);
      return searchInWorker(job, contents, budget, GrepReplySchema, signal, release).then((r) => ({ ...r, filtered: 0 }));
    }
    const names = regExpSource(pathPatternRegExp(prepared.effect.pattern, false));
    return searchInWorker({ names, lines: null, maxResults, files }, null, budget, GlobReplySchema, signal, release).then((r) => ({ ...r, filtered: 0 }));
  }

  #commitRead(prepared: Extract<PreparedCall, { tool: 'read' }>): ToolResult {
    const { absPath, offset, limit } = prepared.effect;
    const content = this.files.get(absPath);
    if (content === undefined) throw new ToolError('not-found', `${absPath} does not exist`);
    const lines = content === '' ? [] : content.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    const window = lines.slice(offset - 1, offset - 1 + limit);
    this.#recordCommit(prepared, absPath);
    const unterminated = offset - 1 + window.length >= lines.length && !content.endsWith('\n');
    const text = window.length === 0 ? '' : `${window.join('\n')}${unterminated ? '' : '\n'}`;
    return { path: absPath, content: text, startLine: offset, totalLines: lines.length, truncated: offset - 1 + window.length < lines.length };
  }

  #commitMutation(prepared: Extract<PreparedCall, { tool: 'bash' | 'write' | 'edit' }>, tx: Transaction | undefined): ToolResult {
    switch (prepared.tool) {
      case 'bash': {
        this.#recordCommit(prepared, prepared.effect.command);
        if (this.#opts.bashResult) return this.#opts.bashResult(prepared.effect);
        return { exitCode: 0, signal: null, stdout: `fake: ${prepared.effect.command}\n`, stderr: '', truncated: false, timedOut: false };
      }
      case 'write':
      case 'edit': {
        const { absPath, beforeHash, afterContent, diff } = prepared.effect;
        const current = this.files.get(absPath) ?? null;
        const currentHash = current === null ? null : sha256(current);
        if (currentHash !== beforeHash) throw new ToolError('stale', `${absPath} changed after the call was prepared`);
        const originalRevision = this.revision(absPath);
        const revision = this.setFile(absPath, afterContent);
        if (tx instanceof MemoryTransaction) tx.record(absPath, current, originalRevision, revision);
        this.#recordCommit(prepared, absPath);
        if (prepared.tool === 'write') return { path: absPath, created: current === null, diff };
        return { path: absPath, replacements: prepared.effect.replacements, matchStrategy: prepared.effect.matchStrategy, diff };
      }
    }
  }

  #recordCommit(prepared: PreparedCall, target: string): void {
    if (this.#opts.recordCalls !== false) this.commits.push({ id: prepared.id, tool: prepared.tool, target });
  }

  beginTransaction(): Transaction {
    return new MemoryTransaction(this);
  }
}
