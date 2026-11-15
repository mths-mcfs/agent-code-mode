import { z } from 'zod';
import { ToolError } from './errors.js';
import type { ToolArgsMap, ToolCall, ToolName } from './types.js';

/**
 * Boundary schemas. Everything that crosses into the server (MCP request
 * arguments, binding calls from the sandbox child, `updatedArgs` from hooks)
 * is parsed here before internal code sees it.
 */

/** Default `run` timeout. */
export const DEFAULT_RUN_TIMEOUT_MS = 120_000;
/** Hard upper bound of the `run` timeout. */
export const MAX_RUN_TIMEOUT_MS = 600_000;
/** Largest script accepted. */
export const MAX_CODE_CHARS = 1_000_000;
/** Largest string accepted in a binding argument (file content, command). */
export const MAX_ARG_CHARS = 20_000_000;

export const TOOL_NAMES = ['bash', 'read', 'write', 'edit', 'grep', 'glob'] as const satisfies readonly ToolName[];

const MUTATING: ReadonlySet<ToolName> = new Set<ToolName>(['bash', 'write', 'edit']);

/** Whether `tool` changes state (serialized per run). */
export function isMutating(tool: ToolName): boolean {
  return MUTATING.has(tool);
}

/** Narrows an untrusted string to a `ToolName`. */
export function isToolName(tool: string): tool is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(tool);
}

const pathString = z
  .string()
  .min(1, 'must not be empty')
  .max(4096)
  .refine((s) => !s.includes('\0'), 'must not contain NUL characters');

const text = z.string().max(MAX_ARG_CHARS);
const positiveInt = (max: number) => z.number().int().min(1).max(max);

// Tool args are strict: an unknown key (e.g. `file_path` instead of `path`)
// is an error the script author should see, not something silently dropped.

export const BashArgsSchema = z.strictObject({
  command: text.min(1, 'must not be empty').refine((s) => !s.includes('\0'), 'must not contain NUL characters'),
  cwd: pathString.optional(),
  timeoutMs: positiveInt(MAX_RUN_TIMEOUT_MS).optional(),
}) satisfies z.ZodType<ToolArgsMap['bash']>;

export const ReadArgsSchema = z.strictObject({
  path: pathString,
  offset: positiveInt(Number.MAX_SAFE_INTEGER).optional(),
  limit: positiveInt(1_000_000).optional(),
}) satisfies z.ZodType<ToolArgsMap['read']>;

export const WriteArgsSchema = z.strictObject({
  path: pathString,
  content: text,
}) satisfies z.ZodType<ToolArgsMap['write']>;

export const EditArgsSchema = z.strictObject({
  path: pathString,
  oldString: text.min(1, 'must not be empty'),
  newString: text,
  replaceAll: z.boolean().optional(),
}) satisfies z.ZodType<ToolArgsMap['edit']>;

export const GrepArgsSchema = z.strictObject({
  pattern: z.string().min(1, 'must not be empty').max(10_000),
  path: pathString.optional(),
  glob: z.string().min(1).max(4096).optional(),
  ignoreCase: z.boolean().optional(),
  maxResults: positiveInt(100_000).optional(),
}) satisfies z.ZodType<ToolArgsMap['grep']>;

export const GlobArgsSchema = z.strictObject({
  pattern: z.string().min(1, 'must not be empty').max(4096),
  path: pathString.optional(),
  maxResults: positiveInt(100_000).optional(),
}) satisfies z.ZodType<ToolArgsMap['glob']>;

/** Args schema of each tool. */
export const ToolArgsSchemas = {
  bash: BashArgsSchema,
  read: ReadArgsSchema,
  write: WriteArgsSchema,
  edit: EditArgsSchema,
  grep: GrepArgsSchema,
  glob: GlobArgsSchema,
} as const;

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join('.') : 'args';
      return `${where}: ${issue.message}`;
    })
    .join('; ');
}

/**
 * Validates an untrusted binding call. Returns a typed `ToolCall` with the
 * given id, or a `ToolError` (`invalid-args`) describing what is wrong.
 */
export function parseToolCall(tool: string, args: unknown, id: string): ToolCall | ToolError {
  if (typeof tool !== 'string' || !isToolName(tool)) {
    return new ToolError('invalid-args', `unknown tool ${JSON.stringify(String(tool)).slice(0, 80)}; expected one of ${TOOL_NAMES.join(', ')}`);
  }
  switch (tool) {
    case 'bash': {
      const r = BashArgsSchema.safeParse(args);
      return r.success ? { id, tool, args: r.data } : new ToolError('invalid-args', `bash: ${formatIssues(r.error)}`);
    }
    case 'read': {
      const r = ReadArgsSchema.safeParse(args);
      return r.success ? { id, tool, args: r.data } : new ToolError('invalid-args', `read: ${formatIssues(r.error)}`);
    }
    case 'write': {
      const r = WriteArgsSchema.safeParse(args);
      return r.success ? { id, tool, args: r.data } : new ToolError('invalid-args', `write: ${formatIssues(r.error)}`);
    }
    case 'edit': {
      const r = EditArgsSchema.safeParse(args);
      return r.success ? { id, tool, args: r.data } : new ToolError('invalid-args', `edit: ${formatIssues(r.error)}`);
    }
    case 'grep': {
      const r = GrepArgsSchema.safeParse(args);
      return r.success ? { id, tool, args: r.data } : new ToolError('invalid-args', `grep: ${formatIssues(r.error)}`);
    }
    case 'glob': {
      const r = GlobArgsSchema.safeParse(args);
      return r.success ? { id, tool, args: r.data } : new ToolError('invalid-args', `glob: ${formatIssues(r.error)}`);
    }
  }
}

/**
 * Raw `run` tool arguments. Unknown keys (including any model-supplied
 * `_ctx`) are stripped and never trusted.
 */
export const RunArgsSchema = z.object({
  code: z.string().min(1, 'must not be empty').max(MAX_CODE_CHARS),
  transaction: z.boolean().optional(),
  timeoutMs: z.number().int().min(1).optional(),
});

export type RunArgs = z.infer<typeof RunArgsSchema>;

/** JSON Schema of the `run` input, as announced in `tools/list`. */
export const RUN_INPUT_JSON_SCHEMA: {
  type: 'object';
  properties: Record<string, object>;
  required: string[];
} = {
  type: 'object',
  properties: {
    code: {
      type: 'string',
      description:
        'Body of an async JavaScript function. Use await with the bindings bash, read, write, edit, grep, glob; the return value is the result.',
    },
    transaction: {
      type: 'boolean',
      description: 'Roll back file writes and edits if the script fails, times out or any call is denied. bash effects are never rolled back.',
    },
    timeoutMs: {
      type: 'integer',
      minimum: 1,
      description: `Script timeout in milliseconds (default ${DEFAULT_RUN_TIMEOUT_MS}, capped by the server).`,
    },
  },
  required: ['code'],
};

/** Validates raw `run` arguments. */
export function parseRunArgs(args: unknown): { ok: true; value: RunArgs } | { ok: false; message: string } {
  const r = RunArgsSchema.safeParse(args ?? {});
  return r.success ? { ok: true, value: r.data } : { ok: false, message: formatIssues(r.error) };
}
