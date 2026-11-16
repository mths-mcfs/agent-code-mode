import { z } from 'zod';
import type { ArmId, ParsedRun, ToolCalls } from './record.ts';

/**
 * Codex CLI 0.169 facts the arms depend on (checked with `codex debug prompt-input`, no model calls):
 * - Every model in the shipped catalog has `tool_mode: "code_mode_only"`: the model only sees `exec`
 *   (JavaScript that calls nested tools). `features.code_mode` does not change that.
 * - A catalog with `tool_mode: "direct"` (config `model_catalog_json`) gives the classic direct tools
 *   (`exec_command`, `apply_patch`, ...). That is the native arm.
 * - `features.shell_tool = false` removes `exec_command`/`write_stdin`; `apply_patch_tool_type: null`
 *   in the catalog removes `apply_patch`. Together they leave no native file/shell tool (arm C).
 * - MCP tools are listed behind `tool_search`; approval is set per server with `default_tools_approval_mode`.
 */

/** Model-visible native tool names in direct mode. */
export const CODEX_NATIVE_TOOLS = ['exec_command', 'write_stdin', 'apply_patch', 'shell', 'local_shell', 'container.exec'];
export const CODEX_CODE_MODE_TOOLS = ['exec', 'wait'];
export const CODEX_SERVER_NAME = 'agent-code-mode';

export interface CodexHomeOptions {
  readonly arm: ArmId;
  readonly model: string;
  readonly effort: string;
  readonly codexHome: string;
  /** Path of the catalog override file (arms A and C). */
  readonly catalogFile: string | null;
  readonly serverEntry: string;
  readonly nodePath: string;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** `config.toml` for the temporary CODEX_HOME of one run. */
export function codexConfigToml(o: CodexHomeOptions): string {
  const lines = [
    `model = ${tomlString(o.model)}`,
    `model_reasoning_effort = ${tomlString(o.effort)}`,
    'approval_policy = "never"',
    'sandbox_mode = "workspace-write"',
    'suppress_unstable_features_warning = true',
  ];
  if (o.catalogFile !== null) lines.push(`model_catalog_json = ${tomlString(o.catalogFile)}`);
  lines.push('', '[features]', 'hooks = true');
  if (o.arm === 'B') lines.push('code_mode = true');
  if (o.arm === 'C') {
    lines.push('shell_tool = false');
    lines.push(
      '',
      `[mcp_servers.${CODEX_SERVER_NAME}]`,
      `command = ${tomlString(o.nodePath)}`,
      `args = [${[o.serverEntry, 'serve', '--host', 'codex'].map(tomlString).join(', ')}]`,
      'default_tools_approval_mode = "approve"',
      '',
      `[mcp_servers.${CODEX_SERVER_NAME}.env]`,
      `CODEX_HOME = ${tomlString(o.codexHome)}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

const CatalogSchema = z.object({ models: z.array(z.object({ slug: z.string() }).passthrough()) }).passthrough();

/** The catalog override for an arm, from the raw `codex debug models` output; null when the arm uses the shipped catalog. */
export function catalogForArm(arm: ArmId, rawCatalog: string): string | null {
  if (arm === 'B') return null;
  const catalog = CatalogSchema.parse(JSON.parse(rawCatalog));
  const models = catalog.models.map((m) => ({ ...m, tool_mode: 'direct', ...(arm === 'C' ? { apply_patch_tool_type: null } : {}) }));
  return `${JSON.stringify({ ...catalog, models })}\n`;
}

export function catalogHasModel(rawCatalog: string, model: string): boolean {
  return CatalogSchema.parse(JSON.parse(rawCatalog)).models.some((m) => m.slug === model);
}

/** `hooks.json` for the temporary CODEX_HOME when a task installs the protect-file hook. */
export function codexHooksJson(matcher: string, command: string): string {
  return `${JSON.stringify({ hooks: { PreToolUse: [{ matcher, hooks: [{ type: 'command', command, timeout: 30 }] }] } }, null, 2)}\n`;
}

/** Arguments for `codex`; the prompt goes on stdin (`-`). */
export function codexArgs(workspace: string, withHooks: boolean): string[] {
  return ['exec', '--json', '-C', workspace, ...(withHooks ? ['--dangerously-bypass-hook-trust'] : []), '-'];
}

// --- Rollout extraction ------------------------------------------------------------------------

const RolloutLine = z.object({ type: z.string(), payload: z.unknown() }).passthrough();
const TokenRecord = z.object({
  usage: z.object({ input_tokens: z.number(), cached_input_tokens: z.number(), output_tokens: z.number() }).passthrough(),
}).passthrough();
const CallItem = z.object({
  type: z.enum(['function_call', 'custom_tool_call']),
  name: z.string(),
  namespace: z.string().optional(),
  arguments: z.string().optional(),
  input: z.string().optional(),
}).passthrough();

/**
 * Keeps only what the bench needs from a Codex rollout file (which also holds account ids and the
 * full prompt): one `request` line per model response with its usage, one `call` line per tool call
 * the model made, in order.
 */
export function extractCodexRequests(rollout: string): string {
  const out: string[] = [];
  for (const line of rollout.split('\n')) {
    if (line.trim() === '') continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const entry = RolloutLine.safeParse(raw);
    if (!entry.success) continue;
    if (entry.data.type === 'token_usage_record') {
      const rec = TokenRecord.safeParse(entry.data.payload);
      if (rec.success) out.push(JSON.stringify({ kind: 'request', usage: rec.data.usage }));
    } else if (entry.data.type === 'response_item') {
      const call = CallItem.safeParse(entry.data.payload);
      if (call.success) {
        const args = (call.data.arguments ?? call.data.input ?? '').slice(0, 4000);
        out.push(JSON.stringify({ kind: 'call', type: call.data.type, name: call.data.name, ...(call.data.namespace ? { namespace: call.data.namespace } : {}), args }));
      }
    }
  }
  return out.length > 0 ? `${out.join('\n')}\n` : '';
}

// --- Transcript parsing ------------------------------------------------------------------------

const TurnCompleted = z.object({
  type: z.literal('turn.completed'),
  usage: z.object({
    input_tokens: z.number(),
    cached_input_tokens: z.number(),
    cache_write_input_tokens: z.number().optional(),
    output_tokens: z.number(),
    reasoning_output_tokens: z.number().optional(),
  }).passthrough(),
}).passthrough();
const ItemEvent = z.object({ type: z.literal('item.completed'), item: z.object({ type: z.string() }).passthrough() }).passthrough();
const AgentMessage = z.object({ type: z.literal('agent_message'), text: z.string() }).passthrough();
const McpItem = z.object({ type: z.literal('mcp_tool_call'), server: z.string(), tool: z.string(), result: z.unknown().optional() }).passthrough();
const Failure = z.object({ type: z.enum(['turn.failed', 'error']), error: z.object({ message: z.string() }).passthrough().optional(), message: z.string().optional() }).passthrough();
const RequestLine = z.object({ kind: z.literal('request'), usage: TokenRecord.shape.usage });
const CallLine = z.object({ kind: z.literal('call'), type: z.string(), name: z.string(), namespace: z.string().optional() });
const RunResultText = z.object({ calls: z.array(z.object({ tool: z.string() }).passthrough()) }).passthrough();
const McpResult = z.object({ content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()) }).passthrough();

export function classifyCodexTool(name: string, namespace?: string): 'native' | 'run' | 'codeMode' | 'other' {
  // Exactly the agent-code-mode server's `run` tool, as Codex names MCP tools (`mcp__<server>__<tool>`,
  // or a `mcp__<server>__` namespace plus `run`); the server name may appear with `-` or `_`.
  const full = namespace ? `${namespace.replace(/\.$/, '')}${namespace.endsWith('__') ? '' : '__'}${name}` : name;
  if (/^mcp__agent[-_]code[-_]mode__run$/.test(full)) return 'run';
  if (CODEX_CODE_MODE_TOOLS.includes(name)) return 'codeMode';
  if (CODEX_NATIVE_TOOLS.includes(name)) return 'native';
  return 'other';
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/**
 * Parses a `codex exec --json` transcript plus the requests file extracted from the rollout.
 * Usage is summed over `turn.completed` events; `input` is uncached input (input − cached − cache write),
 * `output` includes reasoning tokens (OpenAI usage semantics). Turns are model requests, counted from
 * the rollout; null without it. Throws when there is no `turn.completed` event.
 */
export function parseCodexTranscript(json: string, requests: string | null): ParsedRun {
  const evidence: Record<string, number[]> = { turnCompleted: [], agentMessage: [], innerItems: [], requests: [], calls: [] };
  let input = 0;
  let cached = 0;
  let cacheWrite = 0;
  let output = 0;
  let reasoning: number | null = null;
  let finalAnswer = '';
  let hostError: string | null = null;
  let innerItems = 0;
  const innerByType: Record<string, number> = {};
  const runInner: Record<string, number> = {};
  let runInnerTotal = 0;
  let runInnerSeen = false;
  const jsonCalls: ToolCalls = { native: 0, run: 0, codeMode: 0, other: 0, byName: {} };

  json.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    const event = parseJson(line);
    const turn = TurnCompleted.safeParse(event);
    if (turn.success) {
      const u = turn.data.usage;
      input += u.input_tokens;
      cached += u.cached_input_tokens;
      cacheWrite += u.cache_write_input_tokens ?? 0;
      output += u.output_tokens;
      if (u.reasoning_output_tokens !== undefined) reasoning = (reasoning ?? 0) + u.reasoning_output_tokens;
      evidence['turnCompleted']?.push(i + 1);
      return;
    }
    const fail = Failure.safeParse(event);
    if (fail.success && fail.data.type === 'turn.failed') hostError = fail.data.error?.message ?? fail.data.message ?? 'turn failed';
    const item = ItemEvent.safeParse(event);
    if (!item.success) return;
    const msg = AgentMessage.safeParse(item.data.item);
    if (msg.success) {
      finalAnswer = msg.data.text;
      evidence['agentMessage'] = [i + 1];
      return;
    }
    const type = item.data.item.type;
    if (type === 'command_execution' || type === 'file_change' || type === 'mcp_tool_call' || type === 'web_search') {
      innerItems += 1;
      innerByType[type] = (innerByType[type] ?? 0) + 1;
      evidence['innerItems']?.push(i + 1);
    }
    const mcp = McpItem.safeParse(item.data.item);
    if (mcp.success) {
      const name = `mcp__${mcp.data.server}__${mcp.data.tool}`;
      const kind = mcp.data.server === CODEX_SERVER_NAME && mcp.data.tool === 'run' ? 'run' : 'other';
      jsonCalls[kind] += 1;
      jsonCalls.byName[name] = (jsonCalls.byName[name] ?? 0) + 1;
      const result = McpResult.safeParse(mcp.data.result);
      if (kind === 'run' && result.success) {
        const text = result.data.content.map((c) => c.text ?? '').join('');
        const log = RunResultText.safeParse(parseJson(text));
        if (log.success) {
          runInnerSeen = true;
          for (const c of log.data.calls) {
            runInnerTotal += 1;
            runInner[c.tool] = (runInner[c.tool] ?? 0) + 1;
          }
        }
      }
    } else if (type === 'command_execution' || type === 'file_change') {
      jsonCalls.native += 1;
      jsonCalls.byName[type] = (jsonCalls.byName[type] ?? 0) + 1;
    }
  });
  if ((evidence['turnCompleted']?.length ?? 0) === 0) throw new Error('no turn.completed event in the Codex transcript');

  let turns: number | null = null;
  let calls = jsonCalls;
  if (requests !== null && requests.trim() !== '') {
    turns = 0;
    calls = { native: 0, run: 0, codeMode: 0, other: 0, byName: {} };
    requests.split('\n').forEach((line, i) => {
      if (line.trim() === '') return;
      const value = parseJson(line);
      if (RequestLine.safeParse(value).success) {
        turns = (turns ?? 0) + 1;
        evidence['requests']?.push(i + 1);
        return;
      }
      const call = CallLine.safeParse(value);
      if (call.success) {
        const kind = classifyCodexTool(call.data.name, call.data.namespace);
        calls[kind] += 1;
        const name = call.data.namespace ? `${call.data.namespace}.${call.data.name}` : call.data.name;
        calls.byName[name] = (calls.byName[name] ?? 0) + 1;
        evidence['calls']?.push(i + 1);
      }
    });
  }

  // With code mode off, command/file items in the --json stream are calls the model made itself
  // (run calls show up as mcp_tool_call items), so they are native even when the rollout misses them.
  if (calls.codeMode === 0 && jsonCalls.native > calls.native) {
    calls = { ...calls, native: jsonCalls.native, byName: { ...calls.byName } };
    for (const kind of ['command_execution', 'file_change']) {
      const n = jsonCalls.byName[kind];
      if (n !== undefined) calls.byName[kind] = n;
    }
  }

  const innerCalls = runInnerSeen
    ? { total: runInnerTotal, byTool: runInner }
    : calls.codeMode > 0
      ? { total: innerItems, byTool: innerByType }
      : null;

  return {
    turns,
    hostDurationMs: null,
    usage: { input: Math.max(0, input - cached - cacheWrite), output, cacheCreation: cacheWrite, cacheRead: cached, reasoning },
    hostCostUsd: null,
    model: null,
    finalAnswer,
    toolCalls: calls,
    innerCalls,
    availableTools: null,
    hostError,
    evidence,
  };
}

const PromptItem = z.object({ type: z.string(), tools: z.array(z.unknown()).optional() }).passthrough();
const ToolEntry = z.object({ type: z.string(), name: z.string().optional(), tools: z.array(z.unknown()).optional() }).passthrough();

/** Model-visible tool names (namespace.name) from `codex debug prompt-input` output. */
export function codexToolSurface(promptInput: string): string[] {
  const items = z.array(PromptItem).parse(JSON.parse(promptInput));
  const names: string[] = [];
  const walk = (tools: readonly unknown[], prefix: string): void => {
    for (const raw of tools) {
      const t = ToolEntry.safeParse(raw);
      if (!t.success) continue;
      if (t.data.type === 'namespace' && t.data.tools) walk(t.data.tools, `${prefix}${t.data.name ?? ''}.`);
      else names.push(`${prefix}${t.data.name ?? t.data.type}`);
    }
  };
  for (const item of items) if (item.type === 'additional_tools' && item.tools) walk(item.tools, '');
  return names;
}
