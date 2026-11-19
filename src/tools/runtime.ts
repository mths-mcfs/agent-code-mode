import fs from 'node:fs/promises';
import path from 'node:path';
import { ToolError, errorMessage } from '../core/errors.js';
import type {
  BashContainment,
  CommitObserver,
  PolicySnapshot,
  PreparedCall,
  PreparedCallOf,
  ReadResult,
  SessionContext,
  ToolCall,
  ToolResult,
  ToolRuntime,
  Transaction,
  WatchedChange,
} from '../core/types.js';
import { DEFAULT_BASH_TIMEOUT_MS, MAX_BASH_TIMEOUT_MS, expandBashGlobs, findBash, runBash, shellQuote } from './bash.js';
import { binaryDiff, unifiedDiff } from './diff.js';
import { applySearchReplace } from './edit-match.js';
import { type PathIdentity, type RegularFile, assertDirUnchanged, atomicWrite, captureIdentity, decodeText, errnoCode, isBinary, readRegularFile, sha256 } from './fs-ops.js';
import { FileTransaction } from './journal.js';
import { Jail } from './jail.js';
import { containmentUnavailableReason } from './sandbox.js';
import { DEFAULT_GLOB_MAX_RESULTS, DEFAULT_GREP_MAX_RESULTS, compileGrep, normalizeGlob, runGlob, runGrep } from './search.js';
import { type WatchSnapshot, changedWatched, describeChanges, incompleteReason, snapshotWatched, uncheckedWatched } from './watch.js';

/** Default number of lines `read` returns. */
export const DEFAULT_READ_LIMIT = 2000;
/** Most bytes of content one `read` returns. */
export const READ_CAP_BYTES = 256 * 1024;
/** Largest file `read`, `write` (existing content) and `edit` load. */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;

export interface NodeToolRuntimeOptions {
  /** Server state directory; transaction journals live under `<stateDir>/journal/`. */
  readonly stateDir: string;
  /**
   * Extra absolute directories the tools may touch besides the session cwd,
   * MCP roots and the policy's `additionalRoots` (tests; the server takes
   * them from the policy).
   */
  readonly additionalRoots?: readonly string[];
  /** Bytes kept of each of bash stdout and stderr. */
  readonly bashOutputCapBytes?: number;
  /** Time the grep regular expression may run on one file before grep fails. */
  readonly grepFileBudgetMs?: number;
}

/** What `commit` needs to know about a call besides its frozen effect. */
interface CallMeta {
  /** Workspace root that contains the call's path. */
  readonly root: string;
  /** Every real root of the run (journaled so crash recovery stays inside them). */
  readonly runRoots: readonly string[];
  /** Path shown in diffs. */
  readonly display: string;
  /** Paths a sandboxed bash may never write. */
  readonly denyWrite: readonly string[];
  /** For bash: the patterns fingerprinted around the call (`policy.watchedPaths`, else `protectedPaths`). */
  readonly watched?: readonly string[];
  /** For bash: the host's filter of routine changes there. */
  readonly routine?: (change: WatchedChange) => Promise<boolean>;
  /** For write and edit: identity of the file and its directories at prepare. */
  readonly identity?: PathIdentity;
  /** For grep and glob: the policy's Read filter. */
  readonly readFilter?: (realAbsPath: string) => boolean;
}

/** What the last bash call of a run left in the watched paths, and how to compare them. */
interface WatchState {
  readonly patterns: readonly string[];
  readonly routine: ((change: WatchedChange) => Promise<boolean>) | undefined;
  readonly snapshot: WatchSnapshot;
  readonly callId: string;
}

/** Most prepared calls whose metadata is kept while they wait for commit. */
const MAX_PENDING_META = 4096;

function metaKey(prepared: PreparedCall): string {
  return sha256(JSON.stringify([prepared.id, prepared.tool, prepared.effect]));
}

class MetaStore {
  readonly #map = new Map<string, CallMeta>();

  put(prepared: PreparedCall, meta: CallMeta): void {
    const key = metaKey(prepared);
    this.#map.delete(key);
    this.#map.set(key, meta);
    while (this.#map.size > MAX_PENDING_META) {
      const oldest = this.#map.keys().next();
      if (oldest.done === true) break;
      this.#map.delete(oldest.value);
    }
  }

  take(prepared: PreparedCall): CallMeta | undefined {
    const key = metaKey(prepared);
    const meta = this.#map.get(key);
    this.#map.delete(key);
    return meta;
  }
}

/**
 * Literal paths from protected patterns that the OS sandbox can enforce:
 * patterns without wildcards, and `dir/**` patterns as `dir`.
 */
function sandboxDenyWrite(patterns: readonly string[]): string[] {
  const out: string[] = [];
  for (const p of patterns) {
    const base = p.endsWith('/**') ? p.slice(0, -3) : p;
    if (!/[*?[]/.test(base) && path.isAbsolute(base)) out.push(base);
  }
  return out;
}

/** Any failure of the runtime reaches the dispatcher as a `ToolError`. */
function asToolError(err: unknown): ToolError {
  if (err instanceof ToolError) return err;
  const code = errnoCode(err);
  if (code === 'ENAMETOOLONG') return new ToolError('invalid-args', `path is too long: ${errorMessage(err)}`);
  if (code === 'ENOENT') return new ToolError('not-found', errorMessage(err));
  return new ToolError('tool-error', errorMessage(err));
}

function assertContainmentShape(c: BashContainment): void {
  if (c.mode === 'sandbox' && c.writableRoots.some((r) => !path.isAbsolute(r))) {
    throw new ToolError('containment-unavailable', 'bash containment has a writable root that is not absolute');
  }
}

/**
 * The real `ToolRuntime`: workspace jail, tolerant edit, atomic writes with
 * stale checks, transactional rollback, and contained `bash`.
 */
export class NodeToolRuntime implements ToolRuntime {
  readonly #opts: NodeToolRuntimeOptions;
  /**
   * What prepare learned about each call, keyed by a digest of the prepared
   * call's content: the dispatcher hands commit a frozen copy, not the object
   * prepare returned. Taken out at commit; bounded so calls that never commit
   * (denied ones) do not accumulate.
   */
  readonly #meta = new MetaStore();
  /** Per run (its observer): what the last bash call left in the watched paths, for the end-of-run comparison. */
  readonly #watch = new WeakMap<CommitObserver, WatchState>();

  constructor(opts: NodeToolRuntimeOptions) {
    this.#opts = opts;
  }

  async prepare(call: ToolCall, ctx: SessionContext, policy: PolicySnapshot): Promise<PreparedCall> {
    try {
      return await this.#prepareInJail(call, ctx, policy);
    } catch (err) {
      throw asToolError(err);
    }
  }

  async #prepareInJail(call: ToolCall, ctx: SessionContext, policy: PolicySnapshot): Promise<PreparedCall> {
    const jail = await Jail.create({
      cwd: ctx.cwd,
      roots: [...ctx.roots, ...(policy.additionalRoots ?? []), ...(this.#opts.additionalRoots ?? [])],
      protectedPaths: policy.protectedPaths,
    });
    const readFilter = policy.readFilter;
    const meta = (abs: string, denyWrite: readonly string[] = []): CallMeta => ({
      root: jail.rootOf(abs) ?? jail.cwd,
      runRoots: jail.roots,
      display: jail.displayPath(abs),
      denyWrite,
      ...(readFilter && (call.tool === 'grep' || call.tool === 'glob') ? { readFilter } : {}),
    });
    return this.#prepare(call, jail, policy, meta);
  }

  async #prepare(
    call: ToolCall,
    jail: Jail,
    policy: PolicySnapshot,
    meta: (abs: string, denyWrite?: readonly string[]) => CallMeta,
  ): Promise<PreparedCall> {
    switch (call.tool) {
      case 'bash': {
        if (findBash() === null) {
          throw new ToolError('tool-error', process.platform === 'win32' ? 'bash requires Git Bash, which was not found' : 'bash was not found');
        }
        let cwd = jail.cwd;
        if (call.args.cwd !== undefined) {
          cwd = await jail.resolve(call.args.cwd);
          const st = await fs.stat(cwd).catch(() => null);
          if (!st) throw new ToolError('not-found', `bash cwd ${call.args.cwd} does not exist`);
          if (!st.isDirectory()) throw new ToolError('invalid-args', `bash cwd ${call.args.cwd} is not a directory`);
        }
        // Globs of pure readers become the literal files they match (the host plans, prepare expands and validates).
        const plan = policy.planBashExpansion?.(call.args.command);
        const expanded = plan === undefined ? undefined : await expandBashGlobs(plan, cwd, jail, policy.readFilter);
        // What hooks see is exactly what runs: another cwd becomes part of the command.
        const inCwd = (c: string): string => (cwd === jail.cwd ? c : `cd -- ${shellQuote(cwd)} && ${c}`);
        const command = inCwd(expanded?.command ?? call.args.command);
        const timeoutMs = Math.min(call.args.timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS, MAX_BASH_TIMEOUT_MS);
        const containment = policy.bashContainment;
        assertContainmentShape(containment);
        if (containment.mode === 'sandbox') {
          const reason = await containmentUnavailableReason();
          if (reason !== null) throw new ToolError('containment-unavailable', reason);
        }
        const prepared: PreparedCallOf<'bash'> = {
          id: call.id,
          tool: 'bash',
          args: { command, timeoutMs },
          effect: {
            command,
            cwd: jail.cwd,
            timeoutMs,
            containment,
            ...(expanded === undefined ? {} : { expansion: { original: inCwd(call.args.command), entries: expanded.entries } }),
          },
        };
        this.#meta.put(prepared, { ...meta(jail.cwd, sandboxDenyWrite(jail.protectedPaths)), watched: policy.watchedPaths ?? policy.protectedPaths, ...(policy.isRoutineWatchedChange ? { routine: policy.isRoutineWatchedChange } : {}) });
        return prepared;
      }
      case 'read': {
        const absPath = await jail.resolve(call.args.path);
        await this.#assertFile(absPath, call.args.path);
        const offset = call.args.offset ?? 1;
        const limit = call.args.limit ?? DEFAULT_READ_LIMIT;
        const prepared: PreparedCallOf<'read'> = {
          id: call.id,
          tool: 'read',
          args: { path: absPath, offset, limit },
          effect: { absPath, offset, limit },
        };
        this.#meta.put(prepared, meta(absPath));
        return prepared;
      }
      case 'write': {
        const absPath = await jail.resolveForWrite(call.args.path);
        const m = { ...meta(absPath), identity: await captureIdentity(absPath, jail.rootOf(absPath) ?? jail.cwd) };
        const current = await this.#readExisting(absPath);
        const diff =
          current !== null && isBinary(current.bytes)
            ? binaryDiff(m.display, true)
            : unifiedDiff(m.display, current === null ? null : current.bytes.toString('utf8'), call.args.content);
        const prepared: PreparedCallOf<'write'> = {
          id: call.id,
          tool: 'write',
          args: { path: absPath, content: call.args.content },
          effect: {
            absPath,
            beforeHash: current === null ? null : sha256(current.bytes),
            afterContent: call.args.content,
            diff,
          },
        };
        this.#meta.put(prepared, m);
        return prepared;
      }
      case 'edit': {
        const absPath = await jail.resolveForWrite(call.args.path);
        const m = { ...meta(absPath), identity: await captureIdentity(absPath, jail.rootOf(absPath) ?? jail.cwd) };
        const current = await this.#readExisting(absPath);
        if (current === null) throw new ToolError('not-found', `${m.display} does not exist`);
        const text = decodeText(m.display, current.bytes);
        if (call.args.oldString === call.args.newString) {
          throw new ToolError('invalid-args', 'oldString and newString are the same; the edit would change nothing');
        }
        const outcome = applySearchReplace(text, call.args.oldString, call.args.newString, call.args.replaceAll === true);
        if (!outcome.ok) {
          const code = outcome.kind === 'not-found' ? 'not-found' : 'invalid-args';
          throw new ToolError(code, `${m.display}: ${outcome.message}`);
        }
        const prepared: PreparedCallOf<'edit'> = {
          id: call.id,
          tool: 'edit',
          args: { ...call.args, path: absPath },
          effect: {
            absPath,
            beforeHash: sha256(current.bytes),
            afterContent: outcome.text,
            diff: unifiedDiff(m.display, text, outcome.text),
            matchedOldString: outcome.matched,
            matchStrategy: outcome.how,
            replacements: outcome.count,
          },
        };
        this.#meta.put(prepared, m);
        return prepared;
      }
      case 'grep': {
        const absRoot = await jail.resolve(call.args.path ?? '.');
        await this.#assertExists(absRoot, call.args.path ?? '.');
        const ignoreCase = call.args.ignoreCase ?? false;
        compileGrep(call.args.pattern, ignoreCase);
        const effect = {
          absRoot,
          pattern: call.args.pattern,
          glob: call.args.glob ?? null,
          ignoreCase,
          maxResults: call.args.maxResults ?? DEFAULT_GREP_MAX_RESULTS,
        };
        const prepared: PreparedCallOf<'grep'> = { id: call.id, tool: 'grep', args: { ...call.args, path: absRoot }, effect };
        this.#meta.put(prepared, meta(absRoot));
        return prepared;
      }
      case 'glob': {
        const absRoot = await jail.resolve(call.args.path ?? '.');
        const st = await this.#assertExists(absRoot, call.args.path ?? '.');
        if (!st.isDirectory()) throw new ToolError('invalid-args', `glob path ${call.args.path ?? '.'} is not a directory`);
        normalizeGlob(call.args.pattern, absRoot);
        const effect = { absRoot, pattern: call.args.pattern, maxResults: call.args.maxResults ?? DEFAULT_GLOB_MAX_RESULTS };
        const prepared: PreparedCallOf<'glob'> = { id: call.id, tool: 'glob', args: { ...call.args, path: absRoot }, effect };
        this.#meta.put(prepared, meta(absRoot));
        return prepared;
      }
    }
  }

  async #assertExists(abs: string, shown: string): Promise<import('node:fs').Stats> {
    const st = await fs.lstat(abs).catch((err: unknown) => {
      if (errnoCode(err) === 'ENOENT' || errnoCode(err) === 'ENOTDIR') return null;
      throw new ToolError('tool-error', `cannot stat ${shown}: ${errnoCode(err) ?? String(err)}`);
    });
    if (!st) throw new ToolError('not-found', `${shown} does not exist`);
    return st;
  }

  async #assertFile(abs: string, shown: string): Promise<void> {
    const st = await this.#assertExists(abs, shown);
    if (st.isDirectory()) throw new ToolError('invalid-args', `${shown} is a directory`);
    if (!st.isFile()) throw new ToolError('invalid-args', `${shown} is not a regular file`);
  }

  async #readExisting(abs: string): Promise<{ bytes: Buffer; mode: number } | null> {
    const st = await fs.lstat(abs).catch(() => null);
    if (st?.isDirectory()) throw new ToolError('invalid-args', `${abs} is a directory`);
    return readRegularFile(abs, MAX_FILE_BYTES);
  }

  #metaOf(prepared: PreparedCall, fallbackPath: string): CallMeta {
    return this.#meta.take(prepared) ?? { root: path.dirname(fallbackPath), runRoots: [], display: fallbackPath, denyWrite: [] };
  }

  /** grep and glob must have been prepared here: the Read filter travels in their metadata, so a missing one fails closed. */
  #searchMetaOf(prepared: PreparedCallOf<'grep'> | PreparedCallOf<'glob'>): CallMeta {
    const m = this.#meta.take(prepared);
    if (m === undefined) throw new ToolError('tool-error', `this ${prepared.tool} was not prepared by this tool runtime (or was already committed); prepare it again`);
    return m;
  }

  async commit(prepared: PreparedCall, signal: AbortSignal, tx?: Transaction, observer?: CommitObserver): Promise<ToolResult> {
    try {
      return await this.#commit(prepared, signal, tx, observer);
    } catch (err) {
      throw asToolError(err);
    }
  }

  async #commit(prepared: PreparedCall, signal: AbortSignal, tx?: Transaction, observer?: CommitObserver): Promise<ToolResult> {
    if (signal.aborted) throw new ToolError('cancelled', 'the run was stopped before commit');
    switch (prepared.tool) {
      case 'bash': {
        const m = this.#metaOf(prepared, prepared.effect.cwd);
        const patterns = m.watched ?? [];
        const routine = m.routine;
        // The windows chain: what changed since the previous bash call of this run is compared too.
        const last = observer === undefined ? undefined : this.#watch.get(observer);
        let before: WatchSnapshot;
        try {
          // A baseline: links that appeared since (a previous call made them) are resolved now, then watched.
          before = await snapshotWatched(patterns, last?.snapshot, { baseline: true });
        } catch (err) {
          // Fail closed: a change there could not be reported afterwards, so the command does not run.
          throw new ToolError('containment-unavailable', `the protected paths could not be fingerprinted before bash, so it did not run: ${incompleteReason(err)}`);
        }
        if (observer !== undefined && last !== undefined) {
          await this.#report(observer, `during the run, after bash call ${last.callId}`, last.snapshot, before, routine);
        }
        try {
          return await runBash(prepared.effect, signal, {
            ...(this.#opts.bashOutputCapBytes !== undefined ? { outputCapBytes: this.#opts.bashOutputCapBytes } : {}),
            denyWrite: m.denyWrite,
          });
        } finally {
          // Normal end, error, cancel or timeout: compare, and report without changing the call's result.
          await this.#compareAfterBash(prepared.id, patterns, routine, before, observer);
        }
      }
      case 'read':
        return this.#commitRead(prepared);
      case 'write':
      case 'edit':
        return this.#commitWrite(prepared, signal, tx);
      case 'grep': {
        await assertDirUnchanged(prepared.effect.absRoot);
        const m = this.#searchMetaOf(prepared);
        return runGrep(prepared.effect, m.root, signal, this.#opts.grepFileBudgetMs, m.readFilter);
      }
      case 'glob': {
        await assertDirUnchanged(prepared.effect.absRoot);
        const m = this.#searchMetaOf(prepared);
        return runGlob(prepared.effect, m.root, signal, m.readFilter);
      }
    }
  }

  async #commitRead(prepared: PreparedCallOf<'read'>): Promise<ReadResult> {
    const { absPath, offset, limit } = prepared.effect;
    await assertDirUnchanged(path.dirname(absPath));
    const file = await readRegularFile(absPath, MAX_FILE_BYTES);
    if (file === null) throw new ToolError('not-found', `${absPath} does not exist`);
    const text = decodeText(absPath, file.bytes);
    const lines = text === '' ? [] : text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    const window: string[] = [];
    let bytes = 0;
    let truncated = false;
    for (let i = offset - 1; i < lines.length && window.length < limit; i++) {
      const line = lines[i] ?? '';
      const size = Buffer.byteLength(line, 'utf8') + 1;
      if (bytes + size > READ_CAP_BYTES) {
        truncated = true;
        break;
      }
      window.push(line);
      bytes += size;
    }
    if (offset - 1 + window.length < lines.length) truncated = true;
    // Exact text of the window: every line keeps its newline, except a last line the file leaves unterminated.
    const unterminated = offset - 1 + window.length >= lines.length && !text.endsWith('\n');
    const content = window.length === 0 ? '' : `${window.join('\n')}${unterminated ? '' : '\n'}`;
    return { path: absPath, content, startLine: offset, totalLines: lines.length, truncated };
  }

  async #commitWrite(
    prepared: PreparedCallOf<'write'> | PreparedCallOf<'edit'>,
    signal: AbortSignal,
    tx: Transaction | undefined,
  ): Promise<ToolResult> {
    if (tx !== undefined && !(tx instanceof FileTransaction)) {
      throw new ToolError('tool-error', 'the transaction was not started by this tool runtime; refusing to write without a journal');
    }
    const { absPath, beforeHash, afterContent } = prepared.effect;
    const m = this.#meta.take(prepared);
    if (m?.identity === undefined) {
      throw new ToolError('tool-error', 'this write was not prepared by this tool runtime (or was already committed); prepare it again');
    }
    const bytes = Buffer.from(afterContent, 'utf8');
    const nextHash = sha256(bytes);
    const outcome = await atomicWrite(absPath, bytes, beforeHash === null ? { kind: 'absent' } : { kind: 'hash', sha256: beforeHash }, {
      signal,
      identity: m.identity,
      ...(tx ? { beforeWrite: (before: RegularFile | null, createdDirs: readonly string[]) => tx.record(absPath, m.root, before, nextHash, createdDirs, m.runRoots) } : {}),
    });
    tx?.written(absPath, nextHash);
    if (prepared.tool === 'write') return { path: absPath, created: outcome.before === null, diff: prepared.effect.diff };
    return {
      path: absPath,
      replacements: prepared.effect.replacements,
      matchStrategy: prepared.effect.matchStrategy,
      diff: prepared.effect.diff,
    };
  }

  async #compareAfterBash(
    callId: string,
    patterns: readonly string[],
    routine: WatchState['routine'],
    before: WatchSnapshot,
    observer: CommitObserver | undefined,
  ): Promise<void> {
    let after: WatchSnapshot;
    try {
      after = await snapshotWatched(patterns, before);
    } catch (err) {
      observer?.warn(`protected path check incomplete after bash call ${callId}: ${incompleteReason(err)}`);
      if (observer) this.#watch.set(observer, { patterns, routine, snapshot: before, callId });
      return;
    }
    if (observer === undefined) return;
    this.#watch.set(observer, { patterns, routine, snapshot: after, callId });
    await this.#report(observer, `during bash call ${callId}`, before, after, routine);
  }

  /** Warns about the unexplained differences between two snapshots; a failed comparison is reported too. */
  async #report(observer: CommitObserver, when: string, before: WatchSnapshot, after: WatchSnapshot, routine: WatchState['routine']): Promise<void> {
    try {
      const changed = await changedWatched(before, after, routine);
      if (changed.length > 0) observer.warn(`protected path changed ${when}: ${describeChanges(changed)}`);
      const unchecked = uncheckedWatched(before, after).filter((p) => !changed.includes(p));
      if (unchecked.length > 0) {
        observer.warn(`protected path check incomplete ${when}: compared by size, time, inode and mode only (hash budget spent): ${describeChanges(unchecked)}`);
      }
    } catch (err) {
      observer.warn(`protected path check incomplete ${when}: ${incompleteReason(err)}`);
    }
  }

  async finishRun(observer: CommitObserver): Promise<void> {
    const last = this.#watch.get(observer);
    if (last === undefined) return;
    this.#watch.delete(observer);
    let now: WatchSnapshot;
    try {
      now = await snapshotWatched(last.patterns, last.snapshot);
    } catch (err) {
      observer.warn(`protected path check incomplete at the end of the run: ${incompleteReason(err)}`);
      return;
    }
    await this.#report(observer, `during the run, after bash call ${last.callId}`, last.snapshot, now, last.routine);
  }

  beginTransaction(): Transaction {
    return new FileTransaction(this.#opts.stateDir);
  }
}
