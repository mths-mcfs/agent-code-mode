import { z } from 'zod';

/** Arms per host. Claude: A native, B agent-code-mode. Codex: A native, B Codex code mode, C agent-code-mode. */
export const HOST_ARMS = { claude: ['A', 'B'], codex: ['A', 'B', 'C'] } as const;
export type ArmId = 'A' | 'B' | 'C';

export const ARM_LABELS: Readonly<Record<'claude' | 'codex', Readonly<Record<string, string>>>> = {
  claude: { A: 'native tools', B: 'agent-code-mode (strict)' },
  codex: { A: 'native tools (direct)', B: 'Codex code mode', C: 'agent-code-mode (strict)' },
};

const Counts = z.record(z.string(), z.number().int().nonnegative());

export const UsageSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheCreation: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  /** Reasoning tokens when the host reports them separately (already included in `output` on Codex). */
  reasoning: z.number().nonnegative().nullable(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const ToolCallsSchema = z.object({
  /** Native file/shell tool calls made by the model (Bash, Read, Edit, exec_command, apply_patch...). */
  native: z.number().int().nonnegative(),
  /** agent-code-mode `run` calls. */
  run: z.number().int().nonnegative(),
  /** Codex code-mode `exec`/`wait` calls. */
  codeMode: z.number().int().nonnegative(),
  /** Anything else (ToolSearch, Task, tool_search...). */
  other: z.number().int().nonnegative(),
  byName: Counts,
});
export type ToolCalls = z.infer<typeof ToolCallsSchema>;

/** Metrics parsed from one host transcript. Every number comes from a host event, never an estimate. */
export const ParsedRunSchema = z.object({
  /** Claude `num_turns`; Codex number of model requests (rollout token records). */
  turns: z.number().int().nonnegative().nullable(),
  /** Host-reported duration (Claude `duration_ms`), null when the host does not report one. */
  hostDurationMs: z.number().nonnegative().nullable(),
  usage: UsageSchema.nullable(),
  /** Claude `total_cost_usd`; null for Codex (computed from pricing.json by the runner). */
  hostCostUsd: z.number().nonnegative().nullable(),
  model: z.string().nullable(),
  finalAnswer: z.string(),
  toolCalls: ToolCallsSchema,
  /** Calls made inside scripts: agent-code-mode call log or Codex code-mode nested items. Null when not observable. */
  innerCalls: z.object({ total: z.number().int().nonnegative(), byTool: Counts }).nullable(),
  /** Tools the model could call: Claude `init` event; Codex `codex debug prompt-input` (set by the runner). */
  availableTools: z.array(z.string()).nullable(),
  /**
   * Denied tool calls seen in the host's own log (hook/permission blocks) and in agent-code-mode call
   * logs, as short texts. Null when the log cannot show denials (Codex without its rollout).
   */
  denials: z.array(z.string()).nullable().default(null),
  /** Claude: agents, plugin sources and auto memory from the init event (isolation proof). Null for Codex. */
  hostContext: z.object({ agents: z.array(z.string()), plugins: z.array(z.string()), memory: z.boolean() }).nullable().default(null),
  /** Host-reported error, e.g. a Claude result with `is_error`. */
  hostError: z.string().nullable(),
  /** Where the numbers came from: transcript line numbers (1-based) of the source events. */
  evidence: z.record(z.string(), z.array(z.number().int().positive())),
});
export type ParsedRun = z.infer<typeof ParsedRunSchema>;

export const RunRecordSchema = z.object({
  schema: z.literal(1),
  id: z.string(),
  /** Hash of `config`: runs are pooled and resumed only within one config. */
  configHash: z.string().regex(/^[0-9a-f]{12}$/),
  config: z.record(z.string(), z.unknown()),
  host: z.enum(['claude', 'codex']),
  arm: z.enum(['A', 'B', 'C']),
  armLabel: z.string(),
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
  /** An agent-code-mode arm where the model also made native file/shell tool calls. In the strict arms this also makes the run invalid. */
  fallback: z.boolean(),
  /** False when the observed tool usage does not match the arm label, or the run did not complete. */
  valid: z.boolean(),
  invalidReasons: z.array(z.string()),
  files: z.record(z.string(), z.string()),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

export interface ArmCheck {
  readonly fallback: boolean;
  readonly reasons: readonly string[];
}

/** Checks that observed tool usage matches the arm. */
export function checkArm(host: 'claude' | 'codex', arm: ArmId, calls: ToolCalls): ArmCheck {
  const reasons: string[] = [];
  const total = calls.native + calls.run + calls.codeMode + calls.other;
  const acm = (host === 'claude' && arm === 'B') || (host === 'codex' && arm === 'C');
  if (acm) {
    if (calls.run === 0) reasons.push('agent-code-mode arm made no run call');
    if (calls.codeMode > 0) reasons.push('agent-code-mode arm used Codex code mode');
    // Both agent-code-mode arms are strict: a native file/shell call means the arm did not run as labeled.
    if (calls.native > 0) reasons.push(`strict agent-code-mode arm made ${calls.native} native file/shell tool call(s)`);
    return { fallback: calls.native > 0, reasons };
  }
  if (calls.run > 0) reasons.push('arm made agent-code-mode run calls');
  if (host === 'codex' && arm === 'B') {
    if (calls.codeMode === 0 && total > 0) reasons.push('Codex code-mode arm made tool calls outside exec');
    if (calls.native > 0) reasons.push('Codex code-mode arm made direct native tool calls');
  } else if (calls.codeMode > 0) {
    reasons.push('native arm used Codex code mode');
  }
  return { fallback: false, reasons };
}

const CLAUDE_NATIVE = ['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'NotebookEdit'];
const CODEX_NATIVE = ['exec_command', 'write_stdin', 'apply_patch', 'shell', 'local_shell'];

/** Checks that the tools the model could see match the arm (a config error shows up here before any tool call). */
export function checkSurface(host: 'claude' | 'codex', arm: ArmId, tools: readonly string[]): string[] {
  const reasons: string[] = [];
  const base = tools.map((t) => t.slice(t.lastIndexOf('.') + 1));
  const has = (name: string): boolean => base.includes(name) || tools.includes(name);
  if (host === 'claude') {
    const run = has('mcp__agent-code-mode__run');
    const native = CLAUDE_NATIVE.filter(has);
    if (arm === 'A' && run) reasons.push('native arm sees the run tool');
    if (arm === 'A' && !has('Bash')) reasons.push('native arm does not see Bash');
    if (arm === 'B' && !run) reasons.push('agent-code-mode arm does not see the run tool (server not connected?)');
    if (arm === 'B' && native.length > 0) reasons.push(`agent-code-mode arm sees native tools: ${native.join(', ')}`);
    return reasons;
  }
  const native = CODEX_NATIVE.filter(has);
  const exec = has('exec');
  if (arm === 'A' && (exec || !has('exec_command'))) reasons.push('native arm is not in direct tool mode');
  if (arm === 'B' && (!exec || native.length > 0)) reasons.push('Codex code-mode arm is not in code_mode_only');
  if (arm === 'C' && (exec || native.length > 0)) reasons.push(`agent-code-mode arm sees native or code-mode tools: ${[...native, ...(exec ? ['exec'] : [])].join(', ')}`);
  if (arm === 'C' && !tools.some((t) => /^mcp__agent[-_]code[-_]mode(__|\.)run$/.test(t))) reasons.push('agent-code-mode arm does not see the run tool directly (deferred behind tool_search, or server not configured)');
  const apps = tools.filter((t) => t.startsWith('mcp__codex_apps__'));
  if (apps.length > 0) reasons.push(`Codex account apps are exposed (${apps.length} tools): the run is not isolated`);
  return reasons;
}
