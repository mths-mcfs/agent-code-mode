import { z } from 'zod';
import type { ArmId, ParsedRun, ToolCalls } from './record.ts';

/** Native file and shell tools of Claude Code. Using one of them in the agent-code-mode arm is a fallback. */
export const CLAUDE_NATIVE_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'NotebookEdit'];
export const CLAUDE_RUN_TOOL = 'mcp__agent-code-mode__run';

export interface ClaudeCommandOptions {
  readonly arm: ArmId;
  readonly model: string;
  readonly effort: string;
  readonly maxTurns: number;
  /** Settings file passed with `--settings` (permissions and hooks). */
  readonly settingsFile: string;
  /** MCP config file passed with `--mcp-config`. */
  readonly mcpConfigFile: string;
}

/** Arguments for `claude`; the prompt goes on stdin. */
export function claudeArgs(o: ClaudeCommandOptions): string[] {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', o.model,
    '--effort', o.effort,
    '--max-turns', String(o.maxTurns),
    '--setting-sources', 'project',
    '--no-session-persistence',
    '--permission-mode', 'default',
    '--settings', o.settingsFile,
    '--strict-mcp-config',
    '--mcp-config', o.mcpConfigFile,
  ];
  if (o.arm === 'A') args.push('--allowedTools', 'Bash,Read,Write,Edit,Glob,Grep');
  else args.push('--allowedTools', CLAUDE_RUN_TOOL, '--disallowedTools', 'Bash,Read,Write,Edit,Glob,Grep,NotebookEdit');
  return args;
}

/** The `--mcp-config` content for an arm: no servers for A, the agent-code-mode server for B. */
export function claudeMcpConfig(arm: ArmId, serverEntry: string): unknown {
  if (arm === 'A') return { mcpServers: {} };
  return { mcpServers: { 'agent-code-mode': { type: 'stdio', command: process.execPath, args: [serverEntry, 'serve', '--host', 'claude'] } } };
}

const UsageEvent = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_creation_input_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
  output_tokens_details: z.object({ thinking_tokens: z.number().optional() }).passthrough().optional(),
}).passthrough();

const ResultEvent = z.object({
  type: z.literal('result'),
  subtype: z.string(),
  is_error: z.boolean(),
  num_turns: z.number().int(),
  duration_ms: z.number(),
  total_cost_usd: z.number(),
  result: z.string().optional(),
  usage: UsageEvent,
  modelUsage: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const ContentBlock = z.object({ type: z.string() }).passthrough();
const ToolUse = z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string() }).passthrough();
const ToolResult = z.object({ type: z.literal('tool_result'), tool_use_id: z.string(), content: z.unknown() }).passthrough();
const MessageEvent = z.object({ type: z.enum(['assistant', 'user']), message: z.object({ content: z.union([z.string(), z.array(ContentBlock)]) }).passthrough() }).passthrough();
const InitEvent = z.object({ type: z.literal('system'), subtype: z.literal('init'), model: z.string(), tools: z.array(z.string()).optional() }).passthrough();

/** The agent-code-mode `run` result as the server returns it (only the fields the bench reads). */
const RunResultText = z.object({ calls: z.array(z.object({ tool: z.string(), decision: z.string() }).passthrough()) }).passthrough();

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        const parsed = z.object({ type: z.literal('text'), text: z.string() }).safeParse(c);
        return parsed.success ? parsed.data.text : '';
      })
      .join('');
  }
  return '';
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

export function classifyClaudeTool(name: string): 'native' | 'run' | 'other' {
  if (name === CLAUDE_RUN_TOOL) return 'run';
  if (CLAUDE_NATIVE_TOOLS.includes(name)) return 'native';
  return 'other';
}

/** Parses a `claude -p --output-format stream-json --verbose` transcript. Throws when there is no result event. */
export function parseClaudeTranscript(text: string): ParsedRun {
  const lines = text.split('\n');
  const seenToolUse = new Set<string>();
  const runToolUses = new Set<string>();
  const seenToolResult = new Set<string>();
  const calls: ToolCalls = { native: 0, run: 0, codeMode: 0, other: 0, byName: {} };
  const inner: Record<string, number> = {};
  let innerTotal = 0;
  let innerSeen = false;
  let model: string | null = null;
  let availableTools: string[] | null = null;
  let result: z.infer<typeof ResultEvent> | undefined;
  const evidence: Record<string, number[]> = { result: [], toolUse: [], innerCalls: [] };

  lines.forEach((line, i) => {
    if (line.trim() === '') return;
    const event = parseJson(line);
    const init = InitEvent.safeParse(event);
    if (init.success) {
      model = init.data.model;
      availableTools = init.data.tools ?? null;
      evidence['init'] = [i + 1];
      return;
    }
    const res = ResultEvent.safeParse(event);
    if (res.success) {
      result = res.data;
      evidence['result'] = [i + 1];
      return;
    }
    const msg = MessageEvent.safeParse(event);
    if (!msg.success || typeof msg.data.message.content === 'string') return;
    for (const block of msg.data.message.content) {
      const use = ToolUse.safeParse(block);
      if (use.success && msg.data.type === 'assistant' && !seenToolUse.has(use.data.id)) {
        seenToolUse.add(use.data.id);
        const kind = classifyClaudeTool(use.data.name);
        calls[kind] += 1;
        calls.byName[use.data.name] = (calls.byName[use.data.name] ?? 0) + 1;
        if (kind === 'run') runToolUses.add(use.data.id);
        evidence['toolUse']?.push(i + 1);
      }
      const tr = ToolResult.safeParse(block);
      // A result can be replayed in the stream (e.g. on resume); count each tool_use_id once.
      if (tr.success && runToolUses.has(tr.data.tool_use_id) && !seenToolResult.has(tr.data.tool_use_id)) {
        seenToolResult.add(tr.data.tool_use_id);
        const parsed = RunResultText.safeParse(parseJson(textOf(tr.data.content)));
        if (parsed.success) {
          innerSeen = true;
          for (const call of parsed.data.calls) {
            innerTotal += 1;
            inner[call.tool] = (inner[call.tool] ?? 0) + 1;
          }
          evidence['innerCalls']?.push(i + 1);
        }
      }
    }
  });

  if (result === undefined) throw new Error('no result event in the Claude transcript');
  const r: z.infer<typeof ResultEvent> = result;
  return {
    turns: r.num_turns,
    hostDurationMs: r.duration_ms,
    usage: {
      input: r.usage.input_tokens,
      output: r.usage.output_tokens,
      cacheCreation: r.usage.cache_creation_input_tokens ?? 0,
      cacheRead: r.usage.cache_read_input_tokens ?? 0,
      reasoning: r.usage.output_tokens_details?.thinking_tokens ?? null,
    },
    hostCostUsd: r.total_cost_usd,
    model: model ?? (r.modelUsage ? (Object.keys(r.modelUsage)[0] ?? null) : null),
    finalAnswer: r.result ?? '',
    toolCalls: calls,
    innerCalls: innerSeen ? { total: innerTotal, byTool: inner } : null,
    availableTools,
    hostError: r.is_error ? `${r.subtype}` : null,
    evidence,
  };
}
