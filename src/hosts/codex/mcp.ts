import path from 'node:path';
import { z } from 'zod';
import { formatIssues } from '../../core/schemas.js';
import type { Decision, McpPolicy, McpServerSpec, PreparedMcpCall } from '../../core/types.js';
import { mcpNameProblem, shownName } from '../../mcp/names.js';
import { getPath, isTable, type ApprovalPolicy, type TomlTable } from './config.js';

/**
 * The stdio MCP servers of a Codex session (`[mcp_servers.<name>]` of the
 * merged config) and how Codex approves their tools. A server with a key this
 * server does not apply is left out with a note. Only an explicit
 * `approval_mode = "approve"` runs a tool without asking: Codex decides the
 * other modes from the tool's annotations and its approval policy, which is
 * not reproduced, so those calls are refused.
 */

/** Codex's default `startup_timeout_sec` and `tool_timeout_sec`. */
export const CODEX_MCP_STARTUP_TIMEOUT_SEC = 10;
export const CODEX_MCP_TOOL_TIMEOUT_SEC = 60;

/** Variables Codex passes from its own environment to every stdio server. */
const DEFAULT_ENV_VARS =
  process.platform === 'win32'
    ? ['PATH', 'PATHEXT', 'COMSPEC', 'SYSTEMROOT', 'SYSTEMDRIVE', 'USERNAME', 'USERDOMAIN', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'PROGRAMDATA', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'POWERSHELL', 'PWSH']
    : ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'USER', '__CF_USER_TEXT_ENCODING', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'TZ'];

const Seconds = z.number().positive();
const StdioEntry = z.strictObject({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  env_vars: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  enabled: z.boolean().optional(),
  required: z.boolean().optional(),
  enabled_tools: z.array(z.string()).optional(),
  disabled_tools: z.array(z.string()).optional(),
  startup_timeout_sec: Seconds.optional(),
  startup_timeout_ms: Seconds.optional(),
  tool_timeout_sec: Seconds.optional(),
  tools: z.record(z.string(), z.looseObject({ approval_mode: z.string().optional() })).optional(),
});

export interface CodexMcpRules {
  readonly enabledTools?: readonly string[];
  readonly disabledTools: readonly string[];
  /** `tools.<tool>.approval_mode`, as written. */
  readonly approval: Readonly<Record<string, string>>;
}

export function discoverCodexMcp(
  merged: TomlTable,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  origin: string,
): { mcp: McpPolicy; rules: Readonly<Record<string, CodexMcpRules>> } {
  const notes: string[] = [];
  const servers: McpServerSpec[] = [];
  const rules: Record<string, CodexMcpRules> = {};
  const table = getPath(merged, ['mcp_servers']);
  for (const [name, entry] of Object.entries(isTable(table) ? table : {})) {
    const where = `server ${shownName(name)} (${origin})`;
    const problem = mcpNameProblem(name);
    if (problem !== undefined) {
      notes.push(`${where}: ${problem}`);
      continue;
    }
    if (!isTable(entry)) {
      notes.push(`${where}: not a table`);
      continue;
    }
    if (entry['enabled'] === false) continue;
    if (Object.hasOwn(entry, 'url')) {
      notes.push(`${where}: only stdio servers are reachable from scripts`);
      continue;
    }
    const parsed = StdioEntry.safeParse(entry);
    if (!parsed.success) {
      notes.push(`${where}: not a stdio entry this server runs exactly (${formatIssues(parsed.error)})`);
      continue;
    }
    const e = parsed.data;
    const envVars = e.env_vars ?? [];
    const missing = envVars.find((v) => env[v] === undefined);
    if (missing !== undefined) {
      notes.push(`${where}: env_vars names ${missing}, which this server's environment does not have`);
      continue;
    }
    const passed = [...DEFAULT_ENV_VARS, ...envVars].flatMap((k) => {
      const v = env[k];
      return v === undefined ? [] : [[k, v] as const];
    });
    const approval = Object.fromEntries(Object.entries(e.tools ?? {}).flatMap(([tool, t]) => (t.approval_mode === undefined ? [] : [[tool, t.approval_mode] as const])));
    const { enabled_tools: enabledTools, disabled_tools: disabledTools = [] } = e;
    servers.push({
      name,
      command: e.command,
      args: e.args ?? [],
      env: { ...Object.fromEntries(passed), ...e.env },
      cwd: e.cwd === undefined ? cwd : path.resolve(cwd, e.cwd),
      startupTimeoutMs: e.startup_timeout_ms ?? (e.startup_timeout_sec ?? CODEX_MCP_STARTUP_TIMEOUT_SEC) * 1000,
      toolTimeoutMs: (e.tool_timeout_sec ?? CODEX_MCP_TOOL_TIMEOUT_SEC) * 1000,
      origin,
      autostart: Object.entries(approval).some(([tool, mode]) => mode === 'approve' && !disabledTools.includes(tool) && (enabledTools === undefined || enabledTools.includes(tool))),
    });
    rules[name] = { ...(enabledTools === undefined ? {} : { enabledTools }), disabledTools, approval };
  }
  return { mcp: { servers, notes }, rules };
}

export function codexMcpDecision(prepared: PreparedMcpCall, rules: Readonly<Record<string, CodexMcpRules>>, approvalPolicy: ApprovalPolicy): Decision {
  const { server, tool, qualifiedName } = prepared.effect;
  const r = rules[server];
  if (r === undefined) return { kind: 'deny', source: 'rule', reason: `Codex configures no MCP server ${shownName(server)}` };
  if (r.disabledTools.includes(tool)) return { kind: 'deny', source: 'rule', reason: `${qualifiedName} is in disabled_tools of mcp_servers.${server}` };
  if (r.enabledTools !== undefined && !r.enabledTools.includes(tool)) return { kind: 'deny', source: 'rule', reason: `${qualifiedName} is not in enabled_tools of mcp_servers.${server}` };
  const mode = r.approval[tool];
  if (mode === 'approve') return { kind: 'allow' };
  if (mode === 'prompt') {
    const reason = `mcp_servers.${server}.tools.${tool}.approval_mode is "prompt"`;
    return approvalPolicy === 'never' ? { kind: 'deny', source: 'rule', reason: `${reason}; approval policy never rejects it` } : { kind: 'ask', reason };
  }
  return {
    kind: 'deny',
    source: 'unsupported-config',
    reason: `Codex approves ${qualifiedName} from its annotations and approval policy, which agent-code-mode does not reproduce; set mcp_servers.${server}.tools.${tool}.approval_mode = "approve" to run it from scripts`,
  };
}
