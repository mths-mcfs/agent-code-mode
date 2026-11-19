import { Dispatcher, type StopReason } from './dispatcher.js';
import { errorMessage } from './errors.js';
import { DEFAULT_RUN_TIMEOUT_MS, MAX_RUN_TIMEOUT_MS, type RunArgs } from './schemas.js';
import type {
  CallLogEntry,
  CallReply,
  HostAdapter,
  LogLevel,
  McpRuntime,
  PolicyLoadError,
  PolicySnapshot,
  RollbackReport,
  RunError,
  RunRequest,
  RunResult,
  RunUndo,
  Sandbox,
  SandboxOutcome,
  SessionContext,
  ToolRuntime,
  Transaction,
} from './types.js';

/** Default heap limit of a script. */
export const DEFAULT_MEMORY_BYTES = 256 * 1024 * 1024;
/** How long to wait for the sandbox to return after it was told to stop. */
export const DEFAULT_STOP_GRACE_MS = 2_000;
/** Upper bound of a transaction rollback. */
export const DEFAULT_ROLLBACK_TIMEOUT_MS = 30_000;
const MAX_LOG_LINES = 5_000;
const MAX_LOG_CHARS = 1_000_000;

export interface RunDeps<P = unknown> {
  readonly sandbox: Sandbox;
  readonly adapter: HostAdapter<P>;
  readonly tools: ToolRuntime<P>;
  readonly ctx: SessionContext;
  /** Aborted when the client cancels the `run` request. */
  readonly signal?: AbortSignal;
  /** Server cap of the timeout (lower for hosts with short tool timeouts). Never above `MAX_RUN_TIMEOUT_MS`. */
  readonly maxTimeoutMs?: number;
  readonly memoryBytes?: number;
  /** Grace after a stop before the sandbox, in-flight calls and hooks are abandoned. */
  readonly stopGraceMs?: number;
  /** Upper bound of a transaction rollback. */
  readonly rollbackTimeoutMs?: number;
  /** Serves the `readOverflow` binding (results earlier responses of this server cut). */
  readonly overflow?: { read(args: unknown): CallReply };
  /** Serves `mcpCall` (upstream MCP tools). Absent: no upstream servers are configured. */
  readonly mcp?: McpRuntime;
}

/** Binding that reads back what a response cut; it never reaches the host, it only reads this server's memory. */
export const READ_OVERFLOW_BINDING = 'readOverflow';

type Bounded<T> = { readonly done: true; readonly value: T } | { readonly done: false; readonly why: 'aborted' | 'timeout' };

/**
 * Awaits adapter or runtime code without letting it hold the run hostage:
 * resolves when `work` settles, when `signal` aborts, or after `ms`.
 * A rejection of `work` is rethrown.
 */
function bounded<T>(work: () => Promise<T>, opts: { signal?: AbortSignal; ms?: number }): Promise<Bounded<T>> {
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      resolve({ done: false, why: 'aborted' });
    };
    if (opts.signal?.aborted) return resolve({ done: false, why: 'aborted' });
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts.ms !== undefined) {
      timer = setTimeout(() => {
        cleanup();
        resolve({ done: false, why: 'timeout' });
      }, Math.max(0, opts.ms));
    }
    let pending: Promise<T>;
    try {
      pending = Promise.resolve(work());
    } catch (err) {
      pending = Promise.reject(err);
    }
    pending.then(
      (value) => {
        cleanup();
        resolve({ done: true, value });
      },
      (err: unknown) => {
        cleanup();
        reject(err);
      },
    );
  });
}

async function rollbackBounded(tx: Transaction, ms: number, warnings: string[]): Promise<RollbackReport | undefined> {
  try {
    const r = await bounded(() => tx.rollback(), { ms });
    if (r.done) return r.value;
    warnings.push(`rollback did not finish within ${ms} ms; some files may not be restored.`);
  } catch (err) {
    warnings.push(`rollback failed: ${errorMessage(err)}`);
  }
  return undefined;
}

/** Applies defaults and clamps the timeout to `[1, min(maxTimeoutMs, MAX_RUN_TIMEOUT_MS)]`. */
export function resolveTimeoutMs(requested: number | undefined, maxTimeoutMs: number = MAX_RUN_TIMEOUT_MS): number {
  const cap = Math.max(1, Math.min(MAX_RUN_TIMEOUT_MS, Math.floor(maxTimeoutMs)));
  const wanted = requested === undefined || !Number.isFinite(requested) ? DEFAULT_RUN_TIMEOUT_MS : Math.floor(requested);
  return Math.min(cap, Math.max(1, wanted));
}

/** Builds a `RunRequest` from validated `run` arguments. */
export function toRunRequest(args: RunArgs, maxTimeoutMs?: number): RunRequest {
  return { code: args.code, transaction: args.transaction ?? false, timeoutMs: resolveTimeoutMs(args.timeoutMs, maxTimeoutMs) };
}

class LogCollector {
  readonly lines: string[] = [];
  #chars = 0;
  #dropped = 0;

  add(level: LogLevel, text: string): void {
    const line = level === 'log' ? text : `${level}: ${text}`;
    if (this.lines.length >= MAX_LOG_LINES || this.#chars + line.length > MAX_LOG_CHARS) {
      this.#dropped++;
      return;
    }
    this.#chars += line.length;
    this.lines.push(line);
  }

  finish(): string[] {
    if (this.#dropped > 0) this.lines.push(`[${this.#dropped} more log lines dropped]`);
    return this.lines;
  }
}

function waitOrGrace(promise: Promise<SandboxOutcome>, signal: AbortSignal, graceMs: number): Promise<SandboxOutcome> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const onAbort = (): void => {
      timer = setTimeout(
        () =>
          resolve({
            ok: false,
            kind: 'killed',
            error: { name: 'Killed', message: 'the sandbox did not stop in time after the run was stopped' },
          }),
        graceMs,
      );
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (outcome) => {
        if (timer) clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(outcome);
      },
      (err: unknown) => {
        if (timer) clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve({ ok: false, kind: 'error', error: { name: 'SandboxError', message: errorMessage(err) } });
      },
    );
  });
}

function runError(stopReason: StopReason | undefined, outcome: SandboxOutcome, denied: CallLogEntry | undefined, timeoutMs: number): RunError | undefined {
  if (stopReason === 'denied') {
    const what = denied ? `${denied.id} (${denied.summary}) was denied: ${denied.reason ?? ''}` : 'a call was denied';
    return { kind: 'denied', name: 'PermissionDenied', message: `transaction aborted: ${what}` };
  }
  if (stopReason === 'cancelled') return { kind: 'cancelled', name: 'Cancelled', message: 'the run was cancelled by the client' };
  if (stopReason === 'timeout' || (!outcome.ok && outcome.kind === 'timeout')) {
    return { kind: 'timeout', name: 'Timeout', message: `the script did not finish within ${timeoutMs} ms` };
  }
  if (!outcome.ok) {
    const { name, message, stack } = outcome.error;
    return stack === undefined ? { kind: outcome.kind, name, message } : { kind: outcome.kind, name, message, stack };
  }
  return undefined;
}

function readOverflow(store: RunDeps['overflow'], args: unknown): CallReply {
  if (store === undefined) return { ok: false, error: { name: 'ToolError', code: 'not-found', message: 'readOverflow: this server keeps no cut results' } };
  return store.read(args);
}

/** The run's scratch directory when its adapter applies one; a failure to create it only leaves the run without one. */
async function scratchFor<P>(deps: RunDeps<P>, warnings: string[]): Promise<string | undefined> {
  if (deps.adapter.usesScratch !== true || deps.tools.scratchDir === undefined) return undefined;
  try {
    return await deps.tools.scratchDir();
  } catch (err) {
    warnings.push(`the scratch directory could not be created: ${errorMessage(err)}`);
    return undefined;
  }
}

/** Files the run's undo record, or drops it when the run was rolled back. Never throws. */
async function settleUndo(undo: RunUndo | undefined, rolledBack: boolean, stats: { bashCalls: number; mcpCalls: number }, warnings: string[]): Promise<{ undoId?: string }> {
  if (undo === undefined) return {};
  try {
    if (rolledBack) {
      await undo.discard();
      return {};
    }
    const outcome = await undo.finish(stats);
    if (outcome.warning !== undefined) warnings.push(outcome.warning);
    return outcome.undoId === undefined ? {} : { undoId: outcome.undoId };
  } catch (err) {
    warnings.push(`this run cannot be undone: ${errorMessage(err)}`);
    return {};
  }
}

/**
 * Runs one script end to end: loads the policy, starts the transaction,
 * runs the sandbox with the dispatcher behind its bindings, enforces the
 * timeout and cancellation, rolls back on failure and builds the `RunResult`.
 * Never rejects.
 */
export async function runScript<P>(req: RunRequest, deps: RunDeps<P>): Promise<RunResult> {
  const timeoutMs = resolveTimeoutMs(req.timeoutMs, deps.maxTimeoutMs);
  const graceMs = deps.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  const logs = new LogCollector();
  const controller = new AbortController();
  let stopReason: StopReason | undefined;
  let dispatcher: Dispatcher<P> | undefined;
  let denied: CallLogEntry | undefined;
  let tx: Transaction | undefined;
  let undo: RunUndo | undefined;
  const setupWarnings: string[] = [];

  const stop = (reason: StopReason): void => {
    if (stopReason !== undefined) return;
    stopReason = reason;
    controller.abort(reason);
    void dispatcher?.stop(reason);
  };
  const onExternalAbort = (): void => stop('cancelled');
  deps.signal?.addEventListener('abort', onExternalAbort, { once: true });
  if (deps.signal?.aborted) stop('cancelled');

  const rollbackMs = deps.rollbackTimeoutMs ?? DEFAULT_ROLLBACK_TIMEOUT_MS;
  // Backup deadline for the whole run, policy loading included. The sandbox
  // enforces `timeoutMs` itself; this fires only if something does not return.
  let timer: NodeJS.Timeout | undefined = setTimeout(() => stop('timeout'), timeoutMs + graceMs);
  try {
    const scratchDir = await scratchFor(deps, setupWarnings);
    const ctx: SessionContext = scratchDir === undefined ? deps.ctx : { ...deps.ctx, scratchDir };
    let policy: PolicySnapshot<P> | PolicyLoadError;
    try {
      const loaded = await bounded(() => deps.adapter.loadPolicy(ctx), { signal: controller.signal });
      policy = loaded.done ? loaded.value : { error: 'the run stopped while the host policy was loading' };
    } catch (err) {
      policy = { error: errorMessage(err) };
    }

    if (req.transaction) tx = deps.tools.beginTransaction();
    undo = deps.tools.beginUndo?.();
    dispatcher = new Dispatcher<P>({
      adapter: deps.adapter,
      tools: deps.tools,
      ctx,
      policy,
      ...(undo ? { undo } : {}),
      ...(deps.mcp ? { mcp: deps.mcp } : {}),
      ...(tx ? { transaction: tx, onDeny: (entry: CallLogEntry) => ((denied = entry), stop('denied')) } : {}),
    });
    const active = dispatcher;
    if (stopReason !== undefined) void active.stop(stopReason);

    let outcome: SandboxOutcome;
    if (stopReason !== undefined) {
      outcome = { ok: false, kind: 'killed', error: { name: 'Killed', message: 'the run was stopped before the script started' } };
    } else {
      let started: Promise<SandboxOutcome>;
      try {
        started = deps.sandbox.run(req.code, {
          timeoutMs,
          memoryBytes: deps.memoryBytes ?? DEFAULT_MEMORY_BYTES,
          signal: controller.signal,
          ...(scratchDir === undefined ? {} : { scratchDir }),
          onCall: (tool, args) => (tool === READ_OVERFLOW_BINDING ? Promise.resolve(readOverflow(deps.overflow, args)) : active.dispatch(tool, args)),
          onLog: (level, text) => logs.add(level, text),
        });
      } catch (err) {
        started = Promise.reject(err);
      }
      outcome = await waitOrGrace(started, controller.signal, graceMs);
    }
    clearTimeout(timer);
    timer = undefined;

    // No call may start after the script ended; wait (bounded) for in-flight ones.
    await active.stop(stopReason ?? 'finished', graceMs);

    const error = runError(stopReason, outcome, denied, timeoutMs);
    let rolledBack: RollbackReport | undefined;
    const rollbackWarnings: string[] = [];
    if (tx && error) {
      rolledBack = await rollbackBounded(tx, rollbackMs, rollbackWarnings);
      if (active.bashCallsStarted > 0) {
        rollbackWarnings.push(`${active.bashCallsStarted} bash call(s) ran in this transaction; bash effects are never rolled back.`);
      }
      if (active.mcpCallsSent > 0) {
        rollbackWarnings.push(`${active.mcpCallsSent} mcpCall(s) were sent to upstream MCP servers in this transaction; their effects were not undone (MCP calls are never rolled back).`);
      }
    }
    // Last look at the protected paths (after the last bash call and any rollback), before the response is built.
    await active.finishRun();
    const undoWarnings: string[] = [];
    const undone = await settleUndo(undo, tx !== undefined && error !== undefined, { bashCalls: active.bashCallsStarted, mcpCalls: active.mcpCallsSent }, undoWarnings);
    const warnings = [...setupWarnings, ...active.warnings, ...rollbackWarnings, ...undoWarnings];

    const base = {
      ...undone,
      logs: logs.finish(),
      calls: active.calls,
      changedFiles: active.changedFiles,
      diff: active.diff,
      warnings,
      ...(rolledBack ? { rolledBack } : {}),
    };
    if (error) return { ok: false, error, ...base };
    return { ok: true, result: outcome.ok ? (outcome.value ?? null) : null, ...base };
  } catch (err) {
    if (dispatcher) await dispatcher.stop(stopReason ?? 'finished', graceMs);
    const rollbackWarnings: string[] = [];
    const rolledBack = tx ? await rollbackBounded(tx, rollbackMs, rollbackWarnings) : undefined;
    if (tx && dispatcher && dispatcher.mcpCallsSent > 0) {
      rollbackWarnings.push(`${dispatcher.mcpCallsSent} mcpCall(s) were sent to upstream MCP servers in this transaction; their effects were not undone (MCP calls are never rolled back).`);
    }
    if (dispatcher) await dispatcher.finishRun();
    const undone = await settleUndo(undo, tx !== undefined, { bashCalls: dispatcher?.bashCallsStarted ?? 0, mcpCalls: dispatcher?.mcpCallsSent ?? 0 }, rollbackWarnings);
    const warnings = [...setupWarnings, ...(dispatcher ? dispatcher.warnings : []), ...rollbackWarnings];
    return {
      ...undone,
      ok: false,
      error: { kind: 'internal', name: 'InternalError', message: errorMessage(err) },
      logs: logs.finish(),
      calls: dispatcher?.calls ?? [],
      changedFiles: dispatcher?.changedFiles ?? [],
      diff: dispatcher?.diff ?? '',
      warnings,
      ...(rolledBack ? { rolledBack } : {}),
    };
  } finally {
    if (timer) clearTimeout(timer);
    deps.signal?.removeEventListener('abort', onExternalAbort);
    if (tx) {
      const journal = tx;
      // Disposing only releases the journal; do not let it hold the result.
      await bounded(() => journal.dispose(), { ms: graceMs }).catch(() => undefined);
    }
  }
}
