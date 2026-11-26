import path from 'node:path';
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

const KNOWN_KEYS = new Set(['command', 'args', 'env', 'env_vars', 'cwd', 'enabled', 'required', 'enabled_tools', 'disabled_tools', 'startup_timeout_sec', 'startup_timeout_ms', 'tool_timeout_sec', 'tools']);

/** How Codex gates the tools of one server. */
export interface CodexMcpRules {
  readonly enabledTools?: readonly string[];
  readonly disabledTools: readonly string[];
  /** `tools.<tool>.approval_mode`, as written. */
  readonly approval: Readonly<Record<string, string>>;
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v): v is string => typeof v === 'string') ? value : undefined;
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
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
    const unknown = Object.keys(entry).find((k) => !KNOWN_KEYS.has(k));
    if (unknown !== undefined) {
      notes.push(`${where}: the key ${unknown} is not applied by this server`);
      continue;
    }
    const command = entry['command'];
    const args = entry['args'] === undefined ? [] : strings(entry['args']);
    const ownEnv = entry['env'] === undefined ? {} : isTable(entry['env']) ? entry['env'] : undefined;
    const envVars = entry['env_vars'] === undefined ? [] : strings(entry['env_vars']);
    const enabledTools = entry['enabled_tools'] === undefined ? undefined : strings(entry['enabled_tools']);
    const disabledTools = entry['disabled_tools'] === undefined ? [] : strings(entry['disabled_tools']);
    const tools = entry['tools'] === undefined ? {} : isTable(entry['tools']) ? entry['tools'] : undefined;
    if (
      typeof command !== 'string' ||
      command === '' ||
      args === undefined ||
      ownEnv === undefined ||
      !Object.values(ownEnv).every((v) => typeof v === 'string') ||
      envVars === undefined ||
      (entry['enabled_tools'] !== undefined && enabledTools === undefined) ||
      disabledTools === undefined ||
      tools === undefined ||
      (entry['cwd'] !== undefined && typeof entry['cwd'] !== 'string')
    ) {
      notes.push(`${where}: not a stdio entry this server runs exactly`);
      continue;
    }
    const missing = envVars.find((v) => env[v] === undefined);
    if (missing !== undefined) {
      notes.push(`${where}: env_vars names ${missing}, which this server's environment does not have`);
      continue;
    }
    const approval: Record<string, string> = {};
    for (const [tool, t] of Object.entries(tools)) {
      const mode = isTable(t) ? t['approval_mode'] : undefined;
      if (typeof mode === 'string') approval[tool] = mode;
    }
    const pass = (keys: readonly string[]): [string, string][] => keys.flatMap((k) => (env[k] === undefined ? [] : [[k, env[k]] as [string, string]]));
    const startupMs = positive(entry['startup_timeout_ms']) ?? (positive(entry['startup_timeout_sec']) ?? CODEX_MCP_STARTUP_TIMEOUT_SEC) * 1000;
    const configuredCwd = entry['cwd'];
    servers.push({
      name,
      command,
      args,
      env: { ...Object.fromEntries([...pass(DEFAULT_ENV_VARS), ...pass(envVars)]), ...(ownEnv as Record<string, string>) },
      cwd: typeof configuredCwd === 'string' ? path.resolve(cwd, configuredCwd) : cwd,
      startupTimeoutMs: startupMs,
      toolTimeoutMs: (positive(entry['tool_timeout_sec']) ?? CODEX_MCP_TOOL_TIMEOUT_SEC) * 1000,
      origin,
    });
    rules[name] = { ...(enabledTools === undefined ? {} : { enabledTools }), disabledTools, approval };
  }
  return { mcp: { servers, notes }, rules };
}

/** The static decision for an upstream tool under Codex. */
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
