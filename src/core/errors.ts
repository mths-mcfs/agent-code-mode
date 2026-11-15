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
