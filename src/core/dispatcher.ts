import { realpathSync } from 'node:fs';
import path from 'node:path';
import { ToolError, errorMessage } from './errors.js';
import { claimFile } from './file-claims.js';
import { frozenCopy } from './freeze.js';
import { findMatchingPattern } from './paths.js';
import { DecisionSchema, isMutating, parseToolCall } from './schemas.js';
import type {
  BashContainment,
  BashResult,
  BindingError,
  CallLogEntry,
  CallReply,
  Decision,
  DenySource,
  HostAdapter,
  PolicyLoadError,
  PolicySnapshot,
  PreparedCall,
  PreparedCallOf,
  SearchLowering,
  SessionContext,
  ToolCall,
  ToolResult,
  ToolRuntime,
  Transaction,
} from './types.js';

/** Why the dispatcher stopped accepting calls. */
export type StopReason = 'finished' | 'cancelled' | 'timeout' | 'denied';

export interface DispatcherOptions<P> {
  readonly adapter: HostAdapter<P>;
  readonly tools: ToolRuntime<P>;
  readonly ctx: SessionContext;
  readonly policy: PolicySnapshot<P> | PolicyLoadError;
  /** Journal of a transactional run; passed to every commit. */
  readonly transaction?: Transaction;
  /** Called once, on the first denied call. A transactional run aborts there. */
  readonly onDeny?: (entry: CallLogEntry) => void;
  /** Lets a run stop this dispatcher when its deadline has passed. */
  readonly checkDeadline?: () => void;
  /** Clock, for tests. */
  readonly now?: () => number;
}

type Failure =
  | { readonly kind: 'deny'; readonly source: DenySource; readonly reason: string }
  | { readonly kind: 'error'; readonly error: ToolError };

const ABORTED: unique symbol = Symbol('aborted');

const MAX_SUMMARY_CHARS = 160;

/** How long `stop` waits for in-flight calls before giving up on them. */
export const DEFAULT_SETTLE_GRACE_MS = 2_000;

function isPolicyError<P>(policy: PolicySnapshot<P> | PolicyLoadError): policy is PolicyLoadError {
  return 'error' in policy;
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function oneLine(s: string): string {
  return clip(s, MAX_SUMMARY_CHARS).replace(/\s*\n\s*/g, ' ⏎ ');
}

function containmentEquals(a: BashContainment, b: BashContainment): boolean {
  if (a.mode === 'none' || b.mode === 'none') return a.mode === b.mode;
  return (
    a.readOnly === b.readOnly &&
    a.network === b.network &&
    a.writableRoots.length === b.writableRoots.length &&
    a.writableRoots.every((root, i) => root === b.writableRoots[i])
  );
}

function boundFileMismatch(first: PreparedCall, second: PreparedCall): string | undefined {
  if ((first.tool !== 'write' && first.tool !== 'edit') || (second.tool !== 'write' && second.tool !== 'edit') || first.tool !== second.tool) {
    return 'hook bound its rewrite to a file version, but the call has no file effect';
  }
  if (second.effect.absPath !== first.effect.absPath) {
    return `hook rewrite changed the destination after the hook evaluated ${first.effect.absPath}`;
  }
  if (second.effect.beforeHash !== first.effect.beforeHash) {
    return `${first.effect.absPath} changed after the hook evaluated it; the rewrite was not applied`;
  }
  return undefined;
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.resolve(ABORTED);
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/**
 * Runs every binding call of one script through prepare → authorize → commit.
 *
 * Rules it enforces:
 * - ids `c1`, `c2`, ... in call order; args validated with `parseToolCall`.
 * - a policy load error denies every call with `unsupported-config`.
 * - `checkStatic` first (deny/ask short-circuit; hooks are not run), then
 *   `authorize`. `ask` becomes deny `ask-unavailable`. A throwing or malformed
 *   adapter becomes deny `hook-error`.
 * - `updatedArgs` are re-parsed, re-prepared and re-checked statically; a
 *   failure there is a deny (source `hook`). With `bindsPreparedFile`, the
 *   re-prepared write/edit must keep the first preparation's `absPath` and
 *   `beforeHash`, or it is denied (source `hook`) and nothing is committed.
 * - with `HostAdapter.lowerSearch`, a grep/glob is prepared, checked,
 *   authorized and committed as the exact bash command it lowers to, and
 *   its result is `parse` of that command's result. A failed lowering
 *   commits nothing; a hook rewrite of the lowered command is a deny
 *   (source `hook`); it does not count as a bash commit.
 * - write/edit on a protected path is refused even if the tool runtime missed
 *   it; a bash call whose containment differs from the policy is denied
 *   `containment-unavailable`.
 * - mutations (`bash`, `write`, `edit`) run one at a time, in call order;
 *   reads run concurrently.
 * - after `stop()` no call starts and no commit starts; a commit that was
 *   running when the run stopped is reported in `warnings`.
 */
export class Dispatcher<P = unknown> {
  readonly #opts: DispatcherOptions<P>;
  readonly #now: () => number;
  readonly #abort = new AbortController();
  #stopReason: StopReason | undefined;
  #nextId = 1;
  #mutationTail: Promise<unknown> = Promise.resolve();
  #journalWrite: Promise<void> | undefined;
  readonly #inflight = new Map<Promise<CallReply>, number>();
  /** id, tool and summary of each call by slot, for reporting calls that never settle. */
  readonly #labels: { id: string; tool: string; summary: string }[] = [];
  readonly #abandoned = new WeakSet<Promise<CallReply>>();
  readonly #calls: (CallLogEntry | undefined)[] = [];
  readonly #changed: string[] = [];
  readonly #diffs: string[] = [];
  readonly #warnings: string[] = [];
  #deniedCount = 0;
  #bashCommits = 0;
  readonly #realCwd: string;

  constructor(opts: DispatcherOptions<P>) {
    this.#opts = opts;
    this.#now = opts.now ?? (() => performance.now());
    this.#realCwd = realPathOrResolved(opts.ctx.cwd);
  }

  /** Signal aborted when the dispatcher stops. */
  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  /** Call log, in call order. */
  get calls(): readonly CallLogEntry[] {
    return this.#calls.filter((entry): entry is CallLogEntry => entry !== undefined);
  }

  /** Files written or edited by committed calls, in first-commit order. */
  get changedFiles(): readonly string[] {
    return [...this.#changed];
  }

  /** Combined diff of committed writes and edits, in commit order. */
  get diff(): string {
    return this.#diffs.join('');
  }

  get warnings(): readonly string[] {
    return [...this.#warnings];
  }

  get deniedCount(): number {
    return this.#deniedCount;
  }

  /** Number of `bash` calls that committed (their effects are never rolled back). */
  get bashCommits(): number {
    return this.#bashCommits;
  }

  get stopReason(): StopReason | undefined {
    return this.#stopReason;
  }

  /** Settles when the active journaled commit ends. */
  get pendingWrites(): Promise<void> | undefined {
    return this.#journalWrite;
  }

  /**
   * Handles one binding call from the script. Never rejects. `tool` and
   * `args` are untrusted.
   */
  dispatch(tool: unknown, args: unknown): Promise<CallReply> {
    const id = `c${this.#nextId++}`;
    const slot = this.#calls.length;
    this.#calls.push(undefined);
    const toolLabel = typeof tool === 'string' ? clip(tool, 40) : 'unknown';
    this.#labels.push({ id, tool: toolLabel, summary: toolLabel });
    const started = this.#now();

    let handled: Promise<CallReply>;
    try {
      handled = this.#handle(id, slot, toolLabel, tool, args, started);
    } catch (err) {
      handled = Promise.reject(err);
    }
    const reply = handled.catch((err: unknown) =>
      // Defensive: #handle catches everything it expects.
      this.#fail(slot, id, toolLabel, toolLabel, started, {
        kind: 'error',
        error: new ToolError('tool-error', `internal error: ${errorMessage(err)}`),
      }),
    );
    this.#inflight.set(reply, slot);
    void reply.finally(() => this.#inflight.delete(reply));
    return reply;
  }

  /**
   * Stops accepting calls, aborts in-flight ones and waits for them to
   * settle. Idempotent; the first reason wins.
   */
  async stop(reason: StopReason, graceMs: number = DEFAULT_SETTLE_GRACE_MS): Promise<void> {
    if (this.#stopReason === undefined) {
      this.#stopReason = reason;
      this.#abort.abort(reason);
    }
    const deadline = this.#now() + Math.max(0, graceMs);
    while (this.#inflight.size > 0) {
      const left = deadline - this.#now();
      let timer: NodeJS.Timeout | undefined;
      const expired = left <= 0
        ? Promise.resolve(true)
        : new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(true), left);
          });
      const settled = Promise.allSettled([...this.#inflight.keys()]).then(() => false);
      const timedOut = await Promise.race([settled, expired]);
      if (timer) clearTimeout(timer);
      if (timedOut) {
        for (const [pending, slot] of this.#inflight) {
          const label = this.#labels[slot];
          if (!label || this.#abandoned.has(pending)) continue;
          this.#abandoned.add(pending);
          this.#warnings.push(
            `${label.id} (${label.summary}) did not settle within ${graceMs} ms after the run stopped (${this.#stopReason ?? reason}); its effect is unknown.`,
          );
          this.#calls[slot] ??= { id: label.id, tool: label.tool, summary: label.summary, decision: 'error', reason: 'did not settle after the run stopped', durationMs: 0 };
        }
        return;
      }
    }
  }

  #hasStopped(): boolean {
    this.#opts.checkDeadline?.();
    return this.#stopReason !== undefined;
  }

  #handle(id: string, slot: number, toolLabel: string, tool: unknown, args: unknown, started: number): Promise<CallReply> {
    // Everything up to the mutation queue is synchronous so the queue keeps call order.
    if (this.#hasStopped()) {
      return Promise.resolve(this.#fail(slot, id, toolLabel, toolLabel, started, this.#stoppedFailure()));
    }
    const parsed = parseToolCall(tool, args, id);
    if (parsed instanceof ToolError) {
      return Promise.resolve(this.#fail(slot, id, toolLabel, toolLabel, started, { kind: 'error', error: parsed }));
    }
    const call = parsed;
    const summary = summarize(call, this.#opts.ctx.cwd);
    this.#labels[slot] = { id, tool: call.tool, summary };
    const policy = this.#opts.policy;
    if (isPolicyError(policy)) {
      return Promise.resolve(
        this.#fail(slot, id, call.tool, summary, started, {
          kind: 'deny',
          source: 'unsupported-config',
          reason: `host configuration could not be loaded: ${policy.error}`,
        }),
      );
    }
    const run = (): Promise<CallReply> => this.#pipeline(slot, call, summary, policy, started);
    if (!isMutating(call.tool)) return run();
    const queued = this.#mutationTail.then(run);
    this.#mutationTail = queued.catch(() => undefined);
    return queued;
  }

  async #pipeline(
    slot: number,
    call: ToolCall,
    summary: string,
    policy: PolicySnapshot<P>,
    started: number,
  ): Promise<CallReply> {
    const fail = (failure: Failure): CallReply => this.#fail(slot, call.id, call.tool, summary, started, failure);
    if (this.#hasStopped()) return fail(this.#stoppedFailure());

    const first = await this.#prepareChecked(call, policy);
    if ('kind' in first) return fail(first);
    let prepared = first.prepared;
    if (this.#hasStopped()) return fail(this.#stoppedFailure());

    let lowered: { readonly tool: 'grep' | 'glob'; readonly lowering: SearchLowering } | undefined;
    if ((prepared.tool === 'grep' || prepared.tool === 'glob') && this.#opts.adapter.lowerSearch) {
      const bash = await this.#lower(prepared, policy);
      if ('kind' in bash) return fail(bash);
      lowered = { tool: prepared.tool, lowering: bash.lowering };
      prepared = bash.prepared;
      if (this.#hasStopped()) return fail(this.#stoppedFailure());
    }

    const staticFailure = this.#checkStatic(prepared, policy);
    if (this.#hasStopped()) return fail(this.#stoppedFailure());
    if (staticFailure) return fail(staticFailure);

    const decision = await this.#authorize(prepared, policy);
    if (decision === ABORTED || this.#hasStopped()) return fail(this.#stoppedFailure());
    if (decision.kind === 'deny') return fail({ kind: 'deny', source: decision.source, reason: decision.reason });
    if (decision.kind === 'ask') {
      return fail({ kind: 'deny', source: 'ask-unavailable', reason: `host would ask the user and no interactive channel exists: ${decision.reason}` });
    }

    if (Object.hasOwn(decision, 'updatedArgs') && lowered !== undefined) {
      return fail({ kind: 'deny', source: 'hook', reason: `hook rewrote the command ${call.tool} runs as, which cannot be mapped back to ${call.tool}` });
    }
    if (Object.hasOwn(decision, 'updatedArgs')) {
      const reparsed = parseToolCall(call.tool, decision.updatedArgs, call.id);
      if (reparsed instanceof ToolError) {
        return fail({ kind: 'deny', source: 'hook', reason: `hook returned invalid updated input: ${reparsed.message}` });
      }
      const second = await this.#prepareChecked(reparsed, policy);
      if ('kind' in second) {
        const reason = second.kind === 'deny' ? second.reason : second.error.message;
        return fail({ kind: 'deny', source: second.kind === 'deny' ? second.source : 'hook', reason: `hook updated input was refused: ${reason}` });
      }
      if (decision.bindsPreparedFile === true) {
        const unbound = boundFileMismatch(prepared, second.prepared);
        if (unbound !== undefined) return fail({ kind: 'deny', source: 'hook', reason: unbound });
      }
      const recheck = this.#checkStatic(second.prepared, policy);
      if (recheck) return fail(recheck);
      prepared = second.prepared;
      summary = summarize(reparsed, this.#opts.ctx.cwd);
      this.#labels[slot] = { id: call.id, tool: call.tool, summary };
    }

    if (this.#hasStopped()) return fail(this.#stoppedFailure());
    return this.#commit(slot, prepared, summary, policy, started, lowered);
  }

  async #lower(
    search: PreparedCallOf<'grep'> | PreparedCallOf<'glob'>,
    policy: PolicySnapshot<P>,
  ): Promise<{ prepared: PreparedCall; lowering: SearchLowering } | Failure> {
    let lowering: SearchLowering;
    try {
      const returned: unknown = this.#opts.adapter.lowerSearch?.(search, this.#opts.ctx, policy);
      if (!isLowering(returned)) return { kind: 'deny', source: 'rule', reason: `the host adapter returned no shell form for ${search.tool}` };
      lowering = returned;
    } catch (err) {
      if (err instanceof ToolError) return { kind: 'error', error: err };
      return { kind: 'deny', source: 'rule', reason: `the host adapter failed to build the shell form of ${search.tool}: ${errorMessage(err)}` };
    }
    const bash = await this.#prepareChecked({ id: search.id, tool: 'bash', args: { command: lowering.command } }, policy);
    if ('kind' in bash) return bash;
    if (bash.prepared.tool !== 'bash' || bash.prepared.effect.command !== lowering.command) {
      return { kind: 'error', error: new ToolError('tool-error', `the tool runtime would not run the exact command ${search.tool} runs as`) };
    }
    return { prepared: bash.prepared, lowering };
  }

  async #prepareChecked(call: ToolCall, policy: PolicySnapshot<P>): Promise<{ prepared: PreparedCall } | Failure> {
    let prepared: PreparedCall;
    try {
      const pending = this.#opts.tools.prepare(call, this.#opts.ctx, policy);
      const returned = await raceAbort(pending, this.#abort.signal);
      if (returned === ABORTED) return this.#stoppedFailure();
      // A dispatcher-owned deep-frozen copy: what is authorized and then
      // committed cannot be changed by the runtime or anyone holding its object.
      prepared = frozenCopy(withRequestedPath(returned, call));
    } catch (err) {
      return this.#toolFailure(err);
    }
    if (prepared.id !== call.id || prepared.tool !== call.tool) {
      return { kind: 'error', error: new ToolError('tool-error', 'tool runtime returned a prepared call for another call') };
    }
    if (prepared.tool === 'write' || prepared.tool === 'edit') {
      const hit = findMatchingPattern(prepared.effect.absPath, policy.protectedPaths);
      if (hit !== undefined) {
        return { kind: 'error', error: new ToolError('protected-path', `${prepared.effect.absPath} is a protected host policy path`) };
      }
    }
    if (prepared.tool === 'bash' && !containmentEquals(prepared.effect.containment, policy.bashContainment)) {
      return { kind: 'deny', source: 'containment-unavailable', reason: 'bash containment does not match the host policy' };
    }
    return { prepared };
  }

  #checkStatic(prepared: PreparedCall, policy: PolicySnapshot<P>): Failure | undefined {
    try {
      const parsed = DecisionSchema.safeParse(this.#opts.adapter.checkStatic(prepared, this.#opts.ctx, policy));
      if (!parsed.success) return { kind: 'deny', source: 'rule', reason: 'permission rule check returned an invalid decision' };
      const decision = parsed.data;
      if (decision.kind === 'deny') return { kind: 'deny', source: decision.source, reason: decision.reason };
      if (decision.kind === 'ask') {
        return { kind: 'deny', source: 'ask-unavailable', reason: `host would ask the user and no interactive channel exists: ${decision.reason}` };
      }
    } catch (err) {
      return { kind: 'deny', source: 'rule', reason: `permission rule check failed: ${errorMessage(err)}` };
    }
    // A static allow never carries updated args; ignore any.
    return undefined;
  }

  async #authorize(prepared: PreparedCall, policy: PolicySnapshot<P>): Promise<Decision | typeof ABORTED> {
    const signal = this.#abort.signal;
    let pending: Promise<unknown>;
    try {
      pending = Promise.resolve(this.#opts.adapter.authorize(prepared, this.#opts.ctx, policy, signal));
    } catch (err) {
      pending = Promise.reject(err);
    }
    try {
      const decision = await raceAbort(pending, signal);
      if (decision === ABORTED) return ABORTED;
      const parsed = DecisionSchema.safeParse(decision);
      return parsed.success ? parsed.data : { kind: 'deny', source: 'hook-error', reason: 'hook adapter returned an invalid decision' };
    } catch (err) {
      if (signal.aborted) return ABORTED;
      return { kind: 'deny', source: 'hook-error', reason: `hook failed: ${errorMessage(err)}` };
    }
  }

  async #commit(
    slot: number,
    prepared: PreparedCall,
    summary: string,
    policy: PolicySnapshot<P>,
    started: number,
    lowered?: { readonly tool: 'grep' | 'glob'; readonly lowering: SearchLowering },
  ): Promise<CallReply> {
    const signal = this.#abort.signal;
    const tool = lowered?.tool ?? prepared.tool;
    const transaction = this.#opts.transaction;
    const journaled = transaction !== undefined && (prepared.tool === 'write' || prepared.tool === 'edit');
    if (journaled && !claimFile(transaction, prepared.effect.absPath)) {
      const error = new ToolError('tool-error', `${prepared.effect.absPath} is being changed by another transactional run that has not finished; retry once it ends`);
      return this.#fail(slot, prepared.id, tool, summary, started, { kind: 'error', error });
    }
    let result: ToolResult;
    try {
      const pending = this.#opts.tools.commit(prepared, signal, transaction);
      if (journaled) this.#journalWrite = pending.then(() => undefined, () => undefined);
      result = await pending;
    } catch (err) {
      if (signal.aborted) {
        this.#warnings.push(
          `${prepared.id} (${summary}) was committing when the run stopped (${this.#stopReason ?? 'stopped'}) and then failed: ${errorMessage(err)}. Its effect may be partial.`,
        );
        if (prepared.tool === 'write' || prepared.tool === 'edit') this.#addChanged(prepared.effect.absPath);
      }
      return this.#fail(slot, prepared.id, tool, summary, started, this.#toolFailure(err));
    } finally {
      if (journaled) this.#journalWrite = undefined;
    }

    if (signal.aborted) {
      this.#warnings.push(
        `${prepared.id} (${summary}) was committing when the run stopped (${this.#stopReason ?? 'stopped'}); its effect was applied.`,
      );
    }
    if (prepared.tool === 'write' || prepared.tool === 'edit') {
      this.#addChanged(prepared.effect.absPath);
      const diff = 'diff' in result && typeof result.diff === 'string' ? result.diff : prepared.effect.diff;
      this.#diffs.push(diff.endsWith('\n') || diff === '' ? diff : `${diff}\n`);
    } else if (prepared.tool === 'bash' && lowered === undefined) {
      this.#bashCommits++;
    }
    let value: ToolResult = result;
    if (lowered !== undefined) {
      if (!isBashResult(result)) return this.#fail(slot, prepared.id, tool, summary, started, { kind: 'error', error: new ToolError('tool-error', 'the tool runtime returned no bash result') });
      try {
        value = lowered.lowering.parse(result);
      } catch (err) {
        return this.#fail(slot, prepared.id, tool, summary, started, this.#toolFailure(err));
      }
    }

    const post = this.#opts.adapter.postToolUse;
    if (post) {
      try {
        const done = await raceAbort(Promise.resolve(post.call(this.#opts.adapter, prepared, result, this.#opts.ctx, policy, this.#abort.signal)), this.#abort.signal);
        if (done === ABORTED) this.#warnings.push(`PostToolUse hooks for ${prepared.id} (${summary}) were abandoned when the run stopped.`);
      } catch (err) {
        this.#warnings.push(`PostToolUse hooks failed for ${prepared.id} (${summary}): ${errorMessage(err)}`);
      }
    }

    this.#calls[slot] = { id: prepared.id, tool, summary, decision: 'allowed', durationMs: this.#elapsed(started) };
    return { ok: true, value };
  }

  #toolFailure(err: unknown): Failure {
    if (err instanceof ToolError) {
      if (err.code === 'containment-unavailable') {
        return { kind: 'deny', source: 'containment-unavailable', reason: err.message };
      }
      return { kind: 'error', error: err };
    }
    if (this.#abort.signal.aborted) return this.#stoppedFailure();
    return { kind: 'error', error: new ToolError('tool-error', errorMessage(err)) };
  }

  #stoppedFailure(): Failure {
    const reason = this.#stopReason ?? 'finished';
    const message =
      reason === 'finished'
        ? 'the script already finished; calls made after it returned are refused'
        : `the run was stopped (${reason}); the call was not executed`;
    return { kind: 'error', error: new ToolError('cancelled', message) };
  }

  #fail(slot: number, id: string, tool: string, summary: string, started: number, failure: Failure): CallReply {
    let error: BindingError;
    let entry: CallLogEntry;
    const durationMs = this.#elapsed(started);
    if (failure.kind === 'deny') {
      error = { name: 'PermissionDenied', code: 'denied', source: failure.source, message: failure.reason };
      entry = { id, tool, summary, decision: 'denied', reason: `${failure.source}: ${failure.reason}`, durationMs };
    } else {
      const code = failure.error.code === 'containment-unavailable' ? 'tool-error' : failure.error.code;
      error = { name: 'ToolError', code, message: failure.error.message };
      entry = { id, tool, summary, decision: 'error', reason: failure.error.message, durationMs };
    }
    this.#calls[slot] = entry;
    if (failure.kind === 'deny') {
      this.#deniedCount++;
      if (this.#deniedCount === 1 && this.#opts.onDeny) {
        try {
          this.#opts.onDeny(entry);
        } catch {
          // The callback is internal; a failure must not change the reply.
        }
      }
    }
    return { ok: false, error };
  }

  #addChanged(absPath: string): void {
    const shown = displayPath(absPath, this.#realCwd);
    if (!this.#changed.includes(shown)) this.#changed.push(shown);
  }

  #elapsed(started: number): number {
    return Math.max(0, Math.round(this.#now() - started));
  }
}

function isBashResult(r: ToolResult): r is BashResult {
  return 'stdout' in r && 'exitCode' in r;
}

function isLowering(v: unknown): v is SearchLowering {
  return typeof v === 'object' && v !== null && 'command' in v && typeof v.command === 'string' && v.command !== '' && 'parse' in v && typeof v.parse === 'function';
}

function realPathOrResolved(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

function withRequestedPath(prepared: PreparedCall, call: ToolCall): PreparedCall {
  const { requestedPath: _fromRuntime, ...rest } = prepared;
  const requested = call.tool === 'bash' ? undefined : call.args.path;
  return requested === undefined ? rest : { ...rest, requestedPath: requested };
}

/** Path relative to `cwd` when inside it, else the absolute path. */
export function displayPath(absPath: string, cwd: string): string {
  const rel = path.relative(cwd, absPath);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : absPath;
}

/** Short description of a call for the call log. */
export function summarize(call: ToolCall, cwd: string): string {
  const p = (value: string): string => displayPath(path.resolve(cwd, value), cwd);
  let s: string;
  switch (call.tool) {
    case 'bash':
      s = `bash ${oneLine(call.args.command)}`;
      break;
    case 'read':
    case 'write':
    case 'edit':
      s = `${call.tool} ${p(call.args.path)}`;
      break;
    case 'grep':
      s = `grep ${JSON.stringify(call.args.pattern)}${call.args.path ? ` in ${p(call.args.path)}` : ''}`;
      break;
    case 'glob':
      s = `glob ${call.args.pattern}${call.args.path ? ` in ${p(call.args.path)}` : ''}`;
      break;
  }
  return clip(s, MAX_SUMMARY_CHARS);
}
