import type { BindingErrorCode } from './types.js';

/** Codes a `ToolError` can carry. */
export type ToolErrorCode = Exclude<BindingErrorCode, 'denied'> | 'containment-unavailable';

/**
 * Error thrown by the tool runtime (`prepare`/`commit`) and returned by
 * `parseToolCall`. The dispatcher converts it into a `BindingError`;
 * `containment-unavailable` becomes a deny instead.
 */
export class ToolError extends Error {
  override readonly name = 'ToolError';
  readonly code: ToolErrorCode;

  constructor(code: ToolErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Thrown by `Transaction.dispose()` when the journal could not be finalized.
 * `committed: false`: the journal is intact and can still be rolled back.
 * `committed: true`: the journal is out of recovery's reach (the changes are
 * kept), but the step that makes that durable failed.
 */
export class TransactionFinalizeError extends Error {
  override readonly name = 'TransactionFinalizeError';
  readonly committed: boolean;

  constructor(committed: boolean, message: string) {
    super(message);
    this.committed = committed;
  }
}

/** Message of any thrown value, without trusting its shape. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return String(err);
  } catch {
    return 'unknown error';
  }
}
