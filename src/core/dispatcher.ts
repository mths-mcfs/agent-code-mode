import { realpathSync } from 'node:fs';
import path from 'node:path';
import { ToolError, errorMessage } from './errors.js';
import { frozenCopy } from './freeze.js';
import { findMatchingPattern, workspaceDisplayPath } from './paths.js';
import { UndoArgsSchema, formatIssues, isMutating, parseToolCall } from './schemas.js';
import type {
  BashContainment,
  BindingCall,
  BindingError,
  CallLogEntry,
  CallReply,
  CommitObserver,
  Decision,
  DenySource,
  HostAdapter,
  HostCall,
  HostResult,
  McpRuntime,
  PolicyLoadError,
  PolicySnapshot,
  PreparedCall,
  ScriptValue,
  SessionContext,
  ToolCall,
  ToolResult,
  ToolRuntime,
  Transaction,
  RunUndo,
  UndoResult,
  UndoSession,
  UndoSkip,
  UndoStep,
} from './types.js';

/** Why the dispatcher stopped accepting calls. */
export type StopReason = 'finished' | 'cancelled' | 'timeout' | 'denied';

export interface DispatcherOptions<P> {
  readonly adapter: HostAdapter<P>;
  readonly tools: ToolRuntime<P>;
  readonly ctx: SessionContext;
  readonly policy: PolicySnapshot<P> | PolicyLoadError;
  /** Serves `mcpCall` (binding `mcp`). Without it every `mcpCall` fails: no upstream servers are configured. */
  readonly mcp?: McpRuntime;
  /** Journal of a transactional run; passed to every commit. */
  readonly transaction?: Transaction;
  /** Records what this run's writes and edits replace, for a later `undo`. */
  readonly undo?: RunUndo;
  /** Called once, on the first denied call. A transactional run aborts there. */
  readonly onDeny?: (entry: CallLogEntry) => void;
  /** Clock, for tests. */
  readonly now?: () => number;
}

type Failure =
  | { readonly kind: 'deny'; readonly source: DenySource; readonly reason: string }
  | { readonly kind: 'error'; readonly error: ToolError };

const ABORTED: unique symbol = Symbol('aborted');

const MAX_SUMMARY_CHARS = 160;

/** Binding name of `mcpCall` on the wire from the sandbox. */
export const MCP_BINDING = 'mcp';

/** Binding name of `undo(undoId)`. */
export const UNDO_BINDING = 'undo';

/** How long `stop` waits for in-flight calls before giving up on them. */
export const DEFAULT_SETTLE_GRACE_MS = 2_000;

function isPolicyError<P>(policy: PolicySnapshot<P> | PolicyLoadError): policy is PolicyLoadError {
  return 'error' in policy;
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function oneLine(s: string): string {
  return s.replace(/\s*\n\s*/g, ' ⏎ ');
}

/** Whether the real path `target` is `base` or below it. */
function isInside(base: string, target: string): boolean {
  const fold = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);
  const rel = path.relative(fold(base), fold(target));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
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

/** Fail-closed shape check of a decision coming from an adapter. */
function isDecision(value: unknown): value is Decision {
  if (value === null || typeof value !== 'object' || !('kind' in value)) return false;
  const kind: unknown = value.kind;
  if (kind === 'allow') return true;
  if (kind === 'ask') return 'reason' in value && typeof value.reason === 'string';
  if (kind === 'deny') {
    return 'reason' in value && typeof value.reason === 'string' && 'source' in value && typeof value.source === 'string';
  }
  return false;
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
 *   failure there is a deny (source `hook`).
 * - write/edit on a protected path is refused even if the tool runtime missed
 *   it; a bash call whose containment differs from the policy is denied
 *   `containment-unavailable`.
 * - mutations (`bash`, `write`, `edit`) and `mcpCall`s run one at a time,
 *   in call order; reads run concurrently.
 * - an `mcpCall` is parsed against the MCP runtime's catalog; a hook rewrite
 *   may change its input, never its server or tool.
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
  readonly #inflight = new Map<Promise<CallReply>, number>();
  /** id, tool and summary of each call by slot, for reporting calls that never settle. */
  readonly #labels: { id: string; tool: string; summary: string }[] = [];
  readonly #abandoned = new WeakSet<Promise<CallReply>>();
  readonly #calls: (CallLogEntry | undefined)[] = [];
  readonly #changed: string[] = [];
  readonly #diffs: string[] = [];
  readonly #warnings: string[] = [];
  /** Handed to every commit: what the tool runtime reports besides results (protected-path changes) lands in `warnings`. */
  readonly #observer: CommitObserver;
  #deniedCount = 0;
  #bashStarted = 0;
  #mcpSent = 0;
  /** The session cwd and roots as real paths, the form prepared paths take. */
  readonly #canonicalCwd: string;
  readonly #canonicalRoots: readonly string[];

  constructor(opts: DispatcherOptions<P>) {
    this.#opts = opts;
    this.#observer = { warn: (message) => this.#warnings.push(message), bashStarted: () => void this.#bashStarted++, ...(opts.undo ? { undo: opts.undo } : {}) };
    this.#now = opts.now ?? (() => performance.now());
    this.#canonicalCwd = canonicalPath(opts.ctx.cwd);
    this.#canonicalRoots = [...new Set([...opts.ctx.roots, ...(isPolicyError(opts.policy) ? [] : (opts.policy.additionalRoots ?? []))])].map(canonicalPath);
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

  /**
   * The tool runtime's end-of-run check of the protected paths (after the
   * last bash call), reported in `warnings`. Call once, after `stop`.
   */
  async finishRun(): Promise<void> {
    const finish = this.#opts.tools.finishRun;
    if (finish === undefined) return;
    try {
      await finish.call(this.#opts.tools, this.#observer);
    } catch (err) {
      this.#warnings.push(`protected path check incomplete at the end of the run: ${errorMessage(err)}`);
    }
  }

  get deniedCount(): number {
    return this.#deniedCount;
  }

  /** Number of `bash` calls that started, finished or not (their effects are never rolled back). */
  get bashCallsStarted(): number {
    return this.#bashStarted;
  }

  /** Number of `mcpCall`s sent upstream, whatever their outcome (their effects are never rolled back). */
  get mcpCallsSent(): number {
    return this.#mcpSent;
  }

  get stopReason(): StopReason | undefined {
    return this.#stopReason;
  }

  /**
   * Handles one binding call from the script. Never rejects. `tool` and
   * `args` are untrusted.
   */
  dispatch(tool: unknown, args: unknown): Promise<CallReply> {
    const id = `c${this.#nextId++}`;
    const slot = this.#calls.length;
    this.#calls.push(undefined);
    this.#labels.push({ id, tool: typeof tool === 'string' ? clip(tool, 40) : 'unknown', summary: typeof tool === 'string' ? clip(tool, 40) : 'unknown' });
    const started = this.#now();
    const toolLabel = clip(typeof tool === 'string' ? tool : String(tool), 40);

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

  #handle(id: string, slot: number, toolLabel: string, tool: unknown, args: unknown, started: number): Promise<CallReply> {
    // Everything up to the mutation queue is synchronous so the queue keeps call order.
    if (this.#stopReason !== undefined) {
      return Promise.resolve(this.#fail(slot, id, toolLabel, toolLabel, started, this.#stoppedFailure()));
    }
    if (tool === UNDO_BINDING) return this.#handleUndo(id, slot, args, started);
    const parsed = this.#parse(typeof tool === 'string' ? tool : String(tool), args, id);
    if (parsed instanceof ToolError) {
      return Promise.resolve(this.#fail(slot, id, toolLabel, toolLabel, started, { kind: 'error', error: parsed }));
    }
    const call = parsed;
    const summary = summarize(call, this.#opts.ctx.cwd);
    const label = callLabel(call);
    this.#labels[slot] = { id, tool: label, summary };
    const policy = this.#opts.policy;
    if (isPolicyError(policy)) {
      return Promise.resolve(
        this.#fail(slot, id, label, summary, started, {
          kind: 'deny',
          source: 'unsupported-config',
          reason: `host configuration could not be loaded: ${policy.error}`,
        }),
      );
    }
    const run = (): Promise<CallReply> => this.#pipeline(slot, call, summary, policy, started);
    // An mcpCall is an external effect, like bash: serialized with the mutations, in call order.
    if (call.tool !== 'mcp' && !isMutating(call.tool)) return run();
    const queued = this.#mutationTail.then(run);
    this.#mutationTail = queued.catch(() => undefined);
    return queued;
  }

  /** Queues an `undo`: it changes files, so it runs in call order with the other mutations. */
  #handleUndo(id: string, slot: number, args: unknown, started: number): Promise<CallReply> {
    const parsed = UndoArgsSchema.safeParse(args);
    if (!parsed.success) {
      return Promise.resolve(this.#fail(slot, id, UNDO_BINDING, UNDO_BINDING, started, { kind: 'error', error: new ToolError('invalid-args', `undo: ${formatIssues(parsed.error)}`) }));
    }
    const { undoId } = parsed.data;
    const summary = clip(`undo ${undoId}`, MAX_SUMMARY_CHARS);
    this.#labels[slot] = { id, tool: UNDO_BINDING, summary };
    const policy = this.#opts.policy;
    if (isPolicyError(policy)) {
      return Promise.resolve(this.#fail(slot, id, UNDO_BINDING, summary, started, { kind: 'deny', source: 'unsupported-config', reason: `host configuration could not be loaded: ${policy.error}` }));
    }
    const queued = this.#mutationTail.then(() => this.#undo(slot, id, undoId, summary, policy, started));
    this.#mutationTail = queued.catch(() => undefined);
    return queued;
  }

  /**
   * Undoes a finished run: every step is authorized as the `write` or `bash`
   * call that makes it before any file is touched, and one refusal ends the
   * undo with nothing changed. The files stay reserved until the end.
   */
  async #undo(slot: number, id: string, undoId: string, summary: string, policy: PolicySnapshot<P>, started: number): Promise<CallReply> {
    const fail = (failure: Failure): CallReply => this.#fail(slot, id, UNDO_BINDING, summary, started, failure);
    if (this.#stopReason !== undefined) return fail(this.#stoppedFailure());
    if (this.#opts.transaction !== undefined) {
      return fail({ kind: 'error', error: new ToolError('invalid-args', 'undo is not available in a run with transaction: true') });
    }
    const tools = this.#opts.tools;
    if (tools.openUndo === undefined) return fail({ kind: 'error', error: new ToolError('not-found', 'undo: this server keeps no undo records') });
    let session: UndoSession;
    try {
      session = await tools.openUndo(undoId, this.#opts.ctx, policy);
    } catch (err) {
      return fail(this.#toolFailure(err));
    }
    let used = false;
    try {
      const diffs = new Map<UndoStep, string>();
      for (const [i, step] of session.steps.entries()) {
        const outcome = await this.#authorizeUndoStep(step, `${id}.${i + 1}`, policy);
        if (typeof outcome !== 'string') return fail(undoRefusal(step, outcome));
        diffs.set(step, outcome);
      }
      if (this.#stopReason !== undefined) return fail(this.#stoppedFailure());
      used = true;
      const value = await this.#applyUndo(session, diffs);
      this.#calls[slot] = { id, tool: UNDO_BINDING, summary, decision: 'allowed', durationMs: this.#elapsed(started) };
      return { ok: true, value };
    } finally {
      await session.close(used);
    }
  }

  /** Makes the authorized steps. A file that changed since the plan is reported and left alone; the rest still go on. */
  async #applyUndo(session: UndoSession, diffs: ReadonlyMap<UndoStep, string>): Promise<UndoResult> {
    const restored: string[] = [];
    const removed: string[] = [];
    const removedDirs: string[] = [];
    const skipped: UndoSkip[] = [...session.skipped];
    for (const step of session.steps) {
      if (this.#abort.signal.aborted) {
        skipped.push({ path: step.path, reason: 'the run stopped before this step' });
        continue;
      }
      try {
        await session.apply(step, this.#abort.signal);
      } catch (err) {
        skipped.push({ path: step.path, reason: errorMessage(err) });
        continue;
      }
      if (step.kind === 'rmdir') removedDirs.push(step.path);
      else this.#addChanged(step.path);
      if (step.kind === 'remove') removed.push(step.path);
      if (step.kind === 'restore') {
        restored.push(step.path);
        const diff = diffs.get(step) ?? '';
        this.#diffs.push(diff.endsWith('\n') || diff === '' ? diff : `${diff}\n`);
      }
    }
    const shown = (p: string): string => displayPath(p, this.#canonicalCwd);
    return {
      restored: restored.map(shown),
      removed: removed.map(shown),
      removedDirs: removedDirs.map(shown),
      skipped: skipped.map((s) => ({ path: shown(s.path), reason: s.reason })),
      bashCalls: session.bashCalls,
      mcpCalls: session.mcpCalls,
    };
  }

  /**
   * Puts one undo step through the same checks as a call of the script. Resolves
   * to the diff of the step, or to why it may not be made. A hook may rewrite a
   * step only into the very same effect.
   */
  async #authorizeUndoStep(step: UndoStep, callId: string, policy: PolicySnapshot<P>): Promise<string | Failure> {
    const call = parseToolCall(step.call.tool, step.call.args, callId);
    if (call instanceof ToolError) return { kind: 'error', error: call };
    const first = await this.#prepareChecked(call, policy);
    if ('kind' in first) return first;
    const prepared = first.prepared;
    if (step.kind !== 'restore') {
      // The step runs here, not in the command's sandbox: what the sandbox would refuse is refused now.
      const refused = this.#removalRefused(step.path, policy);
      if (refused) return refused;
    }
    const denied = (await this.#checkResolved(prepared, policy)) ?? this.#checkStatic(prepared, policy);
    if (denied) return denied;
    const decision = await this.#authorize(prepared, policy);
    if (decision === ABORTED || this.#stopReason !== undefined) return this.#stoppedFailure();
    if (decision.kind === 'deny') return { kind: 'deny', source: decision.source, reason: decision.reason };
    if (decision.kind === 'ask') return { kind: 'deny', source: 'ask-unavailable', reason: `host would ask the user and no interactive channel exists: ${decision.reason}` };
    if (decision.updatedArgs !== undefined) {
      const incompatible: Failure = { kind: 'deny', source: 'hook', reason: 'a hook rewrote this step into a different change' };
      const reparsed = parseToolCall(call.tool, decision.updatedArgs, callId);
      if (reparsed instanceof ToolError) return incompatible;
      const second = await this.#prepareChecked(reparsed, policy);
      if ('kind' in second || !sameEffect(prepared, second.prepared)) return incompatible;
    }
    return prepared.tool === 'write' ? prepared.effect.diff : '';
  }

  /** Why a file or directory may not be removed: a protected path, or outside what the bash containment can write. */
  #removalRefused(target: string, policy: PolicySnapshot<P>): Failure | undefined {
    if (findMatchingPattern(target, this.#protectedPatterns(policy)) !== undefined && !this.#inScratch(target, policy)) {
      return { kind: 'error', error: new ToolError('protected-path', `${target} is a protected host policy path`) };
    }
    const containment = policy.bashContainment;
    if (containment.mode === 'none') return undefined;
    if (!containment.readOnly && containment.writableRoots.some((root) => isInside(canonicalPath(root), target))) return undefined;
    return { kind: 'deny', source: 'containment-unavailable', reason: `${target} is outside what the bash containment may write` };
  }

  /** Whether the real path `abs` is inside the scratch directory this policy opened. */
  #inScratch(abs: string, policy: PolicySnapshot<P>): boolean {
    return policy.scratchRoot !== undefined && isInside(policy.scratchRoot, abs);
  }

  /** Validates an untrusted call: a built-in binding, or `mcpCall` against the MCP catalog. */
  #parse(tool: string, args: unknown, id: string): BindingCall | ToolError {
    if (tool !== MCP_BINDING) return parseToolCall(tool, args, id);
    const mcp = this.#opts.mcp;
    if (mcp === undefined) return new ToolError('invalid-args', 'mcpCall: no upstream MCP servers are configured for this server (serve --mcp-config)');
    let parsed: ReturnType<McpRuntime['parse']>;
    try {
      parsed = mcp.parse(args, id);
    } catch (err) {
      return new ToolError('invalid-args', `mcpCall: ${errorMessage(err)}`);
    }
    return parsed.ok ? parsed.call : new ToolError('invalid-args', `mcpCall: ${parsed.message}`);
  }

  async #pipeline(
    slot: number,
    call: BindingCall,
    summary: string,
    policy: PolicySnapshot<P>,
    started: number,
  ): Promise<CallReply> {
    const label = callLabel(call);
    const fail = (failure: Failure): CallReply => this.#fail(slot, call.id, label, summary, started, failure);
    if (this.#stopReason !== undefined) return fail(this.#stoppedFailure());

    const first = await this.#prepareChecked(call, policy);
    if ('kind' in first) return fail(first);
    let prepared = first.prepared;
    if (this.#stopReason !== undefined) return fail(this.#stoppedFailure());

    const resolvedFailure = await this.#checkResolved(prepared, policy);
    if (resolvedFailure) return fail(resolvedFailure);
    const staticFailure = this.#checkStatic(prepared, policy);
    if (staticFailure) return fail(staticFailure);

    const decision = await this.#authorize(prepared, policy);
    if (decision === ABORTED || this.#stopReason !== undefined) return fail(this.#stoppedFailure());
    if (decision.kind === 'deny') return fail({ kind: 'deny', source: decision.source, reason: decision.reason });
    if (decision.kind === 'ask') {
      return fail({ kind: 'deny', source: 'ask-unavailable', reason: `host would ask the user and no interactive channel exists: ${decision.reason}` });
    }

    if (decision.updatedArgs !== undefined) {
      const reparsed = this.#parse(call.tool, decision.updatedArgs, call.id);
      if (reparsed instanceof ToolError) {
        return fail({ kind: 'deny', source: 'hook', reason: `hook returned invalid updated input: ${reparsed.message}` });
      }
      // A hook may change a call's input, never which tool it calls.
      if (reparsed.tool !== call.tool || (reparsed.tool === 'mcp' && call.tool === 'mcp' && (reparsed.args.server !== call.args.server || reparsed.args.tool !== call.args.tool))) {
        return fail({ kind: 'deny', source: 'hook', reason: 'hook updated input names another tool' });
      }
      const second = await this.#prepareChecked(reparsed, policy);
      if ('kind' in second) {
        const reason = second.kind === 'deny' ? second.reason : second.error.message;
        return fail({ kind: 'deny', source: second.kind === 'deny' ? second.source : 'hook', reason: `hook updated input was refused: ${reason}` });
      }
      const recheck = (await this.#checkResolved(second.prepared, policy)) ?? this.#checkStatic(second.prepared, policy);
      if (recheck) return fail(recheck);
      prepared = second.prepared;
      if (this.#stopReason !== undefined) return fail(this.#stoppedFailure());
    }

    return this.#commit(slot, prepared, summary, policy, started);
  }

  async #prepareChecked(call: BindingCall, policy: PolicySnapshot<P>): Promise<{ prepared: HostCall } | Failure> {
    if (call.tool === 'mcp') return this.#prepareMcp(call);
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
      const hit = this.#inScratch(prepared.effect.absPath, policy) ? undefined : findMatchingPattern(prepared.effect.absPath, this.#protectedPatterns(policy));
      if (hit !== undefined) {
        return { kind: 'error', error: new ToolError('protected-path', `${prepared.effect.absPath} is a protected host policy path`) };
      }
    }
    if (prepared.tool === 'bash' && !containmentEquals(prepared.effect.containment, policy.bashContainment)) {
      return { kind: 'deny', source: 'containment-unavailable', reason: 'bash containment does not match the host policy' };
    }
    return { prepared };
  }

  #prepareMcp(call: Extract<BindingCall, { tool: 'mcp' }>): { prepared: HostCall } | Failure {
    const mcp = this.#opts.mcp;
    if (mcp === undefined) return { kind: 'error', error: new ToolError('invalid-args', 'mcpCall: no upstream MCP servers are configured') };
    let prepared: HostCall;
    try {
      prepared = frozenCopy(mcp.prepare(call));
    } catch (err) {
      return this.#toolFailure(err);
    }
    // The effect must be the very call that was validated: same id, server, tool and input.
    if (
      prepared.tool !== 'mcp' ||
      prepared.id !== call.id ||
      prepared.effect.server !== call.args.server ||
      prepared.effect.tool !== call.args.tool ||
      JSON.stringify(prepared.effect.input) !== JSON.stringify(call.args.input)
    ) {
      return { kind: 'error', error: new ToolError('tool-error', 'MCP runtime returned a prepared call for another call') };
    }
    return { prepared };
  }

  /** The adapter's refusals that need I/O, before the static rules. */
  async #checkResolved(prepared: HostCall, policy: PolicySnapshot<P>): Promise<Failure | undefined> {
    const adapter = this.#opts.adapter;
    if (adapter.checkResolved === undefined) return undefined;
    let decision: unknown;
    try {
      decision = await raceAbort(Promise.resolve(adapter.checkResolved(prepared, this.#opts.ctx, policy)), this.#abort.signal);
    } catch (err) {
      return { kind: 'deny', source: 'rule', reason: `permission check failed: ${errorMessage(err)}` };
    }
    if (decision === ABORTED) return this.#stoppedFailure();
    if (decision === undefined) return undefined;
    if (!isDecision(decision) || decision.kind !== 'deny') return { kind: 'deny', source: 'rule', reason: 'permission check returned an invalid decision' };
    return { kind: 'deny', source: decision.source, reason: decision.reason };
  }

  #checkStatic(prepared: HostCall, policy: PolicySnapshot<P>): Failure | undefined {
    let decision: unknown;
    try {
      decision = this.#opts.adapter.checkStatic(prepared, this.#opts.ctx, policy);
    } catch (err) {
      return { kind: 'deny', source: 'rule', reason: `permission rule check failed: ${errorMessage(err)}` };
    }
    if (!isDecision(decision)) return { kind: 'deny', source: 'rule', reason: 'permission rule check returned an invalid decision' };
    if (decision.kind === 'deny') return { kind: 'deny', source: decision.source, reason: decision.reason };
    if (decision.kind === 'ask') {
      return { kind: 'deny', source: 'ask-unavailable', reason: `host would ask the user and no interactive channel exists: ${decision.reason}` };
    }
    // A static allow never carries updated args; ignore any.
    return undefined;
  }

  async #authorize(prepared: HostCall, policy: PolicySnapshot<P>): Promise<Decision | typeof ABORTED> {
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
      if (!isDecision(decision)) return { kind: 'deny', source: 'hook-error', reason: 'hook adapter returned an invalid decision' };
      return decision;
    } catch (err) {
      if (signal.aborted) return ABORTED;
      return { kind: 'deny', source: 'hook-error', reason: `hook failed: ${errorMessage(err)}` };
    }
  }

  async #commit(
    slot: number,
    prepared: HostCall,
    summary: string,
    policy: PolicySnapshot<P>,
    started: number,
  ): Promise<CallReply> {
    const signal = this.#abort.signal;
    const label = callLabel(prepared);
    let result: HostResult;
    const startedBefore = this.#bashStarted;
    try {
      if (prepared.tool === 'mcp') {
        const mcp = this.#opts.mcp;
        if (mcp === undefined) throw new ToolError('tool-error', 'mcpCall: no upstream MCP servers are configured');
        if (signal.aborted) throw new ToolError('cancelled', 'the run was stopped; the call was not sent');
        // Counted when the request reaches the server, not before: a call refused unsent had no effect.
        result = await mcp.commit(prepared, signal, () => {
          this.#mcpSent++;
        });
      } else {
        result = await this.#opts.tools.commit(prepared, signal, this.#opts.transaction, this.#observer);
      }
    } catch (err) {
      if (signal.aborted) {
        this.#warnings.push(
          `${prepared.id} (${summary}) was committing when the run stopped (${this.#stopReason ?? 'stopped'}) and then failed: ${errorMessage(err)}. Its effect may be partial.`,
        );
        if ((prepared.tool === 'write' || prepared.tool === 'edit') && !this.#inScratch(prepared.effect.absPath, policy)) this.#addChanged(prepared.effect.absPath);
      }
      return this.#fail(slot, prepared.id, label, summary, started, this.#toolFailure(err));
    }

    if (signal.aborted) {
      this.#warnings.push(
        `${prepared.id} (${summary}) was committing when the run stopped (${this.#stopReason ?? 'stopped'}); its effect was applied.`,
      );
    }
    if ((prepared.tool === 'write' || prepared.tool === 'edit') && this.#inScratch(prepared.effect.absPath, policy)) {
      // A scratch file is throwaway: not a change of the workspace.
    } else if (prepared.tool === 'write' || prepared.tool === 'edit') {
      this.#addChanged(prepared.effect.absPath);
      const diff = 'diff' in result && typeof result.diff === 'string' ? result.diff : prepared.effect.diff;
      this.#diffs.push(diff.endsWith('\n') || diff === '' ? diff : `${diff}\n`);
    } else if (prepared.tool === 'bash' && this.#bashStarted === startedBefore) {
      // A tool runtime that does not report the start: the call ran, since it returned a result.
      this.#bashStarted++;
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

    this.#calls[slot] = { id: prepared.id, tool: label, summary, decision: 'allowed', durationMs: this.#elapsed(started) };
    return { ok: true, value: 'isError' in result ? result : scriptResult(result, this.#canonicalCwd) };
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

  /**
   * Protected patterns as written by the adapter plus the same patterns with
   * a cwd or root prefix rewritten to its real path: prepared paths are real
   * paths, so a cwd reached through a symlink must not let a write slip past
   * a pattern spelled with the symlinked cwd.
   */
  #protectedPatterns(policy: PolicySnapshot<P>): readonly string[] {
    if (this.#protectedCache?.policy === policy) return this.#protectedCache.patterns;
    const pairs: [string, string][] = [];
    const add = (spelled: string, real: string): void => {
      if (spelled !== real && path.isAbsolute(spelled)) pairs.push([spelled, real]);
    };
    add(this.#opts.ctx.cwd, this.#canonicalCwd);
    const spelledRoots = [...new Set([...this.#opts.ctx.roots, ...(policy.additionalRoots ?? [])])];
    spelledRoots.forEach((root, i) => add(root, this.#canonicalRoots[i] ?? root));
    const out = new Set(policy.protectedPaths);
    for (const pattern of policy.protectedPaths) {
      for (const [spelled, real] of pairs) {
        const rel = path.relative(spelled, pattern);
        if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) out.add(rel === '' ? real : path.join(real, rel));
      }
      // Patterns under some other symlinked directory (e.g. home): resolve their literal prefix.
      out.add(canonicalPattern(pattern));
    }
    const patterns = [...out];
    this.#protectedCache = { policy, patterns };
    return patterns;
  }

  #protectedCache: { readonly policy: PolicySnapshot<P>; readonly patterns: readonly string[] } | undefined;

  #addChanged(absPath: string): void {
    const shown = workspaceDisplayPath(absPath, this.#canonicalCwd);
    if (!this.#changed.includes(shown)) this.#changed.push(shown);
  }

  #elapsed(started: number): number {
    return Math.max(0, Math.round(this.#now() - started));
  }
}

/** Whether a hook's rewrite of an undo step still makes the same change. */
function sameEffect(a: HostCall, b: HostCall): boolean {
  if (a.tool === 'write' && b.tool === 'write') return a.effect.absPath === b.effect.absPath && a.effect.afterContent === b.effect.afterContent;
  if (a.tool === 'bash' && b.tool === 'bash') return a.effect.command === b.effect.command;
  return false;
}

/** The failure of an undo whose step was refused: nothing was changed. */
function undoRefusal(step: UndoStep, failure: Failure): Failure {
  const what = `undo aborted, nothing was changed: ${step.kind} ${step.path}`;
  if (failure.kind === 'deny') return { ...failure, reason: `${what}: ${failure.reason}` };
  return { kind: 'error', error: new ToolError(failure.error.code, `${what}: ${failure.error.message}`) };
}

/** Real path of `p`, or `p` resolved lexically when it does not exist. */
function canonicalPath(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** A path pattern whose literal (wildcard-free) directory prefix is replaced by its real path when it exists. */
function canonicalPattern(pattern: string): string {
  if (!path.isAbsolute(pattern)) return pattern;
  const parts = pattern.split(/[\\/]/);
  const firstWild = parts.findIndex((part) => /[*?[]/.test(part));
  const literalCount = firstWild === -1 ? parts.length - 1 : firstWild;
  for (let n = literalCount; n > 1; n--) {
    const prefix = parts.slice(0, n).join(path.sep) || path.sep;
    let real: string;
    try {
      real = realpathSync.native(prefix);
    } catch {
      continue;
    }
    return path.join(real, ...parts.slice(n));
  }
  return pattern;
}

/** The prepared call with `requestedPath` set from the call the script made (never from the runtime). */
function withRequestedPath(prepared: PreparedCall, call: ToolCall): PreparedCall {
  const { requestedPath: _ignored, ...rest } = prepared;
  const requested = call.tool === 'bash' ? undefined : call.args.path;
  // The spread keeps the tool/args/effect pairing of `prepared`; only the optional field changes.
  return requested === undefined ? rest : { ...rest, requestedPath: requested };
}

/** Path relative to `cwd` when inside it (a name like `..env` is inside), else the absolute path. */
export function displayPath(absPath: string, cwd: string): string {
  const rel = path.relative(cwd, absPath);
  const inside = rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  return inside ? rel.split(path.sep).join('/') : absPath;
}

/**
 * The result as the script sees it: paths inside `cwd` are relative to it
 * (they resolve back to the same file when passed to a binding), so a result
 * the script returns does not repeat the workspace path in every entry, and
 * grep matches are rows under one `columns` header. `cwd` is the real path of
 * the session cwd, the form the tool runtime's paths take. Hooks and the diff
 * keep the tool runtime's absolute paths.
 */
export function scriptResult(result: ToolResult, cwd: string): ScriptValue {
  if ('matches' in result) {
    const rows = result.matches.map((m) => [displayPath(m.file, cwd), m.line, m.text] as const);
    return { columns: ['file', 'line', 'text'], rows, count: rows.length, truncated: result.truncated, filtered: result.filtered };
  }
  if ('files' in result) return { ...result, files: result.files.map((f) => displayPath(f, cwd)) };
  if ('path' in result) return { ...result, path: displayPath(result.path, cwd) };
  return result;
}

/** The tool name of a call in the call log: the binding, or `mcp__<server>__<tool>` for an `mcpCall`. */
export function callLabel(call: BindingCall | HostCall): string {
  return call.tool === 'mcp' ? `mcp__${call.args.server}__${call.args.tool}` : call.tool;
}

/** Short description of a call for the call log. */
export function summarize(call: BindingCall, cwd: string): string {
  const p = (value: string): string => displayPath(path.resolve(cwd, value), cwd);
  let s: string;
  switch (call.tool) {
    case 'mcp':
      s = `mcp ${call.args.server}.${call.args.tool} ${oneLine(clip(JSON.stringify(call.args.input), MAX_SUMMARY_CHARS))}`;
      break;
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
