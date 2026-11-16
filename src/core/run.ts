import { Dispatcher, type StopReason } from './dispatcher.js';
import { errorMessage } from './errors.js';
import { DEFAULT_RUN_TIMEOUT_MS, MAX_RUN_TIMEOUT_MS, type RunArgs } from './schemas.js';
import type {
  CallLogEntry,
  CallReply,
  HostAdapter,
  LogLevel,
  PolicyLoadError,
  PolicySnapshot,
  RollbackReport,
  RunError,
  RunRequest,
  RunResult,
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
    let policy: PolicySnapshot<P> | PolicyLoadError;
    try {
      const loaded = await bounded(() => deps.adapter.loadPolicy(deps.ctx), { signal: controller.signal });
      policy = loaded.done ? loaded.value : { error: 'the run stopped while the host policy was loading' };
    } catch (err) {
      policy = { error: errorMessage(err) };
    }

    if (req.transaction) tx = deps.tools.beginTransaction();
    dispatcher = new Dispatcher<P>({
      adapter: deps.adapter,
      tools: deps.tools,
      ctx: deps.ctx,
      policy,
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
    const warnings = [...active.warnings];
    let rolledBack: RollbackReport | undefined;
    if (tx && error) {
      rolledBack = await rollbackBounded(tx, rollbackMs, warnings);
      if (active.bashCommits > 0) {
        warnings.push(`${active.bashCommits} bash call(s) ran in this transaction; bash effects are never rolled back.`);
      }
    }

    const base = {
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
    const warnings = dispatcher ? [...dispatcher.warnings] : [];
    const rolledBack = tx ? await rollbackBounded(tx, rollbackMs, warnings) : undefined;
    return {
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
