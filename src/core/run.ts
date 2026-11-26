import { Dispatcher, type StopReason } from './dispatcher.js';
import { TransactionFinalizeError, errorMessage } from './errors.js';
import { releasingClaims } from './file-claims.js';
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
  Sandbox,
  ScratchDir,
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
  /** Monotonic clock in ms, for tests. */
  readonly now?: () => number;
  readonly overflow?: { read(args: unknown): CallReply };
  /** Sends authorized `mcpCall`s to the host's upstream MCP servers. */
  readonly mcp?: McpRuntime;
}

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

/**
 * Rolls back once no write or edit can still land. While some are running,
 * the rollback waits for them in the background and a warning says so.
 * `done` settles when the rollback has really ended, even past `ms`.
 */
async function rollbackBounded(
  tx: Transaction,
  writes: Promise<unknown> | undefined,
  ms: number,
  warnings: string[],
): Promise<{ readonly report?: RollbackReport; readonly done: Promise<unknown> }> {
  if (writes) {
    warnings.push('the rollback is pending: some writes were still running when the run stopped; the final rollback outcome is unknown.');
    return { done: writes.then(() => tx.rollback()) };
  }
  const done = Promise.resolve().then(() => tx.rollback());
  try {
    const r = await bounded(() => done, { ms });
    if (r.done) return { report: r.value, done };
    warnings.push(`rollback did not finish within ${ms} ms; some files may not be restored.`);
  } catch (err) {
    warnings.push(`rollback failed: ${errorMessage(err)}`);
  }
  return { done };
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

/**
 * Runs one script end to end: loads the policy, starts the transaction,
 * runs the sandbox with the dispatcher behind its bindings, enforces the
 * timeout and cancellation, rolls back on failure and builds the `RunResult`.
 * The run's scratch directory is created first and deleted before the
 * result returns. Never rejects.
 */
export async function runScript<P>(req: RunRequest, deps: RunDeps<P>): Promise<RunResult> {
  const notes: string[] = [];
  let scratch: ScratchDir | undefined;
  if (deps.tools.createScratch !== undefined) {
    try {
      scratch = await deps.tools.createScratch();
    } catch (err) {
      notes.push(`this run has no scratch directory: ${errorMessage(err)}`);
    }
  }
  const result = await runWithin(req, scratch === undefined ? deps : { ...deps, ctx: { ...deps.ctx, scratchDir: scratch.path } }, scratch);
  const left = await scratch?.remove().catch((err: unknown) => errorMessage(err));
  if (left !== undefined) notes.push(`the scratch directory ${scratch?.path ?? ''} could not be removed (${left}); the next server start removes it`);
  return notes.length === 0 ? result : { ...result, warnings: [...notes, ...result.warnings] };
}

async function runWithin<P>(req: RunRequest, deps: RunDeps<P>, scratchDir: ScratchDir | undefined): Promise<RunResult> {
  const now = deps.now ?? (() => performance.now());
  const timeoutMs = resolveTimeoutMs(req.timeoutMs, deps.maxTimeoutMs);
  // One deadline for the whole run, policy loading included; the grace after it is for stopping and finishing.
  const deadline = now() + timeoutMs;
  const graceMs = deps.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  const logs = new LogCollector();
  const controller = new AbortController();
  let stopReason: StopReason | undefined;
  let dispatcher: Dispatcher<P> | undefined;
  let denied: CallLogEntry | undefined;
  let tx: Transaction | undefined;
  /** What must end before the journal is disposed: running writes, then the rollback. */
  let journalBusy: Promise<unknown> | undefined;
  /** Set once the journal was committed (durably or not); nothing after may roll back or finalize again. */
  let finalized = false;

  const stop = (reason: StopReason): void => {
    if (stopReason !== undefined) return;
    stopReason = reason;
    controller.abort(reason);
    void dispatcher?.stop(reason);
  };
  const checkDeadline = (): void => {
    if (now() >= deadline) stop('timeout');
  };
  const onExternalAbort = (): void => stop('cancelled');
  deps.signal?.addEventListener('abort', onExternalAbort, { once: true });
  if (deps.signal?.aborted) stop('cancelled');

  const rollbackMs = deps.rollbackTimeoutMs ?? DEFAULT_ROLLBACK_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined = setTimeout(() => stop('timeout'), timeoutMs);
  try {
    let policy: PolicySnapshot<P> | PolicyLoadError;
    try {
      const loaded = await bounded(() => deps.adapter.loadPolicy(deps.ctx), { signal: controller.signal });
      policy = loaded.done ? loaded.value : { error: 'the run stopped while the host policy was loading' };
    } catch (err) {
      policy = { error: errorMessage(err) };
    }
    checkDeadline();
    if (req.transaction && stopReason === undefined) tx = releasingClaims(deps.tools.beginTransaction());
    const scratch = scratchDir !== undefined && !('error' in policy) && policy.scratchRoot === scratchDir.path ? scratchDir : undefined;

    const overflow = deps.overflow;
    const leftMs = deadline - now();
    if (leftMs <= 0) stop('timeout');
    dispatcher = new Dispatcher<P>({
      adapter: deps.adapter,
      tools: deps.tools,
      ctx: deps.ctx,
      policy,
      checkDeadline,
      ...(overflow ? { readOverflow: (args: unknown) => overflow.read(args) } : {}),
      ...(deps.mcp ? { mcp: deps.mcp } : {}),
      ...(scratch ? { scratch } : {}),
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
          timeoutMs: Math.ceil(leftMs),
          memoryBytes: deps.memoryBytes ?? DEFAULT_MEMORY_BYTES,
          signal: controller.signal,
          ...(scratch ? { scratchDir: scratch.path } : {}),
          onCall: (tool, args) => active.dispatch(tool, args),
          onLog: (level, text) => logs.add(level, text),
        });
      } catch (err) {
        started = Promise.reject(err);
      }
      outcome = await waitOrGrace(started, controller.signal, graceMs);
      if (outcome.ok) checkDeadline();
    }
    clearTimeout(timer);
    timer = undefined;

    // No call may start after the script ended; wait (bounded) for in-flight ones.
    await active.stop(stopReason ?? 'finished', graceMs);
    journalBusy = active.pendingWrites;

    let error = runError(stopReason, outcome, denied, timeoutMs);
    const warnings = [...active.warnings];
    let rolledBack: RollbackReport | undefined;
    if (tx && !error) {
      // Success is reported only once recovery can no longer undo the run.
      if (journalBusy) {
        error = {
          kind: 'internal',
          name: 'TransactionNotFinalized',
          message: 'the transaction could not be finalized because some writes were still running after the script ended',
        };
      } else {
        const journal = tx;
        const finalizing = Promise.resolve().then(() => journal.dispose());
        try {
          // Bounded like the rest of the run: the script's deadline plus the stop grace, and cancellation.
          const r = await bounded(() => finalizing, { signal: controller.signal, ms: deadline + graceMs - now() });
          finalized = true;
          if (!r.done) {
            const why = r.why === 'aborted' ? 'the run was cancelled' : 'the run reached its time limit';
            error = {
              kind: 'internal',
              name: 'TransactionIndeterminate',
              message: `${why} while the transaction was being finalized; the outcome is not known yet`,
            };
            warnings.push('the writes of this run are kept if the finalization still completes, and rolled back if it fails.');
            // Not a rollback: the finalization is left to end, and only a failed commit is undone.
            void finalizing.catch((err: unknown) => {
              if (err instanceof TransactionFinalizeError && err.committed) return undefined;
              return journal.rollback();
            }).catch(() => undefined);
          }
        } catch (err) {
          if (err instanceof TransactionFinalizeError && err.committed) {
            finalized = true;
            error = { kind: 'internal', name: 'TransactionIndeterminate', message: err.message };
            warnings.push('the writes of this run are on disk and were not rolled back, but they may not survive a power loss or crash.');
          } else {
            error = { kind: 'internal', name: 'TransactionNotFinalized', message: `the transaction could not be finalized: ${errorMessage(err)}` };
          }
        }
      }
    }
    if (tx && error && !finalized) {
      const rollback = await rollbackBounded(tx, journalBusy, rollbackMs, warnings);
      journalBusy = rollback.done;
      rolledBack = rollback.report;
      if (active.bashCommits > 0) {
        warnings.push(`${active.bashCommits} bash call(s) ran in this transaction; bash effects are never rolled back.`);
      }
      if (active.mcpCallsSent > 0) {
        warnings.push(`${active.mcpCallsSent} mcpCall(s) were sent to upstream MCP servers in this transaction; their effects are never rolled back.`);
      }
    }

    await active.finishWatch();
    const protectedChanges = active.protectedChanges;
    const base = {
      logs: logs.finish(),
      calls: active.calls,
      changedFiles: active.changedFiles,
      diff: active.diff,
      warnings,
      ...(rolledBack ? { rolledBack } : {}),
      ...(protectedChanges.length > 0 ? { protectedChanges } : {}),
    };
    if (error) return { ok: false, error, ...base };
    return { ok: true, result: outcome.ok ? (outcome.value ?? null) : null, ...base };
  } catch (err) {
    if (dispatcher) await dispatcher.stop(stopReason ?? 'finished', graceMs);
    journalBusy = dispatcher?.pendingWrites;
    const warnings = dispatcher ? [...dispatcher.warnings] : [];
    let rolledBack: RollbackReport | undefined;
    if (tx && !finalized) {
      const rollback = await rollbackBounded(tx, journalBusy, rollbackMs, warnings);
      journalBusy = rollback.done;
      rolledBack = rollback.report;
    }
    await dispatcher?.finishWatch();
    const protectedChanges = dispatcher?.protectedChanges ?? [];
    return {
      ok: false,
      error: { kind: 'internal', name: 'InternalError', message: errorMessage(err) },
      logs: logs.finish(),
      calls: dispatcher?.calls ?? [],
      changedFiles: dispatcher?.changedFiles ?? [],
      diff: dispatcher?.diff ?? '',
      warnings,
      ...(rolledBack ? { rolledBack } : {}),
      ...(protectedChanges.length > 0 ? { protectedChanges } : {}),
    };
  } finally {
    if (timer) clearTimeout(timer);
    deps.signal?.removeEventListener('abort', onExternalAbort);
    if (tx && !finalized) {
      const journal = tx;
      // Released only after every commit and the rollback have ended; it never holds the result.
      void Promise.resolve(journalBusy).catch(() => undefined).then(() => journal.dispose()).catch(() => undefined);
    }
  }
}
