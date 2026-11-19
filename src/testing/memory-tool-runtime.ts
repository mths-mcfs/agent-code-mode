import { createHash } from 'node:crypto';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { ToolError } from '../core/errors.js';
import { findMatchingPattern, normalizeSeparators, pathPatternRegExp } from '../core/paths.js';
import { MAX_ARG_CHARS } from '../core/schemas.js';
import type {
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

/** Minimal whole-file unified diff, good enough for tests. */
export function simpleDiff(file: string, before: string | null, after: string): string {
  const lines = (s: string): string[] => (s === '' ? [] : s.replace(/\n$/, '').split('\n'));
  const a = before === null ? [] : lines(before);
  const b = lines(after);
  const head = `--- ${before === null ? '/dev/null' : `a${file}`}\n+++ b${file}\n@@ -${a.length > 0 ? 1 : 0},${a.length} +${b.length > 0 ? 1 : 0},${b.length} @@\n`;
  const side = (prefix: string, content: string, rows: readonly string[]): string =>
    rows.map((row) => `${prefix}${row}\n`).join('') + (rows.length > 0 && !content.endsWith('\n') ? '\\ No newline at end of file\n' : '');
  return head + side('-', before ?? '', a) + side('+', after, b);
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
}

/** One committed call, for assertions. */
export interface CommitRecord {
  readonly id: string;
  readonly tool: ToolCall['tool'];
  readonly target: string;
}

interface JournalEntry {
  readonly original: string | null;
  /** Revision of the file this transaction last wrote. */
  revision: number;
}

/**
 * Runs a grep or glob job in a worker thread, so a costly user pattern never
 * blocks the server and can be stopped. Files with no content are only listed.
 */
const SEARCH_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { names, lines, maxResults, files } = workerData;
const nameRe = names === null ? null : new RegExp(names.source, names.flags);
const lineRe = lines === null ? null : new RegExp(lines.source, lines.flags);
const found = [];
let truncated = false;
scan: for (const [file, candidates, content] of files) {
  if (nameRe !== null && !candidates.some((name) => nameRe.test(name))) continue;
  const rows = lineRe === null ? [null] : content.split('\\n');
  for (let i = 0; i < rows.length; i++) {
    if (lineRe !== null && !lineRe.test(rows[i])) continue;
    if (found.length >= maxResults) {
      truncated = true;
      break scan;
    }
    found.push(lineRe === null ? file : { file, line: i + 1, text: rows[i] });
  }
}
parentPort.postMessage(lineRe === null ? { files: found, truncated } : { matches: found, truncated });
`;

const GrepReplySchema = z.object({
  matches: z.array(z.object({ file: z.string(), line: z.number(), text: z.string() })),
  truncated: z.boolean(),
});
const GlobReplySchema = z.object({ files: z.array(z.string()), truncated: z.boolean() });

interface SearchJob {
  readonly names: { readonly source: string; readonly flags: string } | null;
  readonly lines: { readonly source: string; readonly flags: string } | null;
  readonly maxResults: number;
  /** `[absolute path, names the name pattern is tried on, content]`, sorted. */
  readonly files: readonly (readonly [string, readonly string[], string])[];
}

function searchInWorker<T>(job: SearchJob, schema: z.ZodType<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new ToolError('cancelled', 'the search was stopped'));
    const worker = new Worker(SEARCH_WORKER, { eval: true, workerData: job });
    const finish = (settle: () => void): void => {
      signal.removeEventListener('abort', onAbort);
      void worker.terminate();
      settle();
    };
    const onAbort = (): void => finish(() => reject(new ToolError('cancelled', 'the search was stopped')));
    signal.addEventListener('abort', onAbort, { once: true });
    worker.once('message', (message: unknown) => {
      const reply = schema.safeParse(message);
      finish(() => (reply.success ? resolve(reply.data) : reject(new ToolError('tool-error', 'the search returned an invalid reply'))));
    });
    worker.once('error', (err) => finish(() => reject(new ToolError('tool-error', `the search failed: ${err.message}`))));
    worker.once('exit', (code) => finish(() => reject(new ToolError('tool-error', `the search stopped with exit code ${code}`))));
  });
}

const regExpSource = (re: RegExp): { source: string; flags: string } => ({ source: re.source, flags: re.flags });

/** POSIX form of a host path, so a Windows cwd such as `C:\ws` becomes `/C:/ws` instead of a relative path. */
function virtualPath(p: string): string {
  const s = normalizeSeparators(p);
  return /^[A-Za-z]:(\/|$)/.test(s) ? `/${s}` : s;
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

  record(absPath: string, before: string | null, revision: number): void {
    if (this.disposed) return;
    const entry = this.journal.get(absPath);
    if (entry) entry.revision = revision;
    else this.journal.set(absPath, { original: before, revision });
  }

  async rollback(): Promise<RollbackReport> {
    const restored: string[] = [];
    const skipped: { path: string; reason: 'changed-externally' }[] = [];
    for (const [absPath, entry] of [...this.journal.entries()].reverse()) {
      // A later write by anyone else, even of the same text, has another revision.
      if (this.runtime.revision(absPath) !== entry.revision) {
        skipped.push({ path: absPath, reason: 'changed-externally' });
        continue;
      }
      this.runtime.setFile(absPath, entry.original);
      restored.push(absPath);
    }
    this.journal.clear();
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
  readonly #opts: MemoryToolRuntimeOptions;

  constructor(opts: MemoryToolRuntimeOptions) {
    this.#opts = opts;
    this.root = opts.root === undefined ? undefined : posix.resolve(opts.root);
    for (const [p, content] of Object.entries(opts.files ?? {})) this.files.set(this.#abs(p), content);
  }

  #abs(p: string): string {
    return posix.resolve(this.root ?? '/', p);
  }

  /** Sets a file, or deletes it when `content` is null, and returns its new revision. */
  setFile(absPath: string, content: string | null): number {
    if (content === null) this.files.delete(absPath);
    else this.files.set(absPath, content);
    const revision = this.#nextRevision++;
    this.#revisions.set(absPath, revision);
    return revision;
  }

  /** Revision of the last change made through this runtime, if any. */
  revision(absPath: string): number | undefined {
    return this.#revisions.get(absPath);
  }

  /** Simulates a change made outside the run. */
  externalWrite(p: string, content: string): void {
    this.setFile(this.#abs(p), content);
  }

  read(p: string): string | undefined {
    return this.files.get(this.#abs(p));
  }

  /** Resolves `p` against the session cwd and keeps it inside the fixed root, or else the session cwd and roots. */
  #resolve(p: string, ctx: SessionContext): string {
    const abs = posix.resolve(virtualPath(ctx.cwd), virtualPath(p));
    const roots = this.root === undefined ? [ctx.cwd, ...ctx.roots].map((root) => posix.resolve(virtualPath(root))) : [this.root];
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
        return { id: call.id, tool: 'bash', args, effect: { ...args, containment: policy.bashContainment } };
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
        const parts = before.split(call.args.oldString);
        const count = parts.length - 1;
        if (count === 0) throw new ToolError('not-found', `oldString not found in ${absPath}`);
        if (count > 1 && call.args.replaceAll !== true) {
          throw new ToolError('invalid-args', `oldString matches ${count} times in ${absPath}; pass replaceAll or a longer oldString`);
        }
        const replacements = call.args.replaceAll === true ? count : 1;
        const afterLength = before.length + replacements * (call.args.newString.length - call.args.oldString.length);
        if (afterLength > MAX_ARG_CHARS) throw new ToolError('invalid-args', 'edited content is too large');
        const afterContent = parts.join(call.args.newString);
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

  async #search(prepared: Extract<PreparedCall, { tool: 'grep' | 'glob' }>, signal: AbortSignal): Promise<ToolResult> {
    const { absRoot, maxResults } = prepared.effect;
    const inRoot = [...this.files.entries()].filter(([file]) => isInside(file, absRoot));
    const rel = (file: string): string => normalizeSeparators(posix.relative(absRoot, file));
    let result: ToolResult;
    if (prepared.tool === 'grep') {
      const { pattern, ignoreCase, glob } = prepared.effect;
      const files = inRoot
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([file, content]) => [file, [normalizeSeparators(posix.basename(file)), rel(file)], content] as const);
      const names = glob === null ? null : regExpSource(pathPatternRegExp(glob, false));
      result = await searchInWorker({ names, lines: { source: pattern, flags: ignoreCase ? 'i' : '' }, maxResults, files }, GrepReplySchema, signal);
    } else {
      const files = inRoot
        .filter(([file]) => file !== absRoot)
        .map(([file]) => file)
        .sort()
        .map((file) => [file, [rel(file)], ''] as const);
      const names = regExpSource(pathPatternRegExp(prepared.effect.pattern, false));
      result = await searchInWorker({ names, lines: null, maxResults, files }, GlobReplySchema, signal);
    }
    this.#recordCommit(prepared, absRoot);
    return result;
  }

  #commitRead(prepared: Extract<PreparedCall, { tool: 'read' }>): ToolResult {
    const { absPath, offset, limit } = prepared.effect;
    const content = this.files.get(absPath);
    if (content === undefined) throw new ToolError('not-found', `${absPath} does not exist`);
    const lines = content.split('\n');
    const window = lines.slice(offset - 1, offset - 1 + limit);
    this.#recordCommit(prepared, absPath);
    return { path: absPath, content: window.join('\n'), startLine: offset, totalLines: lines.length, truncated: offset - 1 + limit < lines.length };
  }

  #commitMutation(prepared: Extract<PreparedCall, { tool: 'bash' | 'write' | 'edit' }>, tx: Transaction | undefined): ToolResult {
    switch (prepared.tool) {
      case 'bash': {
        this.#recordCommit(prepared, prepared.effect.command);
        return { exitCode: 0, signal: null, stdout: `fake: ${prepared.effect.command}\n`, stderr: '', truncated: false, timedOut: false };
      }
      case 'write':
      case 'edit': {
        const { absPath, beforeHash, afterContent, diff } = prepared.effect;
        const current = this.files.get(absPath) ?? null;
        const currentHash = current === null ? null : sha256(current);
        if (currentHash !== beforeHash) throw new ToolError('stale', `${absPath} changed after the call was prepared`);
        const revision = this.setFile(absPath, afterContent);
        if (tx instanceof MemoryTransaction) tx.record(absPath, current, revision);
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
