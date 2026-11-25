import { z } from 'zod';
import { runCommandHook } from '../../core/command-hook.js';
import type { PreparedCall, ToolArgsMap, ToolName, ToolResult } from '../../core/types.js';
import type { HookHandler } from './settings.js';
import type { NativeToolName } from './rules.js';

/**
 * Claude Code PreToolUse/PostToolUse hooks, reproduced for binding calls.
 * Contract: https://code.claude.com/docs/en/hooks.
 */

export const NATIVE_TOOL: Readonly<Record<ToolName, NativeToolName>> = {
  bash: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  grep: 'Grep',
  glob: 'Glob',
};

export interface NativeCall {
  readonly toolName: NativeToolName;
  readonly toolInput: Readonly<Record<string, unknown>>;
}

export function nativeCall(prepared: PreparedCall): NativeCall {
  switch (prepared.tool) {
    case 'bash':
      return {
        toolName: 'Bash',
        toolInput: {
          command: prepared.effect.command,
          timeout: prepared.effect.timeoutMs,
          description: `agent-code-mode script call ${prepared.id}`,
          run_in_background: false,
        },
      };
    case 'read':
      return { toolName: 'Read', toolInput: { file_path: prepared.effect.absPath, offset: prepared.effect.offset, limit: prepared.effect.limit } };
    case 'write':
      return { toolName: 'Write', toolInput: { file_path: prepared.effect.absPath, content: prepared.effect.afterContent } };
    case 'edit':
      return {
        toolName: 'Edit',
        toolInput: {
          file_path: prepared.effect.absPath,
          old_string: prepared.effect.matchedOldString,
          new_string: prepared.args.newString,
          replace_all: prepared.args.replaceAll ?? false,
        },
      };
    case 'grep': {
      const input: Record<string, unknown> = {
        pattern: prepared.effect.pattern,
        path: prepared.effect.absRoot,
        ...(prepared.effect.glob === null ? {} : { glob: prepared.effect.glob }),
        '-i': prepared.effect.ignoreCase,
        output_mode: 'content',
        '-n': true,
        head_limit: prepared.effect.maxResults,
      };
      return { toolName: 'Grep', toolInput: input };
    }
    case 'glob':
      return { toolName: 'Glob', toolInput: { pattern: prepared.effect.pattern, path: prepared.effect.absRoot } };
  }
}

export function nativeResponse(prepared: PreparedCall, result: ToolResult): Record<string, unknown> {
  switch (prepared.tool) {
    case 'bash':
      return 'stdout' in result ? { stdout: result.stdout, stderr: result.stderr, interrupted: result.timedOut, isImage: false, exitCode: result.exitCode } : { ...result };
    case 'read':
      return { type: 'text', file: { filePath: prepared.effect.absPath, ...result } };
    case 'write':
      return { type: 'created' in result && result.created ? 'create' : 'update', filePath: prepared.effect.absPath, content: prepared.effect.afterContent };
    case 'edit':
      return {
        filePath: prepared.effect.absPath,
        oldString: prepared.effect.matchedOldString,
        newString: prepared.args.newString,
        replaceAll: prepared.args.replaceAll ?? false,
      };
    default:
      return { ...result };
  }
}

/** Whether a hook matcher selects a tool name (exact list, `*`/empty, or unanchored RegExp). */
export function matcherMatches(matcher: string | undefined, toolName: string): boolean {
  if (matcher === undefined || matcher === '' || matcher === '*') return true;
  if (/^[A-Za-z0-9_ ,|-]+$/.test(matcher)) {
    return matcher
      .split(/[|,]/)
      .map((s) => s.trim())
      .some((name) => name === toolName);
  }
  try {
    return new RegExp(matcher).test(toolName);
  } catch {
    return true;
  }
}

export function invalidMatcher(matcher: string | undefined): string | undefined {
  if (matcher === undefined || /^([A-Za-z0-9_ ,|-]*|\*)$/.test(matcher)) return undefined;
  try {
    new RegExp(matcher);
    return undefined;
  } catch {
    return `hook matcher ${JSON.stringify(matcher)} is not a valid regular expression`;
  }
}

export interface CompiledHook {
  readonly handler: HookHandler;
  readonly matcher: string | undefined;
  readonly origin: string;
  readonly env: Readonly<Record<string, string>>;
  readonly unsupported: string | undefined;
}

export function unsupportedReason(handler: HookHandler, platform: NodeJS.Platform = process.platform): string | undefined {
  if (handler.onFailure !== undefined && handler.onFailure !== 'continue' && handler.onFailure !== 'block') {
    return `hook onFailure ${JSON.stringify(handler.onFailure)} is not understood`;
  }
  switch (handler.type) {
    case 'command':
      if (handler.command === undefined || handler.command === '') return 'command hook without a command';
      if (handler.shell !== undefined && handler.shell !== 'bash') return `command hook shell ${JSON.stringify(handler.shell)} is not supported`;
      if (handler.args !== undefined && platform === 'win32') return 'exec-form command hooks (`args`) are not supported on Windows';
      // Claude runs shell-form hooks under Git Bash or PowerShell there; the runner can only use cmd.exe.
      if (platform === 'win32') return 'shell-form command hooks are not supported on Windows: the Claude Code hook shell cannot be selected';
      return undefined;
    case 'http':
      if (handler.url === undefined || !/^https?:\/\//i.test(handler.url)) return 'http hook without an http(s) url';
      return undefined;
    case 'prompt':
    case 'agent':
    case 'mcp_tool':
      return `${handler.type} hooks cannot be evaluated outside Claude Code`;
    default:
      return `hook type ${JSON.stringify(handler.type)} is not understood`;
  }
}

export type HookOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'allow' | 'ask'; readonly reason?: string; readonly updatedInput?: Readonly<Record<string, unknown>> }
  | { readonly kind: 'deny'; readonly reason: string }
  | { readonly kind: 'failure'; readonly source: 'hook-error' | 'hook-timeout'; readonly reason: string };

const HookOutputSchema = z.looseObject({
  continue: z.boolean().optional(),
  stopReason: z.string().optional(),
  suppressOutput: z.boolean().optional(),
  systemMessage: z.string().optional(),
  decision: z.string().optional(),
  reason: z.string().optional(),
  hookSpecificOutput: z
    .looseObject({
      hookEventName: z.string().optional(),
      permissionDecision: z.string().optional(),
      permissionDecisionReason: z.string().optional(),
      updatedInput: z.record(z.string(), z.unknown()).optional(),
      additionalContext: z.string().optional(),
    })
    .optional(),
});

export type HookEvent = 'PreToolUse' | 'PostToolUse';

/** Parses a hook's output object (stdout of exit 0, or an HTTP 2xx body). */
export function interpretOutput(text: string, event: HookEvent, label: string): HookOutcome {
  const trimmed = text.trim();
  if (trimmed === '') return { kind: 'none' };
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return { kind: 'failure', source: 'hook-error', reason: `${label} printed output that is not a JSON object` };
  }
  const parsed = HookOutputSchema.safeParse(json);
  if (!parsed.success) return { kind: 'failure', source: 'hook-error', reason: `${label} printed an invalid output object: ${parsed.error.issues[0]?.message ?? 'invalid'}` };
  const out = parsed.data;
  const specific = out.hookSpecificOutput;
  if (specific?.hookEventName !== undefined && specific.hookEventName !== event) {
    return { kind: 'failure', source: 'hook-error', reason: `${label} returned hookSpecificOutput for ${specific.hookEventName}` };
  }
  const pd = specific?.permissionDecision;
  if (pd !== undefined && !['allow', 'deny', 'ask', 'defer'].includes(pd)) {
    return { kind: 'failure', source: 'hook-error', reason: `${label} returned unknown permissionDecision ${JSON.stringify(pd)}` };
  }
  const legacy = out.decision;
  if (legacy !== undefined && legacy !== 'approve' && legacy !== 'block') {
    return { kind: 'failure', source: 'hook-error', reason: `${label} returned unknown decision ${JSON.stringify(legacy)}` };
  }
  const reason = specific?.permissionDecisionReason ?? out.reason ?? out.stopReason;
  if (pd === 'deny' || legacy === 'block') return { kind: 'deny', reason: reason ?? `denied by ${label}` };
  if (out.continue === false) return { kind: 'deny', reason: out.stopReason ?? `${label} returned continue: false` };
  const updatedInput = pd === 'defer' ? undefined : specific?.updatedInput;
  const extra = { ...(reason === undefined ? {} : { reason }), ...(updatedInput === undefined ? {} : { updatedInput }) };
  if (pd === 'ask' || pd === 'defer') return { kind: 'ask', ...extra };
  if (pd === 'allow' || legacy === 'approve') return { kind: 'allow', ...extra };
  if (updatedInput !== undefined) return { kind: 'allow', ...extra, reason: reason ?? `input updated by ${label}` };
  return { kind: 'none' };
}

function shQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

const PLACEHOLDER = /\$\{(CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_ROOT|CLAUDE_PLUGIN_DATA)\}/g;

function substitute(text: string, env: Readonly<Record<string, string>>): string {
  return text.replace(PLACEHOLDER, (_m, name: string) => env[name] ?? '');
}

/** HTTP header values: `$VAR`/`${VAR}` only for names in `allowedEnvVars`, others become empty. */
function interpolateHeader(value: string, allowed: readonly string[], env: Readonly<Record<string, string | undefined>>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, a: string | undefined, b: string | undefined) => {
    const name = a ?? b ?? '';
    return allowed.includes(name) ? (env[name] ?? '') : '';
  });
}

export const DEFAULT_HOOK_TIMEOUT_S = 600;

const MAX_HTTP_BODY_BYTES = 1024 * 1024;

export interface RunHookOptions {
  readonly event: HookEvent;
  readonly input: Readonly<Record<string, unknown>>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

function redactedLabel(hook: CompiledHook): string {
  let what = hook.handler.type;
  if (hook.handler.type === 'http') {
    what = URL.canParse(hook.handler.url ?? '') ? new URL(hook.handler.url ?? '').host : 'http';
  } else {
    const program = (hook.handler.command ?? '').trim().split(/\s+/)[0]?.replace(/^["']|["']$/g, '') ?? '';
    const name = program.split(/[\\/]/).pop() ?? '';
    if (/^[\w.-]{1,64}$/.test(name) && !name.includes('=')) what = name;
  }
  return `${hook.origin} ${hook.handler.type} hook ${JSON.stringify(what)}`;
}

function timeoutMs(handler: HookHandler): number {
  return Math.round((handler.timeout ?? DEFAULT_HOOK_TIMEOUT_S) * 1000);
}

async function runCommand(hook: CompiledHook, opts: RunHookOptions): Promise<HookOutcome> {
  const label = redactedLabel(hook);
  const env = { ...opts.env, ...hook.env };
  const handler = hook.handler;
  const shellForm = handler.shell === 'bash' ? `exec bash -c ${shQuote(handler.command ?? '')}` : (handler.command ?? '');
  const command = handler.args === undefined ? shellForm : `exec ${[handler.command ?? '', ...handler.args].map((w) => shQuote(substitute(w, env))).join(' ')}`;
  const r = await runCommandHook({ command, stdin: JSON.stringify(opts.input), env, cwd: opts.cwd, timeoutMs: timeoutMs(handler), signal: opts.signal });
  if (r.aborted) return { kind: 'failure', source: 'hook-error', reason: `${label} was cancelled` };
  if (r.spawnError !== null) return { kind: 'failure', source: 'hook-error', reason: `${label} could not start` };
  if (r.timedOut) return { kind: 'failure', source: 'hook-timeout', reason: `${label} did not finish within ${timeoutMs(handler)} ms` };
  if (r.exitCode === 2) {
    const stderr = r.stderr.trim();
    return { kind: 'deny', reason: stderr === '' ? `blocked by ${label}` : stderr };
  }
  if (r.exitCode !== 0) {
    const detail = r.exitCode === null ? `was killed by ${r.signal ?? 'a signal'}` : `exited with code ${r.exitCode}`;
    return { kind: 'failure', source: 'hook-error', reason: `${label} ${detail}` };
  }
  if (r.stdoutTruncated) return { kind: 'failure', source: 'hook-error', reason: `${label} printed more output than can be read` };
  return interpretOutput(r.stdout, opts.event, label);
}

async function runHttp(hook: CompiledHook, opts: RunHookOptions): Promise<HookOutcome> {
  const label = redactedLabel(hook);
  const handler = hook.handler;
  const ms = timeoutMs(handler);
  const timeout = AbortSignal.timeout(ms);
  const signal = AbortSignal.any([opts.signal, timeout]);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  for (const [key, value] of Object.entries(handler.headers ?? {})) {
    headers[key] = interpolateHeader(value, handler.allowedEnvVars ?? [], process.env);
  }
  try {
    const res = await fetch(handler.url ?? '', { method: 'POST', headers, body: JSON.stringify(opts.input), signal, redirect: 'error' });
    if (res.status < 200 || res.status > 299) {
      await res.body?.cancel();
      return { kind: 'failure', source: 'hook-error', reason: `${label} returned HTTP ${res.status}` };
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of res.body ?? []) {
      chunks.push(chunk);
      if ((size += chunk.byteLength) > MAX_HTTP_BODY_BYTES) return { kind: 'failure', source: 'hook-error', reason: `${label} returned a body larger than ${MAX_HTTP_BODY_BYTES} bytes` };
    }
    return interpretOutput(Buffer.concat(chunks).toString('utf8'), opts.event, label);
  } catch (err) {
    if (timeout.aborted) return { kind: 'failure', source: 'hook-timeout', reason: `${label} did not answer within ${ms} ms` };
    if (opts.signal.aborted) return { kind: 'failure', source: 'hook-error', reason: `${label} was cancelled` };
    return { kind: 'failure', source: 'hook-error', reason: `${label} request failed (${err instanceof Error ? err.name : 'error'})` };
  }
}

export async function runHook(hook: CompiledHook, opts: RunHookOptions): Promise<HookOutcome> {
  let outcome: HookOutcome;
  try {
    outcome = hook.handler.type === 'http' ? await runHttp(hook, opts) : await runCommand(hook, opts);
  } catch (err) {
    outcome = { kind: 'failure', source: 'hook-error', reason: `${redactedLabel(hook)} failed (${err instanceof Error ? err.name : 'error'})` };
  }
  if (outcome.kind === 'failure' && opts.event === 'PostToolUse' && hook.handler.onFailure === 'continue' && !opts.signal.aborted) return { kind: 'none' };
  return outcome;
}

export type CombinedOutcome =
  | { readonly kind: 'none' | 'allow'; readonly reason?: string; readonly updatedInput?: Readonly<Record<string, unknown>> }
  | { readonly kind: 'ask'; readonly reason: string }
  | { readonly kind: 'deny'; readonly reason: string; readonly source: 'hook' | 'hook-error' | 'hook-timeout' | 'unsupported-config' };

export function combineOutcomes(outcomes: readonly HookOutcome[]): CombinedOutcome {
  const deny = outcomes.find((o) => o.kind === 'deny');
  if (deny?.kind === 'deny') return { kind: 'deny', source: 'hook', reason: deny.reason };
  const failure = outcomes.find((o) => o.kind === 'failure');
  if (failure?.kind === 'failure') return { kind: 'deny', source: failure.source, reason: failure.reason };
  const updates: Readonly<Record<string, unknown>>[] = [];
  for (const o of outcomes) if ((o.kind === 'allow' || o.kind === 'ask') && o.updatedInput !== undefined) updates.push(o.updatedInput);
  if (updates.length > 1) return { kind: 'deny', source: 'unsupported-config', reason: 'more than one hook returned updatedInput for the same call' };
  const ask = outcomes.find((o) => o.kind === 'ask');
  if (ask?.kind === 'ask') return { kind: 'ask', reason: ask.reason ?? 'a PreToolUse hook asked for confirmation' };
  const updatedInput = updates[0];
  const allow = outcomes.find((o) => o.kind === 'allow');
  if (allow?.kind === 'allow') {
    return { kind: 'allow', ...(allow.reason === undefined ? {} : { reason: allow.reason }), ...(updatedInput === undefined ? {} : { updatedInput }) };
  }
  return { kind: 'none' };
}

const BashInputSchema = z.looseObject({
  command: z.string(),
  timeout: z.number().int().positive().optional(),
  description: z.string().optional(),
  run_in_background: z.literal(false).optional(),
  dangerouslyDisableSandbox: z.literal(false).optional(),
});
const ReadInputSchema = z.looseObject({ file_path: z.string(), offset: z.number().int().positive().optional(), limit: z.number().int().positive().optional(), pages: z.undefined().optional() });
const WriteInputSchema = z.looseObject({ file_path: z.string(), content: z.string() });
const EditInputSchema = z.looseObject({ file_path: z.string(), old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional() });
const GrepInputSchema = z.looseObject({
  pattern: z.string(),
  path: z.string().optional(),
  glob: z.string().optional(),
  '-i': z.boolean().optional(),
  output_mode: z.literal('content').optional(),
  '-n': z.literal(true).optional(),
  head_limit: z.number().int().positive().optional(),
});
const GlobInputSchema = z.looseObject({ pattern: z.string(), path: z.string().optional() });

const GREP_UNSUPPORTED = ['-A', '-B', '-C', 'context', 'multiline', 'type', 'offset'];

export function mapUpdatedInput(prepared: PreparedCall, updated: Readonly<Record<string, unknown>>): { args: ToolArgsMap[ToolName] } | { error: string } {
  const fail = (e: z.ZodError): { error: string } => ({ error: `updatedInput for ${NATIVE_TOOL[prepared.tool]} is invalid: ${e.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}` });
  switch (prepared.tool) {
    case 'bash': {
      const r = BashInputSchema.safeParse(updated);
      if (!r.success) return fail(r.error);
      return { args: { command: r.data.command, cwd: prepared.args.cwd ?? prepared.effect.cwd, timeoutMs: r.data.timeout ?? prepared.effect.timeoutMs } };
    }
    case 'read': {
      const r = ReadInputSchema.safeParse(updated);
      if (!r.success) return fail(r.error);
      return { args: { path: r.data.file_path, ...(r.data.offset === undefined ? {} : { offset: r.data.offset }), ...(r.data.limit === undefined ? {} : { limit: r.data.limit }) } };
    }
    case 'write': {
      const r = WriteInputSchema.safeParse(updated);
      if (!r.success) return fail(r.error);
      return { args: { path: r.data.file_path, content: r.data.content } };
    }
    case 'edit': {
      const r = EditInputSchema.safeParse(updated);
      if (!r.success) return fail(r.error);
      return { args: { path: r.data.file_path, oldString: r.data.old_string, newString: r.data.new_string, ...(r.data.replace_all === undefined ? {} : { replaceAll: r.data.replace_all }) } };
    }
    case 'grep': {
      const bad = GREP_UNSUPPORTED.filter((k) => k in updated);
      if (bad.length > 0) return { error: `updatedInput for Grep sets ${bad.join(', ')}, which agent-code-mode cannot honor` };
      const r = GrepInputSchema.safeParse(updated);
      if (!r.success) return fail(r.error);
      return {
        args: {
          pattern: r.data.pattern,
          ...(r.data.path === undefined ? {} : { path: r.data.path }),
          ...(r.data.glob === undefined ? {} : { glob: r.data.glob }),
          ...(r.data['-i'] === undefined ? {} : { ignoreCase: r.data['-i'] }),
          maxResults: r.data.head_limit ?? prepared.effect.maxResults,
        },
      };
    }
    case 'glob': {
      const r = GlobInputSchema.safeParse(updated);
      if (!r.success) return fail(r.error);
      return { args: { pattern: r.data.pattern, ...(r.data.path === undefined ? {} : { path: r.data.path }), maxResults: prepared.effect.maxResults } };
    }
  }
}
