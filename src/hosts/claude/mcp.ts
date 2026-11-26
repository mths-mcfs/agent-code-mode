import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { errorMessage } from '../../core/errors.js';
import type { McpPolicy, McpServerSpec } from '../../core/types.js';
import { mcpNameProblem, shownName } from '../../mcp/names.js';
import type { ClaudeCliFlags } from './parent-args.js';
import type { SettingsDoc } from './settings.js';

/**
 * The stdio MCP servers a Claude Code session has, read from where Claude
 * Code keeps them: the session's `--mcp-config` values (alone with
 * `--strict-mcp-config`), else also the local and user scopes of
 * `.claude.json` and the project's `.mcp.json` once approved. Anything this
 * server would not run exactly as Claude Code does is left out with a note;
 * leaving a server out never widens what a script can reach.
 */

/** Claude Code's default wait for a server to start (`MCP_TIMEOUT` overrides it). */
export const CLAUDE_MCP_STARTUP_TIMEOUT_MS = 30_000;
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;

/** Settings keys that restrict MCP servers in ways this server does not evaluate. */
const RESTRICTING_KEYS = ['allowedMcpServers', 'deniedMcpServers'] as const;

const Entry = z.strictObject({
  type: z.literal('stdio').optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const ServersSchema = z.record(z.string(), z.unknown());
const ProjectEntry = z.looseObject({
  mcpServers: ServersSchema.optional().catch(undefined),
  enabledMcpjsonServers: z.array(z.string()).optional().catch(undefined),
  disabledMcpjsonServers: z.array(z.string()).optional().catch(undefined),
  enableAllProjectMcpServers: z.boolean().optional().catch(undefined),
  disabledMcpServers: z.array(z.string()).optional().catch(undefined),
});
const ClaudeJson = z.looseObject({ mcpServers: ServersSchema.optional().catch(undefined), projects: z.record(z.string(), z.unknown()).optional().catch(undefined) });
const McpFile = z.looseObject({ mcpServers: ServersSchema });
const ApprovalKeys = z.looseObject({
  enabledMcpjsonServers: z.array(z.string()).optional().catch(undefined),
  disabledMcpjsonServers: z.array(z.string()).optional().catch(undefined),
  enableAllProjectMcpServers: z.boolean().optional().catch(undefined),
});

export interface ClaudeMcpInput {
  readonly flags: ClaudeCliFlags;
  /** Claude's process directory: `.mcp.json`, the local scope key and relative `--mcp-config` paths. */
  readonly projectDir: string;
  readonly parentCwd: string | undefined;
  readonly configDir: string;
  readonly home: string;
  readonly managedDir: string | undefined;
  readonly docs: readonly SettingsDoc[];
  readonly projectTrusted: boolean;
  /** The environment Claude Code started this server with, close to its own: servers get it, and `${VAR}` reads it. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Whether a rule or the permission mode can allow some tool of a server without asking. */
  readonly mayAllow: (server: string) => boolean;
}

interface Candidate {
  readonly origin: string;
  readonly raw: unknown;
}

async function readJson(file: string): Promise<unknown> {
  let text: string;
  try {
    const buf = await readFile(file);
    if (buf.byteLength > MAX_CONFIG_BYTES) throw new Error(`${file} is larger than ${MAX_CONFIG_BYTES} bytes`);
    text = buf.toString('utf8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return undefined;
    throw err;
  }
  return JSON.parse(text);
}

/** `${VAR}` and `${VAR:-default}`, as Claude Code expands them in `.mcp.json`. */
export function expandVars(value: string, env: Readonly<Record<string, string | undefined>>): string | { missing: string } {
  let missing: string | undefined;
  const out = value.replace(/\$\{([^}:]+)(?::-([^}]*))?\}/g, (_m, name: string, fallback: string | undefined) => {
    const v = env[name];
    if (v !== undefined) return v;
    if (fallback !== undefined) return fallback;
    missing ??= name;
    return '';
  });
  return missing === undefined ? out : { missing };
}

/** The spec Claude Code would start for one config entry, or why it is left out. */
function toSpec(name: string, c: Candidate, input: ClaudeMcpInput): McpServerSpec | string {
  const problem = mcpNameProblem(name);
  if (problem !== undefined) return `server ${shownName(name)} (${c.origin}): ${problem}`;
  if (c.raw !== null && typeof c.raw === 'object' && !Array.isArray(c.raw) && 'type' in c.raw && c.raw.type !== 'stdio') {
    return `server ${shownName(name)} (${c.origin}): only stdio servers are reachable from scripts`;
  }
  const parsed = Entry.safeParse(c.raw);
  if (!parsed.success) return `server ${shownName(name)} (${c.origin}): not a stdio entry this server runs exactly (command, args, env)`;
  const expand = (v: string): string => {
    const r = expandVars(v, input.env);
    if (typeof r !== 'string') throw new Error(`\${${r.missing}} is not set`);
    return r;
  };
  try {
    const own = Object.fromEntries(Object.entries(parsed.data.env ?? {}).map(([k, v]) => [k, expand(v)]));
    const inherited = Object.fromEntries(Object.entries(input.env).filter((e): e is [string, string] => e[1] !== undefined));
    const timeout = Number(input.env['MCP_TIMEOUT']);
    const toolTimeout = Number(input.env['MCP_TOOL_TIMEOUT']);
    return {
      name,
      command: expand(parsed.data.command),
      args: (parsed.data.args ?? []).map(expand),
      env: { ...inherited, ...own },
      cwd: input.projectDir,
      startupTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : CLAUDE_MCP_STARTUP_TIMEOUT_MS,
      ...(Number.isFinite(toolTimeout) && toolTimeout > 0 ? { toolTimeoutMs: toolTimeout } : {}),
      origin: c.origin,
      autostart: input.mayAllow(name),
    };
  } catch (err) {
    return `server ${shownName(name)} (${c.origin}): ${errorMessage(err)}`;
  }
}

function entries(servers: Record<string, unknown> | undefined, origin: string): [string, Candidate][] {
  return Object.entries(servers ?? {}).map(([name, raw]) => [name, { origin, raw }]);
}

/** The `--mcp-config` values: a JSON object text, or a file path relative to Claude's directory. */
async function flagServers(input: ClaudeMcpInput, notes: string[]): Promise<[string, Candidate][]> {
  const out: [string, Candidate][] = [];
  for (const value of input.flags.mcpConfigs) {
    const inline = value.trim().startsWith('{');
    const origin = inline ? '--mcp-config (inline JSON)' : `--mcp-config ${value}`;
    if (!inline && !path.isAbsolute(value) && input.parentCwd === undefined) {
      notes.push(`${origin}: relative, and the Claude process directory is unknown`);
      continue;
    }
    try {
      const json = inline ? JSON.parse(value) : await readJson(path.resolve(input.parentCwd ?? input.projectDir, value));
      const parsed = McpFile.safeParse(json);
      if (!parsed.success) {
        notes.push(`${origin}: not an object with mcpServers`);
        continue;
      }
      out.push(...entries(parsed.data.mcpServers, origin));
    } catch (err) {
      notes.push(`${origin}: cannot be read (${errorMessage(err)})`);
    }
  }
  return out;
}

export async function discoverClaudeMcp(input: ClaudeMcpInput): Promise<McpPolicy> {
  const notes: string[] = [];
  const restricting = input.docs.flatMap((d) => RESTRICTING_KEYS.filter((k) => k in d.data).map((k) => `${k} in ${d.file ?? `${d.source} settings`}`));
  if (input.managedDir !== undefined && (await readJson(path.join(input.managedDir, 'managed-mcp.json')).catch(() => null)) !== undefined) {
    restricting.push(`${path.join(input.managedDir, 'managed-mcp.json')}`);
  }
  if (restricting.length > 0) {
    return { servers: [], notes, unsupported: `the Claude Code configuration restricts MCP servers (${restricting.join(', ')}), which agent-code-mode does not evaluate; upstream MCP calls are refused` };
  }

  const candidates: [string, Candidate][] = await flagServers(input, notes);
  let disabled = new Set<string>();
  if (!input.flags.strictMcpConfig) {
    const claudeJsonFile = path.join(input.configDir === path.join(input.home, '.claude') ? input.home : input.configDir, '.claude.json');
    let claudeJson: z.infer<typeof ClaudeJson> = {};
    try {
      claudeJson = ClaudeJson.parse((await readJson(claudeJsonFile)) ?? {});
    } catch (err) {
      notes.push(`${claudeJsonFile}: cannot be read (${errorMessage(err)}); its servers are left out`);
    }
    const project = ProjectEntry.safeParse(claudeJson.projects?.[input.projectDir] ?? {}).data ?? {};
    disabled = new Set(project.disabledMcpServers ?? []);
    candidates.push(...entries(project.mcpServers, `${claudeJsonFile} (local scope)`));

    // Approvals of .mcp.json servers: a project's own settings cannot approve the file it ships.
    const approvals = [...input.docs.filter((d) => d.source !== 'project').map((d) => ApprovalKeys.safeParse(d.data).data ?? {}), project];
    const refusals = [...input.docs.map((d) => ApprovalKeys.safeParse(d.data).data ?? {}), project];
    const mcpJson = path.join(input.projectDir, '.mcp.json');
    let file: z.infer<typeof McpFile> | undefined;
    try {
      const json = await readJson(mcpJson);
      if (json !== undefined) {
        const parsed = McpFile.safeParse(json);
        if (parsed.success) file = parsed.data;
        else notes.push(`${mcpJson}: not an object with mcpServers`);
      }
    } catch (err) {
      notes.push(`${mcpJson}: cannot be read (${errorMessage(err)})`);
    }
    for (const [name, c] of entries(file?.mcpServers, mcpJson)) {
      const refused = refusals.some((a) => a.disabledMcpjsonServers?.includes(name) === true);
      const approved = approvals.some((a) => a.enableAllProjectMcpServers === true || a.enabledMcpjsonServers?.includes(name) === true);
      if (!input.projectTrusted) notes.push(`server ${shownName(name)} (${mcpJson}): the project is not trusted`);
      else if (refused) notes.push(`server ${shownName(name)} (${mcpJson}): disabled by disabledMcpjsonServers`);
      else if (!approved) notes.push(`server ${shownName(name)} (${mcpJson}): not approved (enabledMcpjsonServers or enableAllProjectMcpServers)`);
      else candidates.push([name, c]);
    }
    candidates.push(...entries(claudeJson.mcpServers, `${claudeJsonFile} (user scope)`));
  }

  const servers: McpServerSpec[] = [];
  const left = new Set<string>();
  for (const [name, c] of candidates) {
    if (left.has(name)) continue;
    if (disabled.has(name)) {
      notes.push(`server ${shownName(name)}: disabled for this project`);
      left.add(name);
      continue;
    }
    const spec = toSpec(name, c, input);
    if (typeof spec === 'string') {
      notes.push(spec);
      left.add(name);
      continue;
    }
    const earlier = servers.findIndex((s) => s.name === name);
    if (earlier === -1) {
      servers.push(spec);
      continue;
    }
    const same = (a: McpServerSpec, b: McpServerSpec): boolean => JSON.stringify([a.command, a.args, a.env]) === JSON.stringify([b.command, b.args, b.env]);
    const first = servers[earlier];
    if (first !== undefined && !same(first, spec)) {
      // Which definition Claude Code would start is not reproduced: neither is reachable.
      notes.push(`server ${shownName(name)}: defined differently in ${first.origin} and ${spec.origin}`);
      servers.splice(earlier, 1);
      left.add(name);
    }
  }
  return { servers, notes };
}
