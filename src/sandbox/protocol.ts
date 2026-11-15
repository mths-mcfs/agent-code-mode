/**
 * Wire protocol between the sandbox parent (server process) and the sandbox
 * child process. Messages are newline-delimited JSON: parent → child on the
 * child's stdin, child → parent on the child's stdout.
 *
 * Each side validates what it receives. This file holds the parent side: the
 * schemas of child messages (the child is treated as hostile) and the types
 * of the messages the parent sends. The child (`child.ts`) has no runtime
 * import of this file, so it can run from source with Node type stripping.
 */
import { z } from 'zod';
import type { CallReply } from '../core/types.js';

/** Limits of one run, sent to the child in the `start` message. */
export interface SandboxLimits {
  /** QuickJS heap limit (`runtime.setMemoryLimit`). */
  readonly memoryBytes: number;
  /** QuickJS stack limit (`runtime.setMaxStackSize`). */
  readonly stackBytes: number;
  /** Maximum binding calls per run; later calls reject inside the VM. */
  readonly maxCalls: number;
  /** Maximum total console bytes per run; later lines are dropped. */
  readonly maxLogBytes: number;
  /** Maximum length of one console line, in characters. */
  readonly maxLogLineChars: number;
  /** Maximum length of the JSON-serialized return value, in characters. */
  readonly maxResultChars: number;
  /** Maximum length of the JSON-serialized arguments of one call, in characters. */
  readonly maxArgsChars: number;
}

/** First message of a run: what to execute and with which limits. */
export interface StartMessage {
  readonly type: 'start';
  readonly code: string;
  /** Wall-clock budget left for the script when the message was sent. */
  readonly timeoutMs: number;
  readonly limits: SandboxLimits;
}

/** Answer to one binding call. */
export interface ReplyMessage {
  readonly type: 'reply';
  readonly id: number;
  readonly reply: CallReply;
}

export type ParentMessage = StartMessage | ReplyMessage;

/** Longest tool name a child may send. Real names are at most 5 characters. */
export const MAX_TOOL_NAME_CHARS = 64;

const ScriptErrorSchema = z.strictObject({
  name: z.string().max(1_000),
  message: z.string().max(100_000),
  stack: z.string().max(100_000).optional(),
});

/**
 * Schema of child → parent messages, built for the limits of one run so that
 * every string field is bounded.
 */
export function childMessageSchema(limits: SandboxLimits) {
  return z.discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('call'),
      id: z.number().int().min(1),
      tool: z.string().max(MAX_TOOL_NAME_CHARS),
      /** JSON text of the arguments. */
      args: z.string().max(limits.maxArgsChars),
    }),
    z.strictObject({
      type: z.literal('log'),
      level: z.enum(['log', 'info', 'warn', 'error']),
      text: z.string().max(limits.maxLogLineChars + 200),
    }),
    z.strictObject({
      type: z.literal('done'),
      outcome: z.discriminatedUnion('ok', [
        /** `value` is the JSON text of the return value. */
        z.strictObject({ ok: z.literal(true), value: z.string().max(limits.maxResultChars) }),
        z.strictObject({ ok: z.literal(false), kind: z.enum(['error', 'timeout', 'oom']), error: ScriptErrorSchema }),
      ]),
    }),
  ]);
}

export type ChildMessage = z.infer<ReturnType<typeof childMessageSchema>>;
