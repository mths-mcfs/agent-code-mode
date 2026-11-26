import { z } from 'zod';

export const HOST_ARMS = { claude: ['A', 'B', 'C', 'D'], codex: ['A', 'B', 'C'] } as const;
export type ArmId = 'A' | 'B' | 'C' | 'D';
/**
 * Baseline arms: the strict agent-code-mode arm of a host (Claude B, Codex C) run against another build of
 * agent-code-mode (`--acm-ref` / `--acm-dist`), so two versions are measured in the same matrix.
 */
export const BASELINE_ARMS = { claude: 'B0', codex: 'C0' } as const;
export type BenchArm = ArmId | 'B0' | 'C0';
export const BENCH_ARMS: readonly BenchArm[] = ['A', 'B', 'C', 'D', 'B0', 'C0'];

/**
 * The arm whose tool surface a bench arm uses (a baseline arm is its host's strict agent-code-mode arm).
 * `C0` is Codex only: `planRuns` never pairs it with Claude, whose `C` is the hybrid arm.
 */
export function surfaceArm(arm: BenchArm): ArmId {
  return arm === 'B0' ? 'B' : arm === 'C0' ? 'C' : arm;
}

/** True for the arms that run an agent-code-mode build (Claude B and C, Codex C). */
export function isAcmArm(host: 'claude' | 'codex', arm: BenchArm): boolean {
  const s = surfaceArm(arm);
  return host === 'claude' ? s === 'B' || s === 'C' : s === 'C';
}

/** True for the arm where the model may mix native tools and `run` (Claude C). */
export function isHybridArm(host: 'claude' | 'codex', arm: ArmId): boolean {
  return host === 'claude' && arm === 'C';
}

/** Arms a host runs: its own arms plus, with a baseline build, its baseline arm. */
export function hostArms(host: 'claude' | 'codex', withBaseline: boolean): BenchArm[] {
  return withBaseline ? [...HOST_ARMS[host], BASELINE_ARMS[host]] : [...HOST_ARMS[host]];
}

export const ARM_LABELS: Readonly<Record<'claude' | 'codex', Readonly<Record<string, string>>>> = {
  claude: { A: 'native tools', B: 'agent-code-mode (strict)', C: 'agent-code-mode hybrid (native + run, batching guidance)', D: 'Claude Code Code Mode (REPL, interactive)', B0: 'agent-code-mode baseline build (strict)' },
  codex: { A: 'native tools (direct)', B: 'Codex code mode', C: 'agent-code-mode (strict)', C0: 'agent-code-mode baseline build (strict)' },
};

const Counts = z.record(z.string(), z.number().int().nonnegative());

export const UsageSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheCreation: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  /** Reasoning tokens when the host reports them separately (already included in `output` on Codex). */
  reasoning: z.number().nonnegative().nullable(),
  cacheCreation5m: z.number().nonnegative().optional(),
  cacheCreation1h: z.number().nonnegative().optional(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const ToolCallsSchema = z.object({
  native: z.number().int().nonnegative(),
  run: z.number().int().nonnegative(),
  codeMode: z.number().int().nonnegative(),
  other: z.number().int().nonnegative(),
  byName: Counts,
});
export type ToolCalls = z.infer<typeof ToolCallsSchema>;

export const ParsedRunSchema = z.object({
  turns: z.number().int().nonnegative().nullable(),
  requests: z.number().int().nonnegative().nullable().default(null),
  hostDurationMs: z.number().nonnegative().nullable(),
  usage: UsageSchema.nullable(),
  hostCostUsd: z.number().nonnegative().nullable(),
  model: z.string().nullable(),
  finalAnswer: z.string(),
  toolCalls: ToolCallsSchema,
  innerCalls: z.object({ total: z.number().int().nonnegative(), byTool: Counts }).nullable(),
  availableTools: z.array(z.string()).nullable(),
  denials: z.array(z.string()).nullable().default(null),
  hostContext: z.object({ agents: z.array(z.string()), plugins: z.array(z.string()), memory: z.boolean() }).nullable().default(null),
  hostError: z.string().nullable(),
  evidence: z.record(z.string(), z.array(z.number().int().positive())),
  /**
   * Calls to a task's MCP tools: `direct` made by the model as tool calls, `script` from inside scripts
   * (agent-code-mode `mcpCall`, Claude Code Mode REPL, Codex code mode `exec`). Null for tasks without one.
   */
  mcpCalls: z.object({ direct: z.number().int().nonnegative(), script: z.number().int().nonnegative() }).nullable().default(null),
});
export type ParsedRun = z.infer<typeof ParsedRunSchema>;

export const RunRecordSchema = z.object({
  schema: z.literal(1),
  id: z.string(),
  configHash: z.string().regex(/^[0-9a-f]{12}$/),
  config: z.record(z.string(), z.unknown()),
  host: z.enum(['claude', 'codex']),
  arm: z.enum(['A', 'B', 'C', 'D', 'B0', 'C0']),
  armLabel: z.string(),
  /** A warmup run: made before the matrix to warm the prompt cache, kept apart and out of every statistic. */
  warmup: z.boolean().default(false),
  task: z.string(),
  run: z.number().int().positive(),
  round: z.number().int().positive(),
  orderIndex: z.number().int().nonnegative(),
  dryRun: z.boolean(),
  model: z.string(),
  effort: z.string(),
  startedAt: z.string(),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  wallMs: z.number().nonnegative(),
  parsed: ParsedRunSchema.nullable(),
  parseError: z.string().nullable(),
  costUsd: z.number().nonnegative().nullable(),
  costSource: z.enum(['host', 'pricing.json', 'none']),
  verify: z.object({ pass: z.boolean(), details: z.array(z.string()) }),
  fallback: z.boolean(),
  valid: z.boolean(),
  invalidReasons: z.array(z.string()),
  files: z.record(z.string(), z.string()),
  /**
   * Interactive Claude runs: the session's own cost record, which also counts requests the transcript lacks
   * (session title, side calls). `costUsd` covers the transcript's requests only, like a `-p` run.
   */
  hostSessionCostUsd: z.number().nonnegative().nullable().default(null),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

export interface ArmCheck {
  readonly fallback: boolean;
  readonly reasons: readonly string[];
}

export function checkArm(host: 'claude' | 'codex', arm: ArmId, observed: ToolCalls, taskServer?: string): ArmCheck {
  const reasons: string[] = [];
  const taskCalls = taskServer === undefined ? 0 : mcpCallCounts({ toolCalls: observed, innerCalls: null }, taskServer).direct;
  const calls: ToolCalls = { ...observed, other: Math.max(0, observed.other - taskCalls) };
  const total = calls.native + calls.run + calls.codeMode + calls.other;
  if (isHybridArm(host, arm)) {
    // The model picks per call: native only, run only and any mix are all the arm as labeled.
    if (calls.codeMode > 0) reasons.push('hybrid agent-code-mode arm used Codex code mode');
    if (calls.other > 0) reasons.push(`hybrid agent-code-mode arm made ${calls.other} call(s) to tools outside its surface`);
    return { fallback: false, reasons };
  }
  if (host === 'claude' && arm === 'D') {
    if (calls.codeMode === 0) reasons.push('Code Mode arm made no REPL call');
    if (calls.run > 0) reasons.push('Code Mode arm made agent-code-mode run calls');
    if (calls.native > 0) reasons.push(`Code Mode arm made ${calls.native} direct native file/shell tool call(s)`);
    if (calls.other > 0) reasons.push(`Code Mode arm made ${calls.other} call(s) to tools outside its surface`);
    return { fallback: false, reasons };
  }
  const acm = (host === 'claude' && arm === 'B') || (host === 'codex' && arm === 'C');
  if (acm) {
    if (calls.run === 0) reasons.push('agent-code-mode arm made no run call');
    if (calls.codeMode > 0) reasons.push('agent-code-mode arm used Codex code mode');
    if (calls.native > 0) reasons.push(`strict agent-code-mode arm made ${calls.native} native file/shell tool call(s)`);
    return { fallback: calls.native > 0, reasons };
  }
  if (calls.run > 0) reasons.push('arm made agent-code-mode run calls');
  if (host === 'codex' && arm === 'B') {
    if (calls.codeMode === 0 && total > 0) reasons.push('Codex code-mode arm made tool calls outside exec');
    if (calls.native > 0) reasons.push('Codex code-mode arm made direct native tool calls');
  } else if (calls.codeMode > 0) {
    reasons.push(host === 'claude' ? 'native arm used Claude Code Mode' : 'native arm used Codex code mode');
  }
  return { fallback: false, reasons };
}

/** A tool name of a task's MCP server as either host writes it: `mcp__<server>__<tool>`, or Codex `mcp__<server>__.<tool>`, `mcp__<server>.<tool>`. */
export function taskToolName(name: string, server: string): string | null {
  const m = /^(?:exec\.)?mcp__(.+?)(?:__\.|__|\.)([A-Za-z0-9_-]+)$/.exec(name);
  return m !== null && m[1]?.replace(/-/g, '_') === server.replace(/-/g, '_') ? (m[2] ?? null) : null;
}

export function mcpCallCounts(parsed: Pick<ParsedRun, 'toolCalls' | 'innerCalls'>, server: string): { direct: number; script: number } {
  const sum = (counts: Readonly<Record<string, number>>): number => Object.entries(counts).reduce((n, [tool, k]) => n + (taskToolName(tool, server) === null ? 0 : k), 0);
  return { direct: sum(parsed.toolCalls.byName), script: parsed.innerCalls === null ? 0 : sum(parsed.innerCalls.byTool) };
}

export function checkMcpCalls(host: 'claude' | 'codex', arm: ArmId, counts: { direct: number; script: number }): ArmCheck {
  if (isHybridArm(host, arm)) return { fallback: false, reasons: counts.direct + counts.script === 0 ? ['hybrid arm made no MCP call, direct or from a script'] : [] };
  if (arm === 'A') {
    const reasons = [...(counts.direct === 0 ? ['native arm made no direct MCP tool call'] : []), ...(counts.script > 0 ? [`native arm made ${counts.script} MCP call(s) from scripts`] : [])];
    return { fallback: false, reasons };
  }
  const reasons = [...(counts.script === 0 ? ['script arm made no MCP call from a script'] : []), ...(counts.direct > 0 ? [`script arm made ${counts.direct} direct MCP tool call(s)`] : [])];
  return { fallback: counts.direct > 0, reasons };
}

export const CLAUDE_ARM_SURFACE: Readonly<Record<ArmId, readonly string[]>> = {
  A: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
  B: ['mcp__agent-code-mode__run'],
  C: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'mcp__agent-code-mode__run'],
  D: ['REPL', 'REPL.Bash', 'REPL.Read', 'REPL.Write', 'REPL.Edit', 'REPL.Glob', 'REPL.Grep'],
};
/**
 * Tools every interactive session sends whatever `--tools` says (the `-p` init event lists none of them):
 * the deferred-loading placeholder, the account's advisor, Code Mode's `Poll` and `EndConversation`.
 */
export const CLAUDE_INTERACTIVE_HARNESS_TOOLS = ['DeferredToolPlaceholder', 'advisor', 'Poll', 'EndConversation', 'REPL.EndConversation', 'REPL.Poll'];
export const CODEX_COMMON_NON_FILE = ['list_mcp_resource_templates', 'list_mcp_resources', 'read_mcp_resource', 'request_user_input'];
const CODEX_FILE_SHELL = ['exec_command', 'write_stdin', 'apply_patch'];
const CODEX_CODE_MODE = ['exec', 'wait'];
const isRunTool = (t: string): boolean => /^mcp__agent[-_]code[-_]mode(__|\.)run$/.test(t);

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const x = [...new Set(a)].sort();
  const y = [...new Set(b)].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

export function checkSurface(host: 'claude' | 'codex', arm: ArmId, all: readonly string[], task?: { readonly server: string; readonly tools: readonly string[] }): string[] {
  const reasons: string[] = [];
  const isTask = (t: string): boolean => task !== undefined && taskToolName(t, task.server) !== null;
  if (task !== undefined) {
    const seen = new Set(all.map((t) => taskToolName(t, task.server)));
    const missing = task.tools.filter((t) => !seen.has(t));
    if (missing.length > 0) reasons.push(`arm ${arm} does not list the task's MCP tools ${missing.join(', ')}`);
  }
  const tools = all.filter((t) => !isTask(t));
  if (host === 'claude') {
    const expected = CLAUDE_ARM_SURFACE[arm];
    if (!sameSet(tools.filter((t) => !CLAUDE_INTERACTIVE_HARNESS_TOOLS.includes(t)), expected)) reasons.push(`Claude arm ${arm} tools are [${[...tools].sort().join(', ')}], expected exactly [${[...expected].sort().join(', ')}]`);
    return reasons;
  }
  const apps = tools.filter((t) => t.includes('codex_apps'));
  if (apps.length > 0) reasons.push(`Codex account apps are exposed (${apps.length} tools): the run is not isolated`);
  const nested = tools.filter((t) => t.startsWith('exec.')).map((t) => t.slice('exec.'.length));
  const direct = tools.filter((t) => !t.startsWith('exec.')).map((t) => (isRunTool(t) ? 'run' : t.slice(t.lastIndexOf('.') + 1)));
  const reachable = [...direct, ...nested];
  const nonFile = reachable.filter((t) => !CODEX_FILE_SHELL.includes(t) && !CODEX_CODE_MODE.includes(t) && t !== 'run');
  if (!sameSet(nonFile, CODEX_COMMON_NON_FILE)) reasons.push(`Codex arm ${arm} non-file tools are [${[...new Set(nonFile)].sort().join(', ')}], expected exactly [${CODEX_COMMON_NON_FILE.join(', ')}]`);
  const fileDirect = direct.filter((t) => CODEX_FILE_SHELL.includes(t));
  const codeMode = direct.filter((t) => CODEX_CODE_MODE.includes(t));
  const run = direct.includes('run');
  if (arm === 'A' && (!sameSet(fileDirect, CODEX_FILE_SHELL) || codeMode.length > 0 || run)) reasons.push('native arm is not exactly the direct file/shell tools');
  if (arm === 'B' && (fileDirect.length > 0 || !sameSet(codeMode, CODEX_CODE_MODE) || run || !CODEX_FILE_SHELL.every((t) => nested.includes(t)))) reasons.push('Codex code-mode arm is not exec/wait with the file/shell tools nested');
  if (arm === 'C' && (fileDirect.length > 0 || codeMode.length > 0 || nested.length > 0)) reasons.push(`agent-code-mode arm sees native or code-mode tools: ${[...fileDirect, ...codeMode].join(', ')}`);
  if (arm === 'C' && !run) reasons.push('agent-code-mode arm does not see the run tool directly (deferred behind tool_search, or server not configured)');
  return reasons;
}
