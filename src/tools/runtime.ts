import fs from 'node:fs/promises';
import path from 'node:path';
import { ToolError, errorMessage } from '../core/errors.js';
import type {
  BashContainment,
  MatchStrategy,
  PolicySnapshot,
  PreparedCall,
  PreparedCallOf,
  ReadResult,
  SessionContext,
  ToolCall,
  ToolResult,
  ToolRuntime,
  Transaction,
} from '../core/types.js';
import { DEFAULT_BASH_TIMEOUT_MS, MAX_BASH_TIMEOUT_MS, findBash, runBash, shellQuote } from './bash.js';
import { binaryDiff, unifiedDiff } from './diff.js';
import { applySearchReplace, type MatchHow } from './edit-match.js';
import { type DirId, type InstallId, type PathIdentity, type RegularFile, atomicWrite, captureIdentity, decodeText, errnoCode, isBinary, readRegularFile, sha256 } from './fs-ops.js';
import { FileTransaction } from './journal.js';
import { Jail } from './jail.js';
import { rooted } from './rooted.js';
import { DEFAULT_GLOB_MAX_RESULTS, DEFAULT_GREP_MAX_RESULTS, type SearchTop, compileGrep, normalizeGlob, runGlob, runGrep, searchTop } from './search.js';

/** Default number of lines `read` returns. */
export const DEFAULT_READ_LIMIT = 2000;
/** Most bytes of content one `read` returns. */
export const READ_CAP_BYTES = 256 * 1024;
/** Largest file `read`, `write` (existing content) and `edit` load. */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;

/**
 * How each Turnpack rung is reported in the frozen `MatchStrategy` type,
 * which has fewer names than the ladder has rungs.
 */
const STRATEGY: Record<MatchHow, MatchStrategy> = {
  exact: 'exact',
  'line-endings': 'whitespace-normalized',
  'line-numbers': 'line-trimmed',
  'trailing-whitespace': 'line-trimmed',
  indentation: 'indentation-flexible',
  punctuation: 'whitespace-normalized',
};

export interface NodeToolRuntimeOptions {
  /** Server state directory; transaction journals live under `<stateDir>/journal/`. */
  readonly stateDir: string;
  /** Extra absolute directories the tools may touch besides the session cwd and MCP roots. */
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
  /** Path shown in diffs. */
  readonly display: string;
  /** Paths a sandboxed bash may never write. */
  readonly denyWrite: readonly string[];
  /** For write and edit: identity of the file and its directories at prepare. */
  readonly identity?: PathIdentity;
  /** For grep and glob: the search path and what it named at prepare. */
  readonly searchTop?: SearchTop;
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
 * Paths the OS sandbox denies writing, covering every protected pattern:
 * a literal pattern as itself, `dir/**` as `dir`, and any other wildcard
 * pattern as the directory its literal prefix names (more than the pattern
 * protects, never less). Throws `containment-unavailable` for a pattern with
 * no absolute directory prefix, rather than running a command that could
 * write what the pattern protects.
 */
function sandboxDenyWrite(patterns: readonly string[]): string[] {
  const out: string[] = [];
  for (const p of patterns) {
    const base = p.endsWith('/**') ? p.slice(0, -3) : p;
    const wild = base.search(/[*?[]/);
    const literal = wild === -1 ? base : base.slice(0, base.lastIndexOf('/', wild));
    if (!path.isAbsolute(literal) || path.dirname(literal) === literal) {
      throw new ToolError('containment-unavailable', `the bash sandbox cannot enforce the protected path pattern ${p}`);
    }
    if (!out.includes(literal)) out.push(literal);
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
      roots: [...ctx.roots, ...(this.#opts.additionalRoots ?? [])],
      protectedPaths: policy.protectedPaths,
    });
    const meta = (abs: string, denyWrite: readonly string[] = []): CallMeta => ({
      root: jail.rootOf(abs) ?? jail.cwd,
      display: jail.displayPath(abs),
      denyWrite,
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
        let cwd = jail.cwd;
        if (call.args.cwd !== undefined) {
          cwd = await jail.resolve(call.args.cwd);
          const st = await fs.stat(cwd).catch(() => null);
          if (!st) throw new ToolError('not-found', `bash cwd ${call.args.cwd} does not exist`);
          if (!st.isDirectory()) throw new ToolError('invalid-args', `bash cwd ${call.args.cwd} is not a directory`);
        }
        // What hooks see is exactly what runs: another cwd becomes part of the command.
        // A cd that fails ends the whole command, whatever operators the command uses.
        const command = cwd === jail.cwd ? call.args.command : `cd -- ${shellQuote(cwd)} || exit 1\n${call.args.command}`;
        const timeoutMs = Math.min(call.args.timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS, MAX_BASH_TIMEOUT_MS);
        const containment = policy.bashContainment;
        assertContainmentShape(containment);
        const shellPath = findBash();
        if (shellPath === null) throw new ToolError('tool-error', 'bash is not installed');
        const denyWrite = containment.mode === 'sandbox' && !containment.readOnly ? sandboxDenyWrite(jail.protectedPaths) : [];
        const prepared: PreparedCallOf<'bash'> = {
          id: call.id,
          tool: 'bash',
          args: { command, timeoutMs },
          effect: { command, shell: { path: shellPath, args: ['-c'] }, cwd: jail.cwd, timeoutMs, containment },
        };
        this.#meta.put(prepared, meta(jail.cwd, denyWrite));
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
        const current = await readRegularFile(rooted(m.root, absPath), MAX_FILE_BYTES);
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
        const current = await readRegularFile(rooted(m.root, absPath), MAX_FILE_BYTES);
        if (current === null) throw new ToolError('not-found', `${m.display} does not exist`);
        const text = decodeText(m.display, current.bytes);
        if (call.args.oldString === call.args.newString) {
          throw new ToolError('invalid-args', 'oldString and newString are the same; the edit would change nothing');
        }
        const outcome = applySearchReplace(text, call.args.oldString, call.args.newString, call.args.replaceAll === true, MAX_FILE_BYTES);
        if (!outcome.ok) {
          // Nothing of the file's content is shown: the call is not authorized yet.
          if (outcome.kind === 'not-found') {
            throw new ToolError('not-found', `${m.display}: search text not found; read the file and write oldString from what is there`);
          }
          throw new ToolError(outcome.kind === 'too-large' ? 'tool-error' : 'invalid-args', `${m.display}: ${outcome.message}`);
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
            matchStrategy: STRATEGY[outcome.how],
            replacements: outcome.count,
          },
        };
        this.#meta.put(prepared, m);
        return prepared;
      }
      case 'grep': {
        const absRoot = await jail.resolveSearchRoot(call.args.path ?? '.');
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
        this.#meta.put(prepared, { ...meta(absRoot), searchTop: searchTop(jail.rootOf(absRoot) ?? jail.cwd, absRoot) });
        return prepared;
      }
      case 'glob': {
        const absRoot = await jail.resolveSearchRoot(call.args.path ?? '.');
        const st = await this.#assertExists(absRoot, call.args.path ?? '.');
        if (!st.isDirectory()) throw new ToolError('invalid-args', `glob path ${call.args.path ?? '.'} is not a directory`);
        normalizeGlob(call.args.pattern, absRoot);
        const effect = { absRoot, pattern: call.args.pattern, maxResults: call.args.maxResults ?? DEFAULT_GLOB_MAX_RESULTS };
        const prepared: PreparedCallOf<'glob'> = { id: call.id, tool: 'glob', args: { ...call.args, path: absRoot }, effect };
        this.#meta.put(prepared, { ...meta(absRoot), searchTop: searchTop(jail.rootOf(absRoot) ?? jail.cwd, absRoot) });
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

  /** What prepare recorded for the call; a call this runtime did not prepare (or already committed) is refused. */
  #metaOf(prepared: PreparedCall): CallMeta {
    const meta = this.#meta.take(prepared);
    if (meta === undefined) {
      throw new ToolError('tool-error', `this ${prepared.tool} call was not prepared by this tool runtime (or was already committed); prepare it again`);
    }
    return meta;
  }

  #searchTopOf(prepared: PreparedCall): SearchTop {
    const { searchTop: top } = this.#metaOf(prepared);
    if (top === undefined) throw new ToolError('tool-error', `this ${prepared.tool} call was not prepared by this tool runtime; prepare it again`);
    return top;
  }

  async commit(prepared: PreparedCall, signal: AbortSignal, tx?: Transaction): Promise<ToolResult> {
    try {
      return await this.#commit(prepared, signal, tx);
    } catch (err) {
      throw asToolError(err);
    }
  }

  async #commit(prepared: PreparedCall, signal: AbortSignal, tx?: Transaction): Promise<ToolResult> {
    if (signal.aborted) throw new ToolError('cancelled', 'the run was stopped before commit');
    switch (prepared.tool) {
      case 'bash': {
        const m = this.#metaOf(prepared);
        return runBash(prepared.effect, signal, {
          ...(this.#opts.bashOutputCapBytes !== undefined ? { outputCapBytes: this.#opts.bashOutputCapBytes } : {}),
          denyWrite: m.denyWrite,
        });
      }
      case 'read':
        return this.#commitRead(prepared, this.#metaOf(prepared).root);
      case 'write':
      case 'edit':
        return this.#commitWrite(prepared, signal, tx);
      case 'grep': {
        return runGrep(prepared.effect, this.#searchTopOf(prepared), signal, this.#opts.grepFileBudgetMs);
      }
      case 'glob': {
        return runGlob(prepared.effect, this.#searchTopOf(prepared), signal);
      }
    }
  }

  async #commitRead(prepared: PreparedCallOf<'read'>, root: string): Promise<ReadResult> {
    const { absPath, offset, limit } = prepared.effect;
    const file = await readRegularFile(rooted(root, absPath), MAX_FILE_BYTES);
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
    return { path: absPath, content: window.join('\n'), startLine: offset, totalLines: lines.length, truncated };
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
    const outcome = await atomicWrite(rooted(m.root, absPath), bytes, beforeHash === null ? { kind: 'absent' } : { kind: 'hash', sha256: beforeHash }, {
      signal,
      identity: m.identity,
      ...(tx
        ? {
            beforeWrite: (before: RegularFile | null, createdDirs: readonly string[]) => tx.record(absPath, m.root, before, createdDirs),
            onDirCreated: (dir: string, id: DirId, parent: DirId | undefined) => tx.dirCreated(dir, id, parent),
            beforeInstall: (install: InstallId, temp: string) => tx.installing(absPath, install, temp),
          }
        : {}),
    });
    await tx?.written(absPath, nextHash, outcome.id, outcome.dirId);
    if (prepared.tool === 'write') return { path: absPath, created: outcome.before === null, diff: prepared.effect.diff };
    return {
      path: absPath,
      replacements: prepared.effect.replacements,
      matchStrategy: prepared.effect.matchStrategy,
      diff: prepared.effect.diff,
    };
  }

  beginTransaction(): Transaction {
    return new FileTransaction(this.#opts.stateDir);
  }
}
