import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { errorMessage } from '../core/errors.js';
import { formatIssues } from '../core/schemas.js';
import { mcpNameProblem, shownName } from './names.js';

/**
 * The `serve --mcp-config <file>` file: the `.mcp.json` format of Claude Code,
 * `{"mcpServers": {"<name>": {"command": "...", "args": [...], "env": {...}}}}`,
 * stdio servers only. Anything this server would not run exactly as written
 * fails the start with a message: an unknown key, a remote server, a
 * `${VAR}` that Claude Code would expand.
 */

/** One upstream stdio server. */
export interface McpServerConfig {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  /** Added to the minimal default environment of the server process. */
  readonly env: Readonly<Record<string, string>>;
}

/** Largest config file read. */
export const MAX_MCP_CONFIG_BYTES = 1024 * 1024;
/** Most servers one config may declare. */
export const MAX_MCP_SERVERS = 32;

const noNul = (s: string): boolean => !s.includes('\0');
const noExpansion = (s: string): boolean => !s.includes('${');
const word = z
  .string()
  .max(32_768)
  .refine(noNul, 'must not contain NUL characters')
  .refine(noExpansion, 'contains ${...}, which Claude Code expands and this server does not; write the value itself');

const ServerSchema = z.strictObject({
  type: z.literal('stdio', { error: 'only stdio servers are supported ("type": "stdio" or no type)' }).optional(),
  command: word.min(1, 'must not be empty'),
  args: z.array(word).max(1_000).optional(),
  env: z
    .record(
      z
        .string()
        .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'environment variable names are letters, digits and _')
        .refine((k) => k !== '__proto__', 'environment variable name __proto__ is not supported'),
      word,
    )
    .refine((env) => Object.keys(env).length <= 1_000, 'too many environment variables')
    .optional(),
});

const ConfigSchema = z.strictObject({
  mcpServers: z.record(z.string(), z.unknown()).refine((servers) => Object.keys(servers).length <= MAX_MCP_SERVERS, `at most ${MAX_MCP_SERVERS} servers`),
});

/** Names an upstream server may not take. */
export interface McpConfigOptions {
  /** The name this server itself is registered under: an upstream with it would share its `mcp__<name>` rules. */
  readonly reservedServerNames?: readonly string[];
}

/** Parses the text of a config file. Returns the servers or an error message that names the problem. */
export function parseMcpConfig(text: string, opts: McpConfigOptions = {}): { ok: true; servers: McpServerConfig[] } | { ok: false; message: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { ok: false, message: `not valid JSON: ${errorMessage(err)}` };
  }
  // JSON.parse keeps the last of two equal keys, and a record schema turns `__proto__` into a prototype:
  // either way a value of the file would be hidden from the checks below, so both are refused here.
  const key = ambiguousKey(text);
  if (key !== undefined) return { ok: false, message: key.duplicate ? `the key ${shownName(key.key)} appears twice in the same object` : `the key ${shownName(key.key)} is not supported` };
  const top = ConfigSchema.safeParse(json);
  if (!top.success) return { ok: false, message: formatIssues(top.error) };
  // Server names are read from the parsed JSON itself: a parsed record would turn a `__proto__` key into a prototype and lose it.
  const rawServers = json !== null && typeof json === 'object' && 'mcpServers' in json ? json.mcpServers : undefined;
  if (rawServers === null || typeof rawServers !== 'object') return { ok: false, message: 'mcpServers must be an object' };
  const servers: McpServerConfig[] = [];
  for (const [name, raw] of Object.entries(rawServers)) {
    const problem = mcpNameProblem(name);
    if (problem !== undefined) return { ok: false, message: `server name ${shownName(name)}: ${problem}` };
    if (opts.reservedServerNames?.includes(name)) return { ok: false, message: `server name ${shownName(name)} is the name this server is registered under` };
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw) && ('url' in raw || ('type' in raw && raw.type !== 'stdio'))) {
      return { ok: false, message: `server ${shownName(name)}: only stdio servers (command, args, env) are supported` };
    }
    const parsed = ServerSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, message: `server ${shownName(name)}: ${formatIssues(parsed.error)}` };
    servers.push({ name, command: parsed.data.command, args: parsed.data.args ?? [], env: parsed.data.env ?? {} });
  }
  return { ok: true, servers };
}

/**
 * The first object key of a JSON text (already known to be valid JSON) that appears twice in the same
 * object, or that is `__proto__`. Undefined when there is none.
 */
export function ambiguousKey(text: string): { key: string; duplicate: boolean } | undefined {
  const stack: ({ readonly keys: Set<string>; expectKey: boolean } | null)[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const top = stack.at(-1);
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const literal = text.slice(i, j + 1);
      i = j;
      if (top === undefined || top === null || !top.expectKey) continue;
      const parsed: unknown = JSON.parse(literal);
      const name = typeof parsed === 'string' ? parsed : literal;
      if (name === '__proto__') return { key: name, duplicate: false };
      if (top.keys.has(name)) return { key: name, duplicate: true };
      top.keys.add(name);
      top.expectKey = false;
    } else if (ch === '{') stack.push({ keys: new Set(), expectKey: true });
    else if (ch === '[') stack.push(null);
    else if (ch === '}' || ch === ']') stack.pop();
    else if (ch === ',' && top !== undefined && top !== null) top.expectKey = true;
  }
  return undefined;
}

/** Reads and parses a config file. */
export async function loadMcpConfig(file: string, opts: McpConfigOptions = {}): Promise<{ ok: true; servers: McpServerConfig[] } | { ok: false; message: string }> {
  let text: string;
  try {
    const buf = await readFile(file);
    if (buf.byteLength > MAX_MCP_CONFIG_BYTES) return { ok: false, message: `${file} is larger than ${MAX_MCP_CONFIG_BYTES} bytes` };
    text = buf.toString('utf8');
  } catch (err) {
    return { ok: false, message: `cannot read ${file}: ${errorMessage(err)}` };
  }
  const parsed = parseMcpConfig(text, opts);
  return parsed.ok ? parsed : { ok: false, message: `${file}: ${parsed.message}` };
}
