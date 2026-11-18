import { z } from 'zod';
import { CLAUDE_INNER_ALLOWED, CLAUDE_NATIVE_TOOLS, CLAUDE_RUN_TOOL, claudeUsage, contextOf, DENIAL_TEXT } from './claude.ts';
import type { ParsedRun, ToolCalls, Usage } from './record.ts';

/**
 * Claude Code interactive sessions (arm D, Claude Code's own experimental Code Mode, and the native
 * interactive pilot). Code Mode exists only in an interactive terminal session (`-p` and the Agent SDK do
 * not have it), so these runs are driven through tmux (`tmux.ts`) and read from the session transcript
 * Claude Code writes to `$CLAUDE_CONFIG_DIR/projects/<cwd slug>/<session id>.jsonl` (checked with
 * Claude Code 2.1.326).
 *
 * Transcript shape: an assistant entry per content block of each model response (same `message.id`,
 * same final usage); in Code Mode the model calls `REPL` and every tool call its script makes is written
 * as a synthetic assistant entry (`model: "<synthetic>"`, `isVirtual`, zero usage) with its own tool
 * result. `api-request-shape` lists the tools of the request (the REPL description lists the tools a
 * script can call), `api-request` the request parameters (effort), `system/turn_duration` closes a turn.
 */

/** Code Mode is on only with this variable, in an interactive session. */
export const CODE_MODE_ENV = 'CLAUDE_CODE_EXPERIMENTAL_CODE_MODE';
export const REPL_TOOL = 'REPL';
const SYNTHETIC_MODEL = '<synthetic>';

export interface InteractiveArgsOptions {
  readonly codeMode: boolean;
  readonly model: string;
  readonly effort: string;
  readonly settingsFile: string;
  readonly mcpConfigFile: string;
  readonly sessionId: string;
}

/**
 * Arguments of an interactive `claude`: the `-p` flags of the other arms that exist in a terminal session
 * (`--max-turns` does not: the driver enforces the turn cap and the timeout), plus `--session-id` so the
 * transcript file is known. Code Mode needs `REPL` in `--tools`; the native tools stay listed because a
 * REPL script reaches only the tools of the session. The allow rules are arm A's in both cases.
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
    '--tools', (o.codeMode ? [...CLAUDE_INNER_ALLOWED, REPL_TOOL] : CLAUDE_INNER_ALLOWED).join(','),
    '--allowedTools', CLAUDE_INNER_ALLOWED.join(','),
  ];
}

/** Variables an interactive host gets from the harness environment (an allowlist: nothing of the calling session). */
export const INTERACTIVE_ENV_PASSTHROUGH = ['HOME', 'PATH', 'LANG', 'LC_ALL', 'USER', 'SHELL', 'TMPDIR'];

/**
 * The environment of an interactive host. An allowlist, not a denylist: a Claude Code session started
 * with `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT` or other `CLAUDE_CODE_*` of a parent session refuses Code
 * Mode. No API key variables either: the run authenticates with the copied credentials file, like `-p`.
 */
export function interactiveEnv(source: Readonly<Record<string, string | undefined>>, o: { configDir: string; codeMode: boolean }): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of INTERACTIVE_ENV_PASSTHROUGH) {
    const v = source[k];
    if (v !== undefined && v !== '') env[k] = v;
  }
  return {
    ...env,
    TERM: 'xterm-256color',
    CLAUDE_CONFIG_DIR: o.configDir,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    DISABLE_AUTOUPDATER: '1',
    ...(o.codeMode ? { [CODE_MODE_ENV]: '1' } : {}),
  };
}

/**
 * `.claude.json` written into the temporary config dir so the first session opens straight on the prompt.
 * Each key answers one first-run dialog, found by running a fresh config dir and diffing the file after
 * each dialog (Claude Code 2.1.326): theme and security notes (`hasCompletedOnboarding`,
 * `lastOnboardingVersion`), folder trust (`projects[cwd].hasTrustDialogAccepted`), the Code Mode
 * confirmation (`codeModeCaveatsAcceptedV1`, `codeModeAutoModeCaveatAcceptedV1`; without them it also
 * restarts itself), the Chrome extension offer (`claudeInChromeDefaultEnabled: false`). Release notes and
 * the official plugin marketplace auto-install are marked done so the session neither shows nor fetches them.
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

/** The semver of `claude --version` output (`2.1.326 (Claude Code)`), or the text as is. */
export function claudeSemver(versionOutput: string | null | undefined): string {
  const m = /\d+\.\d+\.\d+/.exec(versionOutput ?? '');
  return m ? m[0] : (versionOutput ?? '');
}

// ---------------------------------------------------------------------------------------------------
// Transcript

const Block = z.object({ type: z.string() }).passthrough();
const ToolUseBlock = z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string() }).passthrough();
const ToolResultBlock = z.object({ type: z.literal('tool_result'), tool_use_id: z.string(), content: z.unknown(), is_error: z.boolean().optional() }).passthrough();
const TextBlock = z.object({ type: z.literal('text'), text: z.string() }).passthrough();
const UsageSchema = z.object({ input_tokens: z.number(), output_tokens: z.number() }).passthrough();

const AssistantEntry = z.object({
  type: z.literal('assistant'),
  isVirtual: z.boolean().optional(),
  message: z.object({
    id: z.string().min(1),
    model: z.string(),
    stop_reason: z.string().nullable().optional(),
    content: z.array(Block),
    usage: UsageSchema.nullable().optional(),
  }).passthrough(),
}).passthrough();
const UserEntry = z.object({
  type: z.literal('user'),
  isMeta: z.boolean().optional(),
  message: z.object({ content: z.union([z.string(), z.array(Block)]) }).passthrough(),
  permissionDecision: z.object({ decision: z.string() }).passthrough().optional(),
}).passthrough();
const ShapeEntry = z.object({ type: z.literal('api-request-shape'), shape: z.object({ tools: z.array(z.object({ name: z.string(), description: z.string().optional() }).passthrough()) }).passthrough() }).passthrough();
const RequestEntry = z.object({ type: z.literal('api-request'), params: z.object({ model: z.string().optional(), output_config: z.object({ effort: z.string().optional() }).passthrough().optional() }).passthrough() }).passthrough();
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
export type SessionModelCost = z.infer<typeof ModelCost>;

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

/**
 * The tools a REPL script can call, from the REPL tool description: the members of its `interface Tools`
 * block and the names after "Also callable as tools.<name>(input); ...:".
 */
export function replScriptTools(description: string): string[] {
  const names = new Set<string>();
  const start = description.indexOf('interface Tools {');
  if (start >= 0) {
    for (const m of description.slice(start).matchAll(/^ {2}([A-Za-z][A-Za-z0-9_]*)\(input/gm)) if (m[1] !== undefined) names.add(m[1]);
    const also = /Also callable as tools\.<name>\(input\)[^:\n]*:([^\n]*)/.exec(description.slice(start));
    if (also?.[1] !== undefined) for (const n of also[1].split(',')) if (/^[A-Za-z][A-Za-z0-9_]*$/.test(n.trim())) names.add(n.trim());
  }
  return [...names];
}

/** Entry kinds and attachments removed before a transcript is kept: system prompt copies and account details. */
const DROP_TYPES = new Set(['api-request-blob', 'session-owner', 'file-history-snapshot']);
const DROP_ATTACHMENTS = new Set(['session_context', 'credential_org', 'prompt_snapshot', 'remote_session_change', 'environment']);
const DROP_KEYS = ['serverClassifierContext'];

/**
 * The transcript as kept with the run: without the request blobs (full system prompt and messages), the
 * account entries and attachments, and with each `api-request-shape` cut to its tool names (plus the REPL
 * description, which lists what a script can call). Everything the parser reads stays, so the parser runs
 * on this form and its evidence line numbers point into the kept file.
 */
export function trimInteractiveTranscript(text: string): string {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const value = parseJson(line);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry: Record<string, unknown> = { ...value };
    const type = typeof entry['type'] === 'string' ? entry['type'] : '';
    if (DROP_TYPES.has(type)) continue;
    const att = Attachment.safeParse(entry);
    if (att.success && DROP_ATTACHMENTS.has(att.data.attachment.type)) continue;
    const shape = ShapeEntry.safeParse(entry);
    if (shape.success) {
      const tools = shape.data.shape.tools.map((t) => (t.name === REPL_TOOL ? { name: t.name, description: t.description } : { name: t.name }));
      out.push(JSON.stringify({ type: 'api-request-shape', shape: { tools } }));
      continue;
    }
    for (const k of DROP_KEYS) delete entry[k];
    out.push(JSON.stringify(entry));
  }
  return out.length === 0 ? '' : `${out.join('\n')}\n`;
}

/** What the transcript says about the run beyond the metrics: checked by the runner for validity. */
export interface InteractiveFacts {
  /** `output_config.effort` of the model requests (distinct values in order). */
  readonly efforts: readonly string[];
  /** Permission modes the session recorded (distinct). */
  readonly permissionModes: readonly string[];
  /** True when the session recorded Code Mode (`repl-mode` true). */
  readonly replMode: boolean;
  /** The last turn ended: a `turn_duration` entry after the last model response, which stopped with `end_turn`. */
  readonly finished: boolean;
  /** A turn was cut by the user (a denial that stops the turn, or Esc). */
  readonly interrupted: boolean;
  /** Tool calls made inside REPL scripts, by tool. */
  readonly innerByTool: Readonly<Record<string, number>>;
  /**
   * The session's own cost record (last `cost-state` entry): every request of the session, including the
   * ones that never reach the transcript (session title, other side calls), by model. Null when absent.
   */
  readonly sessionCost: { readonly totalUsd: number; readonly byModel: Readonly<Record<string, SessionModelCost>> } | null;
}

export interface InteractiveParse {
  readonly parsed: ParsedRun;
  readonly facts: InteractiveFacts;
}

/** Progress of a session while it runs (the driver polls it): model tool calls so far and whether the turn ended. */
export interface InteractiveProgress {
  readonly promptSeen: boolean;
  readonly outerToolUses: number;
  readonly finished: boolean;
}

interface Scan {
  readonly lines: number;
  promptSeen: boolean;
  requestOrder: string[];
  requests: Map<string, { usage: Usage; model: string; line: number }>;
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

function classify(name: string): 'native' | 'run' | 'codeMode' | 'other' {
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
  if (a.cacheCreation1h !== undefined && b.cacheCreation1h !== undefined) sum.cacheCreation1h = a.cacheCreation1h + b.cacheCreation1h;
  if (a.cacheCreation5m !== undefined && b.cacheCreation5m !== undefined) sum.cacheCreation5m = a.cacheCreation5m + b.cacheCreation5m;
  return sum;
}

const ClaudeUsage = z.object({
  input_tokens: z.number().nonnegative(),
  output_tokens: z.number().nonnegative(),
  cache_creation_input_tokens: z.number().nonnegative().optional(),
  cache_read_input_tokens: z.number().nonnegative().optional(),
  output_tokens_details: z.object({ thinking_tokens: z.number().optional() }).passthrough().nullable().optional(),
  cache_creation: z.object({ ephemeral_5m_input_tokens: z.number().nonnegative(), ephemeral_1h_input_tokens: z.number().nonnegative() }).passthrough().nullable().optional(),
}).passthrough();

function scan(text: string): Scan {
  const lines = text.split('\n');
  const s: Scan = {
    lines: lines.length,
    promptSeen: false,
    requestOrder: [],
    requests: new Map(),
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
    evidence: { toolUse: [], innerCalls: [], requests: [], turnEnd: [], denials: [] },
  };
  const seenInner = new Set<string>();
  lines.forEach((line, i) => {
    if (line.trim() === '') return;
    const n = i + 1;
    const event = parseJson(line);
    const a = AssistantEntry.safeParse(event);
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
          s.evidence['innerCalls']?.push(n);
        } else if (!s.outerToolUses.has(use.data.id)) {
          s.outerToolUses.set(use.data.id, use.data.name);
          const kind = classify(use.data.name);
          s.calls[kind] += 1;
          s.calls.byName[use.data.name] = (s.calls.byName[use.data.name] ?? 0) + 1;
          s.evidence['toolUse']?.push(n);
        }
      }
      if (synthetic) return;
      // One response is written as one entry per content block, each with the response's final usage.
      if (!s.requests.has(m.id)) {
        const usage = ClaudeUsage.safeParse(m.usage);
        if (usage.success) {
          s.requests.set(m.id, { usage: claudeUsage(usage.data), model: m.model, line: n });
          s.requestOrder.push(m.id);
          s.evidence['requests']?.push(n);
        }
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
    const u = UserEntry.safeParse(event);
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
        // A REPL result repeats the refusals of its script; they are counted from the script's own calls.
        if (outer === REPL_TOOL || s.deniedIds.has(r.data.tool_use_id)) continue;
        const rejected = u.data.permissionDecision?.decision === 'reject';
        const body = textOf(r.data.content);
        if (rejected || (r.data.is_error === true && DENIAL_TEXT.test(body))) {
          s.deniedIds.add(r.data.tool_use_id);
          s.denials.push(body.slice(0, 500));
          s.evidence['denials']?.push(n);
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
      s.evidence['tools'] = [...(s.evidence['tools'] ?? []), n];
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
      s.evidence['turnEnd']?.push(n);
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

/** Cheap progress read for the driver; never throws. */
export function interactiveProgress(text: string): InteractiveProgress {
  const s = scan(text);
  return { promptSeen: s.promptSeen, outerToolUses: s.outerToolUses.size, finished: finishedOf(s) };
}

/**
 * Parses an interactive session transcript (trimmed or not). Requests are the distinct model responses
 * (`message.id`, synthetic entries excluded) and the usage is their sum; `turns` counts like `-p`
 * `num_turns` (the model's tool calls plus one); REPL calls are `codeMode` calls and the calls their
 * scripts made are `innerCalls`. `hostCostUsd` stays null: the session's `cost-state` also covers requests
 * the transcript does not have (it goes to `facts.sessionCost`), while `-p` reports exactly its
 * transcript's requests, so the comparable cost is computed from this usage. Throws when there is no model
 * response.
 */
export function parseClaudeInteractiveTranscript(text: string): InteractiveParse {
  const s = scan(text);
  if (s.requestOrder.length === 0) throw new Error('no model response in the interactive Claude transcript');
  let usage: Usage | null = null;
  for (const id of s.requestOrder) {
    const r = s.requests.get(id);
    if (r !== undefined) usage = usage === null ? r.usage : addUsage(usage, r.usage);
  }
  const finished = finishedOf(s);
  const finalAnswer = finished && s.lastRealId !== null ? (s.textById.get(s.lastRealId) ?? []).join('') : '';
  const tools = [...s.topTools, ...[...s.scriptTools].map((t) => `${REPL_TOOL}.${t}`)];
  const replUsed = s.calls.codeMode > 0;
  const parsed: ParsedRun = {
    turns: s.outerToolUses.size + 1,
    requests: s.requestOrder.length,
    hostDurationMs: s.durationMs,
    usage,
    hostCostUsd: null,
    model: s.model,
    finalAnswer,
    toolCalls: s.calls,
    innerCalls: replUsed || s.replMode ? { total: s.innerTotal, byTool: { ...s.innerByTool } } : null,
    availableTools: s.topTools.size === 0 ? null : tools,
    denials: s.denials,
    // Plugins are not in the transcript: the runner fills them from the session's .claude.json.
    hostContext: { agents: [...s.agents], plugins: [], memory: s.memory },
    hostError: s.interrupted ? 'turn interrupted' : finished ? null : 'turn did not finish',
    evidence: s.evidence,
    context: contextOf(s.requestOrder.flatMap((id) => {
      const u = s.requests.get(id)?.usage;
      return u === undefined ? [] : [u.input + u.cacheRead + u.cacheCreation];
    })),
    // Set by the runner, which knows the task's MCP server.
    mcpCalls: null,
  };
  return {
    parsed,
    facts: { efforts: s.efforts, permissionModes: s.permissionModes, replMode: s.replMode, finished, interrupted: s.interrupted, innerByTool: { ...s.innerByTool }, sessionCost: s.sessionCost },
  };
}
