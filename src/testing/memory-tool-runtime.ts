import { createHash } from 'node:crypto';
import path from 'node:path';
import { ToolError } from '../core/errors.js';
import { findMatchingPattern, matchesPathPattern } from '../core/paths.js';
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
  return head + a.map((l) => `-${l}\n`).join('') + b.map((l) => `+${l}\n`).join('');
}

export interface MemoryToolRuntimeOptions {
  /** Absolute POSIX workspace root of the virtual file system, e.g. `/ws`. */
  readonly root: string;
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
  lastWritten: string;
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

  record(absPath: string, before: string | null, after: string): void {
    if (this.disposed) return;
    const entry = this.journal.get(absPath);
    if (entry) entry.lastWritten = after;
    else this.journal.set(absPath, { original: before, lastWritten: after });
  }

  async rollback(): Promise<RollbackReport> {
    const restored: string[] = [];
    const skipped: { path: string; reason: 'changed-externally' }[] = [];
    for (const [absPath, entry] of [...this.journal.entries()].reverse()) {
      const current = this.runtime.files.get(absPath);
      if (current !== entry.lastWritten) {
        skipped.push({ path: absPath, reason: 'changed-externally' });
        continue;
      }
      if (entry.original === null) this.runtime.files.delete(absPath);
      else this.runtime.files.set(absPath, entry.original);
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
  readonly root: string;
  readonly files = new Map<string, string>();
  readonly commits: CommitRecord[] = [];
  /** Highest number of concurrent prepare/commit calls of read-only tools seen. */
  maxConcurrentReads = 0;
  #reading = 0;
  readonly #opts: MemoryToolRuntimeOptions;

  constructor(opts: MemoryToolRuntimeOptions) {
    this.#opts = opts;
    this.root = posix.resolve(opts.root);
    for (const [p, content] of Object.entries(opts.files ?? {})) this.files.set(posix.resolve(this.root, p), content);
  }

  /** Simulates a change made outside the run. */
  externalWrite(p: string, content: string): void {
    this.files.set(posix.resolve(this.root, p), content);
  }

  read(p: string): string | undefined {
    return this.files.get(posix.resolve(this.root, p));
  }

  #resolve(p: string): string {
    const abs = posix.resolve(this.root, p);
    const rel = posix.relative(this.root, abs);
    if (rel.startsWith('..') || posix.isAbsolute(rel)) {
      throw new ToolError('outside-workspace', `${p} is outside the workspace ${this.root}`);
    }
    return abs;
  }

  async #jitter(signal?: AbortSignal): Promise<void> {
    const max = this.#opts.jitterMs ?? 0;
    if (max > 0) await sleep(Math.random() * max, signal);
  }

  async prepare(call: ToolCall, _ctx: SessionContext, policy: PolicySnapshot): Promise<PreparedCall> {
    const readOnly = call.tool === 'read' || call.tool === 'grep' || call.tool === 'glob';
    if (readOnly) this.#enterRead();
    try {
      await this.#jitter();
      return this.#prepareNow(call, policy);
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

  #prepareNow(call: ToolCall, policy: PolicySnapshot): PreparedCall {
    switch (call.tool) {
      case 'bash': {
        const cwd = this.#resolve(call.args.cwd ?? '.');
        const args = { command: call.args.command, cwd, timeoutMs: call.args.timeoutMs ?? 120_000 };
        return { id: call.id, tool: 'bash', args, effect: { ...args, containment: policy.bashContainment } };
      }
      case 'read': {
        const absPath = this.#resolve(call.args.path);
        if (!this.files.has(absPath)) throw new ToolError('not-found', `${absPath} does not exist`);
        const offset = call.args.offset ?? 1;
        const limit = call.args.limit ?? 2000;
        return { id: call.id, tool: 'read', args: { path: absPath, offset, limit }, effect: { absPath, offset, limit } };
      }
      case 'write': {
        const absPath = this.#resolve(call.args.path);
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
        const absPath = this.#resolve(call.args.path);
        this.#protect(absPath, policy);
        const before = this.files.get(absPath);
        if (before === undefined) throw new ToolError('not-found', `${absPath} does not exist`);
        const count = before.split(call.args.oldString).length - 1;
        if (count === 0) throw new ToolError('not-found', `oldString not found in ${absPath}`);
        if (count > 1 && call.args.replaceAll !== true) {
          throw new ToolError('invalid-args', `oldString matches ${count} times in ${absPath}; pass replaceAll or a longer oldString`);
        }
        const afterContent = call.args.replaceAll === true
          ? before.split(call.args.oldString).join(call.args.newString)
          : before.replace(call.args.oldString, () => call.args.newString);
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
            replacements: call.args.replaceAll === true ? count : 1,
          },
        };
      }
      case 'grep': {
        const absRoot = this.#resolve(call.args.path ?? '.');
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
        const absRoot = this.#resolve(call.args.path ?? '.');
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
          return this.#commitRead(prepared);
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

  #commitRead(prepared: Extract<PreparedCall, { tool: 'read' | 'grep' | 'glob' }>): ToolResult {
    switch (prepared.tool) {
      case 'read': {
        const { absPath, offset, limit } = prepared.effect;
        const content = this.files.get(absPath);
        if (content === undefined) throw new ToolError('not-found', `${absPath} does not exist`);
        // Same line accounting as NodeToolRuntime: a final newline ends the last line, it does not start one.
        const lines = content === '' ? [] : content.split('\n');
        if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
        const window = lines.slice(offset - 1, offset - 1 + limit);
        this.commits.push({ id: prepared.id, tool: 'read', target: absPath });
        const unterminated = offset - 1 + window.length >= lines.length && !content.endsWith('\n');
        const text = window.length === 0 ? '' : `${window.join('\n')}${unterminated ? '' : '\n'}`;
        return { path: absPath, content: text, startLine: offset, totalLines: lines.length, truncated: offset - 1 + window.length < lines.length };
      }
      case 'grep': {
        const { absRoot, pattern, ignoreCase, maxResults, glob } = prepared.effect;
        const re = new RegExp(pattern, ignoreCase ? 'i' : '');
        const matches: { file: string; line: number; text: string }[] = [];
        let truncated = false;
        for (const [file, content] of [...this.files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
          if (file !== absRoot && !file.startsWith(`${absRoot}/`)) continue;
          if (glob !== null && !matchesPathPattern(posix.basename(file), glob, false) && !matchesPathPattern(posix.relative(absRoot, file), glob, false)) continue;
          content.split('\n').forEach((text, i) => {
            if (!re.test(text)) return;
            if (matches.length >= maxResults) truncated = true;
            else matches.push({ file, line: i + 1, text });
          });
        }
        this.commits.push({ id: prepared.id, tool: 'grep', target: absRoot });
        return { matches, truncated, filtered: 0 };
      }
      case 'glob': {
        const { absRoot, pattern, maxResults } = prepared.effect;
        const all = [...this.files.keys()]
          .filter((file) => file.startsWith(`${absRoot}/`) && matchesPathPattern(posix.relative(absRoot, file), pattern, false))
          .sort();
        this.commits.push({ id: prepared.id, tool: 'glob', target: absRoot });
        return { files: all.slice(0, maxResults), truncated: all.length > maxResults, filtered: 0 };
      }
    }
  }

  #commitMutation(prepared: Extract<PreparedCall, { tool: 'bash' | 'write' | 'edit' }>, tx: Transaction | undefined): ToolResult {
    switch (prepared.tool) {
      case 'bash': {
        this.commits.push({ id: prepared.id, tool: 'bash', target: prepared.effect.command });
        return { exitCode: 0, signal: null, stdout: `fake: ${prepared.effect.command}\n`, stderr: '', truncated: false, timedOut: false };
      }
      case 'write':
      case 'edit': {
        const { absPath, beforeHash, afterContent, diff } = prepared.effect;
        const current = this.files.get(absPath) ?? null;
        const currentHash = current === null ? null : sha256(current);
        if (currentHash !== beforeHash) throw new ToolError('stale', `${absPath} changed after the call was prepared`);
        this.files.set(absPath, afterContent);
        if (tx instanceof MemoryTransaction) tx.record(absPath, current, afterContent);
        this.commits.push({ id: prepared.id, tool: prepared.tool, target: absPath });
        if (prepared.tool === 'write') return { path: absPath, created: current === null, diff };
        return { path: absPath, replacements: prepared.effect.replacements, matchStrategy: prepared.effect.matchStrategy, diff };
      }
    }
  }

  beginTransaction(): Transaction {
    return new MemoryTransaction(this);
  }
}
