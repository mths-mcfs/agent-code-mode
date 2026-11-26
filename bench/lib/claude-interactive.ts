import { z } from 'zod';
import { CLAUDE_INNER_ALLOWED, CLAUDE_NATIVE_TOOLS, CLAUDE_RUN_TOOL, ClaudeUsageEvent, claudeUsage, DENIAL_TEXT } from './claude.ts';
import type { ParsedRun, ToolCalls, Usage } from './record.ts';

/**
 * Arm D: Claude Code's own Code Mode. It exists only in an interactive terminal session (`-p` and the Agent
 * SDK lack it), so the run is driven in tmux (`tmux.ts`) and read from the transcript the session writes to
 * `$CLAUDE_CONFIG_DIR/projects/<cwd slug>/<session id>.jsonl` (Claude Code 2.1.326).
 *
 * Transcript shape: one assistant entry per content block of a model response, all with the same
 * `message.id` and final usage. The model calls `REPL`, and each tool call its script makes is a synthetic
 * assistant entry (`model: "<synthetic>"`, `isVirtual`, zero usage) with its own tool result.
 * `api-request-shape` lists the request's tools (the REPL description lists what a script can call),
 * `api-request` its parameters, and `system/turn_duration` closes a turn.
 */

const CODE_MODE_ENV = 'CLAUDE_CODE_EXPERIMENTAL_CODE_MODE';
const REPL_TOOL = 'REPL';
const SYNTHETIC_MODEL = '<synthetic>';

interface InteractiveArgsOptions {
  readonly model: string;
  readonly effort: string;
  readonly settingsFile: string;
  readonly mcpConfigFile: string;
  readonly sessionId: string;
}

/**
 * The `-p` flags of arm A that exist in a terminal session (the driver enforces `--max-turns`), plus
 * `--session-id` so the transcript file is known. A REPL script reaches only the session's tools, so the
 * native tools stay in `--tools` next to `REPL`, allowed by arm A's rules.
 */
export function claudeInteractiveArgs(o: InteractiveArgsOptions): string[] {
  return [
    '--model', o.model,
    '--effort', o.effort,
    '--setting-sources', 'project',
    '--permission-mode', 'default',
    '--settings', o.settingsFile,
    '--strict-mcp-config',
    '--mcp-config', o.mcpConfigFile,
    '--session-id', o.sessionId,
    '--tools', [...CLAUDE_INNER_ALLOWED, REPL_TOOL].join(','),
    '--allowedTools', CLAUDE_INNER_ALLOWED.join(','),
  ];
}

const INTERACTIVE_ENV_PASSTHROUGH = ['HOME', 'PATH', 'LANG', 'LC_ALL', 'USER', 'SHELL', 'TMPDIR'];

/**
 * An allowlist: a session started with `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT` or another `CLAUDE_CODE_*` of
 * a parent session refuses Code Mode. No API key either: the run signs in with the copied credentials file.
 */
export function interactiveEnv(source: Readonly<Record<string, string | undefined>>, configDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of INTERACTIVE_ENV_PASSTHROUGH) {
    const v = source[k];
    if (v !== undefined && v !== '') env[k] = v;
  }
  return {
    ...env,
    TERM: 'xterm-256color',
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    DISABLE_AUTOUPDATER: '1',
    [CODE_MODE_ENV]: '1',
  };
}

/**
 * `.claude.json` for the temporary config dir, so the session opens straight on the prompt. Each key answers
 * one first-run dialog (Claude Code 2.1.326): onboarding, folder trust, the Code Mode confirmation (without
 * it the session also restarts itself) and the Chrome extension offer. Release notes and the marketplace
 * auto-install are marked done so the session neither shows nor fetches them.
 */
export function seededClaudeJson(workspace: string, version: string): Record<string, unknown> {
  return {
    hasCompletedOnboarding: true,
    lastOnboardingVersion: version,
    lastReleaseNotesSeen: version,
    codeModeCaveatsAcceptedV1: true,
    codeModeAutoModeCaveatAcceptedV1: true,
    claudeInChromeDefaultEnabled: false,
    officialMarketplaceAutoInstallAttempted: true,
    projects: { [workspace]: { allowedTools: [], hasTrustDialogAccepted: true } },
  };
}

export function claudeSemver(versionOutput: string | null | undefined): string {
  const m = /\d+\.\d+\.\d+/.exec(versionOutput ?? '');
  return m ? m[0] : (versionOutput ?? '');
}

const Block = z.object({ type: z.string() }).passthrough();
const ToolUseBlock = z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string() }).passthrough();
const ToolResultBlock = z.object({ type: z.literal('tool_result'), tool_use_id: z.string(), content: z.unknown(), is_error: z.boolean().optional() }).passthrough();
const TextBlock = z.object({ type: z.literal('text'), text: z.string() }).passthrough();
const AssistantEntry = z.object({
  type: z.literal('assistant'),
  isVirtual: z.boolean().optional(),
  message: z.object({ id: z.string().min(1), model: z.string(), stop_reason: z.string().nullable().optional(), content: z.array(Block), usage: z.unknown().optional() }).passthrough(),
}).passthrough();
const UserEntry = z.object({
  type: z.literal('user'),
  isMeta: z.boolean().optional(),
  message: z.object({ content: z.union([z.string(), z.array(Block)]) }).passthrough(),
  permissionDecision: z.object({ decision: z.string() }).passthrough().optional(),
}).passthrough();
const ShapeEntry = z.object({ type: z.literal('api-request-shape'), shape: z.object({ tools: z.array(z.object({ name: z.string(), description: z.string().optional() }).passthrough()) }).passthrough() }).passthrough();
const RequestEntry = z.object({ type: z.literal('api-request'), params: z.object({ output_config: z.object({ effort: z.string().optional() }).passthrough().optional() }).passthrough() }).passthrough();
const TurnEnd = z.object({ type: z.literal('system'), subtype: z.literal('turn_duration'), durationMs: z.number().nonnegative() }).passthrough();
const Attachment = z.object({ type: z.literal('attachment'), attachment: z.object({ type: z.string() }).passthrough() }).passthrough();
const AgentListing = z.object({ type: z.literal('agent_listing_delta'), addedTypes: z.array(z.string()) }).passthrough();
const PermissionMode = z.object({ type: z.literal('permission-mode'), permissionMode: z.string() }).passthrough();
const ReplMode = z.object({ type: z.literal('repl-mode'), replMode: z.boolean() }).passthrough();
const ModelCost = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cacheReadInputTokens: z.number().nonnegative(),
  cacheCreationEphemeral5mInputTokens: z.number().nonnegative(),
  cacheCreationEphemeral1hInputTokens: z.number().nonnegative(),
  costUSD: z.number().nonnegative(),
}).passthrough();
const CostState = z.object({ type: z.literal('cost-state'), totalCostUSD: z.number().nonnegative(), modelUsage: z.record(z.string(), ModelCost) }).passthrough();
type SessionModelCost = z.infer<typeof ModelCost>;

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => {
    const t = TextBlock.safeParse(c);
    return t.success ? t.data.text : '';
  }).join('');
}

export function replScriptTools(description: string): string[] {
  const names = new Set<string>();
  const start = description.indexOf('interface Tools {');
  if (start < 0) return [];
  const block = description.slice(start);
  for (const m of block.matchAll(/^ {2}([A-Za-z][A-Za-z0-9_]*)\(input/gm)) if (m[1] !== undefined) names.add(m[1]);
  const also = /Also callable as tools\.<name>\(input\)[^:\n]*:([^\n]*)/.exec(block);
  for (const n of also?.[1]?.split(',') ?? []) if (/^[A-Za-z][A-Za-z0-9_]*$/.test(n.trim())) names.add(n.trim());
  return [...names];
}

const SENSITIVE_TYPES = new Set(['api-request-blob', 'session-owner', 'file-history-snapshot']);
const SENSITIVE_ATTACHMENTS = new Set(['session_context', 'credential_org', 'prompt_snapshot', 'remote_session_change', 'environment']);
const SENSITIVE_KEYS = ['serverClassifierContext'];

export function trimInteractiveTranscript(text: string): string {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const value = parseJson(line);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      // Kept as is, so the parser reports it instead of a trimmed transcript hiding it.
      out.push(line);
      continue;
    }
    const entry: Record<string, unknown> = { ...value };
    if (typeof entry['type'] === 'string' && SENSITIVE_TYPES.has(entry['type'])) continue;
    const att = Attachment.safeParse(entry);
    if (att.success && SENSITIVE_ATTACHMENTS.has(att.data.attachment.type)) continue;
    const shape = ShapeEntry.safeParse(entry);
    if (shape.success) {
      const tools = shape.data.shape.tools.map((t) => (t.name === REPL_TOOL ? { name: t.name, description: t.description } : { name: t.name }));
      out.push(JSON.stringify({ type: 'api-request-shape', shape: { tools } }));
      continue;
    }
    for (const k of SENSITIVE_KEYS) delete entry[k];
    out.push(JSON.stringify(entry));
  }
  return out.length === 0 ? '' : `${out.join('\n')}\n`;
}

export interface InteractiveFacts {
  readonly efforts: readonly string[];
  readonly permissionModes: readonly string[];
  readonly replMode: boolean;
  readonly innerByTool: Readonly<Record<string, number>>;
  /** Usage of the model responses by the model that made them. */
  readonly usageByModel: Readonly<Record<string, Usage>>;
  /** The last `cost-state` entry: every request of the session, side calls the transcript lacks included. */
  readonly sessionCost: { readonly totalUsd: number; readonly byModel: Readonly<Record<string, SessionModelCost>> } | null;
}

export interface InteractiveProgress {
  readonly promptSeen: boolean;
  readonly outerToolUses: number;
  readonly finished: boolean;
}

interface Scan {
  promptSeen: boolean;
  requests: Map<string, { usage: Usage | null; model: string }>;
  unreadable: number[];
  lastRealId: string | null;
  lastRealStop: string | null;
  lastRealLine: number;
  lastTurnEndLine: number;
  outerToolUses: Map<string, string>;
  outerResults: Set<string>;
  innerByTool: Record<string, number>;
  innerTotal: number;
  calls: ToolCalls;
  textById: Map<string, string[]>;
  denials: string[];
  deniedIds: Set<string>;
  topTools: Set<string>;
  scriptTools: Set<string>;
  efforts: string[];
  permissionModes: string[];
  replMode: boolean;
  interrupted: boolean;
  agents: Set<string>;
  memory: boolean;
  durationMs: number | null;
  model: string | null;
  sessionCost: InteractiveFacts['sessionCost'];
  evidence: Record<string, number[]>;
}

function classify(name: string): keyof Omit<ToolCalls, 'byName'> {
  if (name === REPL_TOOL) return 'codeMode';
  if (name === CLAUDE_RUN_TOOL) return 'run';
  if (CLAUDE_NATIVE_TOOLS.includes(name)) return 'native';
  return 'other';
}

function addUsage(a: Usage, b: Usage): Usage {
  const sum: Usage = {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheCreation: a.cacheCreation + b.cacheCreation,
    cacheRead: a.cacheRead + b.cacheRead,
    reasoning: a.reasoning === null && b.reasoning === null ? null : (a.reasoning ?? 0) + (b.reasoning ?? 0),
  };
  // A response without the split keeps the others' split: its own writes stay outside it, priced at 5 minutes.
  if (a.cacheCreation1h !== undefined || b.cacheCreation1h !== undefined) sum.cacheCreation1h = (a.cacheCreation1h ?? 0) + (b.cacheCreation1h ?? 0);
  if (a.cacheCreation5m !== undefined || b.cacheCreation5m !== undefined) sum.cacheCreation5m = (a.cacheCreation5m ?? 0) + (b.cacheCreation5m ?? 0);
  return sum;
}

function push(s: Scan, key: string, line: number): void {
  (s.evidence[key] ??= []).push(line);
}

function scan(text: string): Scan {
  const s: Scan = {
    promptSeen: false,
    requests: new Map(),
    unreadable: [],
    lastRealId: null,
    lastRealStop: null,
    lastRealLine: 0,
    lastTurnEndLine: 0,
    outerToolUses: new Map(),
    outerResults: new Set(),
    innerByTool: {},
    innerTotal: 0,
    calls: { native: 0, run: 0, codeMode: 0, other: 0, byName: {} },
    textById: new Map(),
    denials: [],
    deniedIds: new Set(),
    topTools: new Set(),
    scriptTools: new Set(),
    efforts: [],
    permissionModes: [],
    replMode: false,
    interrupted: false,
    agents: new Set(),
    memory: false,
    durationMs: null,
    model: null,
    sessionCost: null,
    evidence: {},
  };
  const seenInner = new Set<string>();
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    const n = i + 1;
    const event = parseJson(line);
    const isEntry = event !== null && typeof event === 'object' && !Array.isArray(event);
    const type = isEntry && 'type' in event ? event.type : undefined;
    const a = AssistantEntry.safeParse(event);
    const u = UserEntry.safeParse(event);
    if (!isEntry || (type === 'assistant' && !a.success) || (type === 'user' && !u.success)) {
      s.unreadable.push(n);
      return;
    }
    if (a.success) {
      const m = a.data.message;
      const synthetic = m.model === SYNTHETIC_MODEL || a.data.isVirtual === true;
      for (const block of m.content) {
        const use = ToolUseBlock.safeParse(block);
        if (!use.success) continue;
        if (synthetic) {
          if (seenInner.has(use.data.id)) continue;
          seenInner.add(use.data.id);
          s.innerByTool[use.data.name] = (s.innerByTool[use.data.name] ?? 0) + 1;
          s.innerTotal += 1;
          push(s, 'innerCalls', n);
        } else if (!s.outerToolUses.has(use.data.id)) {
          s.outerToolUses.set(use.data.id, use.data.name);
          s.calls[classify(use.data.name)] += 1;
          s.calls.byName[use.data.name] = (s.calls.byName[use.data.name] ?? 0) + 1;
          push(s, 'toolUse', n);
        }
      }
      if (synthetic) return;
      if (!s.requests.has(m.id)) {
        const usage = ClaudeUsageEvent.safeParse(m.usage);
        s.requests.set(m.id, { usage: usage.success ? claudeUsage(usage.data) : null, model: m.model });
        push(s, 'requests', n);
      }
      s.model ??= m.model;
      const texts = s.textById.get(m.id) ?? [];
      for (const block of m.content) {
        const t = TextBlock.safeParse(block);
        if (t.success) texts.push(t.data.text);
      }
      s.textById.set(m.id, texts);
      s.lastRealId = m.id;
      s.lastRealStop = m.stop_reason ?? null;
      s.lastRealLine = n;
      return;
    }
    if (u.success) {
      const content = u.data.message.content;
      if (typeof content === 'string') {
        if (u.data.isMeta !== true) s.promptSeen = true;
        return;
      }
      for (const block of content) {
        const t = TextBlock.safeParse(block);
        if (t.success && t.data.text.startsWith('[Request interrupted by user')) s.interrupted = true;
        else if (t.success && u.data.isMeta !== true) s.promptSeen = true;
        const r = ToolResultBlock.safeParse(block);
        if (!r.success) continue;
        const outer = s.outerToolUses.get(r.data.tool_use_id);
        if (outer !== undefined) s.outerResults.add(r.data.tool_use_id);
        // A REPL result repeats its script's refusals, which count from the script's own calls.
        if (outer === REPL_TOOL || s.deniedIds.has(r.data.tool_use_id)) continue;
        const body = textOf(r.data.content);
        if (u.data.permissionDecision?.decision === 'reject' || (r.data.is_error === true && DENIAL_TEXT.test(body))) {
          s.deniedIds.add(r.data.tool_use_id);
          s.denials.push(body.slice(0, 500));
          push(s, 'denials', n);
        }
      }
      return;
    }
    const shape = ShapeEntry.safeParse(event);
    if (shape.success) {
      for (const t of shape.data.shape.tools) {
        s.topTools.add(t.name);
        if (t.name === REPL_TOOL && t.description !== undefined) for (const inner of replScriptTools(t.description)) s.scriptTools.add(inner);
      }
      push(s, 'tools', n);
      return;
    }
    const req = RequestEntry.safeParse(event);
    if (req.success) {
      const effort = req.data.params.output_config?.effort;
      if (effort !== undefined && !s.efforts.includes(effort)) s.efforts.push(effort);
      return;
    }
    const end = TurnEnd.safeParse(event);
    if (end.success) {
      s.lastTurnEndLine = n;
      s.durationMs = (s.durationMs ?? 0) + end.data.durationMs;
      push(s, 'turnEnd', n);
      return;
    }
    const pm = PermissionMode.safeParse(event);
    if (pm.success) {
      if (!s.permissionModes.includes(pm.data.permissionMode)) s.permissionModes.push(pm.data.permissionMode);
      return;
    }
    const cost = CostState.safeParse(event);
    if (cost.success) {
      s.sessionCost = { totalUsd: cost.data.totalCostUSD, byModel: cost.data.modelUsage };
      s.evidence['costState'] = [n];
      return;
    }
    const rm = ReplMode.safeParse(event);
    if (rm.success) {
      s.replMode ||= rm.data.replMode;
      return;
    }
    const att = Attachment.safeParse(event);
    if (att.success) {
      const agents = AgentListing.safeParse(att.data.attachment);
      if (agents.success) for (const t of agents.data.addedTypes) s.agents.add(t);
      if (/memory/i.test(att.data.attachment.type)) s.memory = true;
    }
  });
  return s;
}

function finishedOf(s: Scan): boolean {
  const pending = [...s.outerToolUses.keys()].some((id) => !s.outerResults.has(id));
  return s.lastRealStop === 'end_turn' && !pending && s.lastTurnEndLine > s.lastRealLine;
}

export function interactiveProgress(text: string): InteractiveProgress {
  const s = scan(text);
  return { promptSeen: s.promptSeen, outerToolUses: s.outerToolUses.size, finished: finishedOf(s) };
}

export function parseClaudeInteractiveTranscript(text: string): { parsed: ParsedRun; facts: InteractiveFacts } {
  const s = scan(text);
  if (s.requests.size === 0) throw new Error('no model response in the interactive Claude transcript');
  let usage: Usage | null = null;
  if (s.unreadable.length > 0) throw new Error(`interactive Claude transcript line(s) ${s.unreadable.join(', ')} are not readable entries`);
  const usageByModel: Record<string, Usage> = {};
  for (const [id, r] of s.requests) {
    if (r.usage === null) throw new Error(`model response ${id} has no usage in the interactive Claude transcript`);
    usage = usage === null ? r.usage : addUsage(usage, r.usage);
    const prev = usageByModel[r.model];
    usageByModel[r.model] = prev === undefined ? r.usage : addUsage(prev, r.usage);
  }
  const finished = finishedOf(s);
  const finalAnswer = finished && s.lastRealId !== null ? (s.textById.get(s.lastRealId) ?? []).join('') : '';
  const parsed: ParsedRun = {
    turns: s.outerToolUses.size + 1,
    requests: s.requests.size,
    hostDurationMs: s.durationMs,
    usage,
    hostCostUsd: null,
    model: s.model,
    finalAnswer,
    toolCalls: s.calls,
    innerCalls: s.calls.codeMode > 0 || s.replMode ? { total: s.innerTotal, byTool: { ...s.innerByTool } } : null,
    availableTools: s.topTools.size === 0 ? null : [...s.topTools, ...[...s.scriptTools].map((t) => `${REPL_TOOL}.${t}`)],
    denials: s.denials,
    // The transcript has no plugin list: the runner reads it from the session's .claude.json.
    hostContext: { agents: [...s.agents], plugins: [], memory: s.memory },
    hostError: s.interrupted ? 'turn interrupted' : finished ? null : 'turn did not finish',
    evidence: s.evidence,
  };
  return { parsed, facts: { efforts: s.efforts, permissionModes: s.permissionModes, replMode: s.replMode, innerByTool: { ...s.innerByTool }, usageByModel, sessionCost: s.sessionCost } };
}
