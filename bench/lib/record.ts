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


/** The exact tool set each Claude arm must see in its `system/init` event. */
export const CLAUDE_ARM_SURFACE: Readonly<Record<'A' | 'B', readonly string[]>> = {
  A: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
  B: ['mcp__agent-code-mode__run'],
};
/**
 * Non-file tools every Codex arm must reach, and nothing else: the arms differ only in how files and the
 * shell are reached (direct tools, code-mode `exec`, agent-code-mode `run`).
 */
export const CODEX_COMMON_NON_FILE = ['list_mcp_resource_templates', 'list_mcp_resources', 'read_mcp_resource', 'request_user_input'];
const CODEX_FILE_SHELL = ['exec_command', 'write_stdin', 'apply_patch'];
const CODEX_CODE_MODE = ['exec', 'wait'];
const isRunTool = (t: string): boolean => /^mcp__agent[-_]code[-_]mode(__|\.)run$/.test(t);

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const x = [...new Set(a)].sort();
  const y = [...new Set(b)].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * Checks that the tools the model could see are exactly the arm's surface (a config error or a tool
 * surface that differs between arms shows up here before any tool call). Codex names come from
 * `codexToolSurface`: `namespace.name` for direct tools, `exec.name` for tools nested in code mode.
 */
export function checkSurface(host: 'claude' | 'codex', arm: ArmId, tools: readonly string[]): string[] {
  const reasons: string[] = [];
  if (host === 'claude') {
    const expected = arm === 'B' ? CLAUDE_ARM_SURFACE.B : CLAUDE_ARM_SURFACE.A;
    if (!sameSet(tools, expected)) reasons.push(`Claude arm ${arm} tools are [${[...tools].sort().join(', ')}], expected exactly [${[...expected].sort().join(', ')}]`);
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
