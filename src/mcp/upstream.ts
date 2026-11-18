import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { z } from 'zod';
import { errorMessage } from '../core/errors.js';
import type { McpServerName, McpToolName } from '../core/types.js';
import type { McpServerConfig } from './config.js';
import { mcpNameProblem, qualifiedMcpName, shownName } from './names.js';

/**
 * Connections to the upstream MCP servers of `serve --mcp-config` and the
 * catalog of their tools, both fixed at start: each server is spawned with a
 * minimal environment (the SDK's default inherited variables plus the `env`
 * the config declares), initialized and asked for its tools once
 * (`tools/list`, paginated, capped). A server that fails any of that is left
 * out, and so is every tool whose name breaks the name rules or collides;
 * each exclusion is reported. Change notifications are ignored.
 */

/** Wait for a server to start and answer `initialize`. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
/** Wait for each `tools/list` page. */
export const DEFAULT_LIST_TIMEOUT_MS = 10_000;
/** Pages of `tools/list` read per server. */
export const MAX_LIST_PAGES = 20;
/** Tools kept per server. */
export const MAX_TOOLS_PER_SERVER = 500;
/** Characters of a tool description kept. */
export const MAX_TOOL_DESCRIPTION_CHARS = 300;
/** Characters of a tool's compact input schema kept. */
export const MAX_TOOL_SCHEMA_CHARS = 400;
const STDERR_TAIL_CHARS = 1_000;

/** One cataloged upstream tool. */
export interface McpToolEntry {
  readonly server: McpServerName;
  readonly tool: McpToolName;
  /** `mcp__<server>__<tool>`. */
  readonly qualifiedName: string;
  /** One line, cut to `MAX_TOOL_DESCRIPTION_CHARS`; empty when the server gave none. */
  readonly description: string;
  /** TypeScript-like shape of the input, e.g. `{sku: string; qty?: number}`, cut to `MAX_TOOL_SCHEMA_CHARS`. */
  readonly inputShape: string;
  /**
   * Checks a successful result's `structuredContent` against the tool's `outputSchema` (undefined when it
   * declares none): a message when it is missing or does not match, else undefined.
   */
  readonly checkOutput?: (structuredContent: unknown) => string | undefined;
}

/** What the upstream servers expose, fixed at start. */
export interface McpCatalog {
  /** Cataloged tools in server, then listing order. */
  readonly tools: readonly McpToolEntry[];
  /** Servers that connected. */
  readonly servers: readonly McpServerName[];
  /** Every server and tool left out, with the reason: shown on stderr and in the `run` description. */
  readonly problems: readonly string[];
  /** The entry for a server and tool name, when cataloged. */
  lookup(server: string, tool: string): McpToolEntry | undefined;
}

/** How a call ended when it did not return a result. */
export type UpstreamFailure =
  | { readonly kind: 'not-connected'; readonly message: string }
  | { readonly kind: 'timeout'; readonly message: string }
  | { readonly kind: 'cancelled'; readonly message: string }
  | { readonly kind: 'closed'; readonly message: string }
  | { readonly kind: 'invalid-result'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string };

export interface UpstreamCallOptions {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  /** Called once, right before the request is written to the server: from then on the call may have run. */
  readonly onSent?: () => void;
}

/** The part of the upstream set the binding runtime uses. */
export interface McpUpstream {
  readonly catalog: McpCatalog;
  /** Calls one cataloged tool. Never rejects. `result` is the raw, unvalidated `tools/call` result. */
  call(entry: McpToolEntry, input: Readonly<Record<string, unknown>>, opts: UpstreamCallOptions): Promise<{ ok: true; result: unknown } | { ok: false; failure: UpstreamFailure }>;
  /** Closes every connection and ends the server processes. Idempotent. */
  close(): Promise<void>;
}

export interface ConnectOptions {
  readonly connectTimeoutMs?: number;
  readonly listTimeoutMs?: number;
  /** Working directory of the server processes. */
  readonly cwd?: string;
  /** Client name sent in `initialize`. */
  readonly clientName?: string;
  readonly clientVersion?: string;
  /** Aborting it ends the start: server processes already spawned (connected or still connecting) are closed. */
  readonly signal?: AbortSignal;
}

const ToolSchema = z.looseObject({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.unknown().optional(),
  outputSchema: z.unknown().optional(),
});
/** Names of the entries a listing returned past `MAX_TOOLS_PER_SERVER`, kept only to find duplicates. */
const MAX_OVERFLOW_NAMES = 10_000;
const NameOnly = z.looseObject({ name: z.string() });

/** A JSON Schema object (what an `outputSchema` must be). */
function isSchemaObject(value: unknown): value is JsonSchemaType {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const outputValidators = new AjvJsonSchemaValidator();

/**
 * The `outputSchema` check of one tool, compiled once at start so it applies to every tool the same way
 * (the SDK's own check keeps only the tools of the last `tools/list` page). Throws when the schema
 * cannot be compiled.
 */
function outputCheck(schema: unknown): ((structured: unknown) => string | undefined) | undefined {
  if (schema === undefined) return undefined;
  if (!isSchemaObject(schema)) throw new Error('its outputSchema is not an object');
  const validate = outputValidators.getValidator(schema);
  return (structured) => {
    if (structured === undefined) return 'the tool declares an outputSchema but the result has no structuredContent';
    const r = validate(structured);
    return r.valid ? undefined : `structuredContent does not match the tool's outputSchema: ${r.errorMessage}`;
  };
}
const ListPageSchema = z.looseObject({ tools: z.array(z.unknown()), nextCursor: z.string().optional() });

/** One line of printable text, cut to `max`. */
export function oneLine(text: string, max: number): string {
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

const JsonSchemaLike = z.looseObject({
  type: z.unknown().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  required: z.array(z.string()).optional(),
  items: z.unknown().optional(),
  enum: z.array(z.unknown()).optional(),
});

/** A short TypeScript-like reading of a JSON Schema; never throws, bounded by `max` and depth. */
export function compactSchema(schema: unknown, max: number = MAX_TOOL_SCHEMA_CHARS): string {
  const render = (s: unknown, depth: number): string => {
    const parsed = JsonSchemaLike.safeParse(s);
    if (!parsed.success) return 'unknown';
    const d = parsed.data;
    if (d.enum !== undefined) return d.enum.slice(0, 8).map((v) => JSON.stringify(v) ?? 'null').join(' | ') + (d.enum.length > 8 ? ' | …' : '');
    const type = typeof d.type === 'string' ? d.type : Array.isArray(d.type) ? d.type.filter((t): t is string => typeof t === 'string').join(' | ') : undefined;
    if (d.properties !== undefined || type === 'object') {
      if (depth >= 2) return 'object';
      const required = new Set(d.required ?? []);
      const props = Object.entries(d.properties ?? {}).slice(0, 30);
      const parts = props.map(([key, value]) => `${/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key)}${required.has(key) ? '' : '?'}: ${render(value, depth + 1)}`);
      const more = Object.keys(d.properties ?? {}).length > props.length ? '; …' : '';
      return `{${parts.join('; ')}${more}}`;
    }
    if (type === 'array') return depth >= 2 ? 'array' : `${render(d.items, depth + 1)}[]`;
    if (type === 'integer') return 'number';
    return type ?? 'unknown';
  };
  return oneLine(render(schema, 0), max);
}

interface Connection {
  readonly name: McpServerName;
  readonly client: Client;
  /** Set when the connection closed: later calls fail with it. */
  closedReason: string | undefined;
}

class UpstreamSet implements McpUpstream {
  readonly catalog: McpCatalog;
  readonly #connections: ReadonlyMap<string, Connection>;
  #closing: Promise<void> | undefined;

  constructor(catalog: McpCatalog, connections: ReadonlyMap<string, Connection>) {
    this.catalog = catalog;
    this.#connections = connections;
  }

  async call(entry: McpToolEntry, input: Readonly<Record<string, unknown>>, opts: UpstreamCallOptions): Promise<{ ok: true; result: unknown } | { ok: false; failure: UpstreamFailure }> {
    const conn = this.#connections.get(entry.server);
    if (conn === undefined || this.#closing !== undefined) return { ok: false, failure: { kind: 'not-connected', message: `MCP server ${shownName(entry.server)} is not connected` } };
    if (conn.closedReason !== undefined) {
      return { ok: false, failure: { kind: 'not-connected', message: `MCP server ${shownName(entry.server)} is no longer connected (${conn.closedReason}); the call was not sent` } };
    }
    if (opts.signal.aborted) return { ok: false, failure: { kind: 'cancelled', message: 'the run was stopped; the call was not sent' } };
    let result: unknown;
    try {
      opts.onSent?.();
      // The raw result: the SDK's own result schema defaults a missing `content` to [] and drops a
      // `__proto__` key of `structuredContent`; the binding validates the result itself.
      result = await conn.client.request({ method: 'tools/call', params: { name: entry.tool, arguments: { ...input } } }, RawResult, { signal: opts.signal, timeout: opts.timeoutMs });
    } catch (err) {
      return { ok: false, failure: classify(err, opts, entry, conn) };
    }
    const raw = ResultEnvelope.safeParse(result);
    if (entry.checkOutput !== undefined && raw.success && raw.data.isError !== true) {
      const problem = entry.checkOutput(raw.data.structuredContent);
      if (problem !== undefined) return { ok: false, failure: { kind: 'invalid-result', message: `MCP server ${shownName(entry.server)} answered ${entry.qualifiedName} with a result that does not fit its outputSchema: ${oneLine(problem, 500)}` } };
    }
    return { ok: true, result };
  }

  close(): Promise<void> {
    this.#closing ??= Promise.allSettled([...this.#connections.values()].map((c) => c.client.close())).then(() => undefined);
    return this.#closing;
  }
}

/** The `tools/call` result kept exactly as the server sent it (JSON-parsed), for the binding to validate. */
const RawResult = z.unknown();
const ResultEnvelope = z.looseObject({ isError: z.unknown().optional(), structuredContent: z.unknown().optional() });
const McpErrorLike = z.looseObject({ code: z.number() });
const ZodErrorLike = z.looseObject({ issues: z.array(z.looseObject({ code: z.string(), path: z.array(z.unknown()) })).min(1) });

function classify(err: unknown, opts: UpstreamCallOptions, entry: McpToolEntry, conn: Connection): UpstreamFailure {
  const what = `${entry.qualifiedName}`;
  if (opts.signal.aborted) return { kind: 'cancelled', message: `${what} was cancelled while it ran; its effect is unknown` };
  const code = McpErrorLike.safeParse(err);
  if (code.success && code.data.code === -32001) {
    return { kind: 'timeout', message: `${what} did not answer within ${opts.timeoutMs} ms; its effect is unknown (the server may have run it) and it was not retried` };
  }
  if ((code.success && code.data.code === -32000) || conn.closedReason !== undefined) {
    return { kind: 'closed', message: `MCP server ${shownName(entry.server)} closed the connection during ${what}; its effect is unknown and it was not retried` };
  }
  // The SDK validates the result with its own copy of zod: recognize the error by its shape.
  if (err instanceof z.ZodError || ZodErrorLike.safeParse(err).success) {
    return { kind: 'invalid-result', message: `MCP server ${shownName(entry.server)} answered ${what} with a result that is not a valid tools/call result` };
  }
  return { kind: 'error', message: `${what} failed: ${oneLine(errorMessage(err), 2_000)}` };
}

/** Builds the catalog from what each server listed. Exported for tests of the name rules. */
export function buildCatalog(listed: readonly { server: string; tools: readonly unknown[]; truncated: boolean; overflowNames?: readonly string[] }[], problems: string[]): McpCatalog {
  const entries: McpToolEntry[] = [];
  const servers: McpServerName[] = [];
  const byKey = new Map<string, McpToolEntry>();
  const seen = new Set<string>();
  for (const { server, tools, truncated, overflowNames = [] } of listed) {
    const serverProblem = mcpNameProblem(server);
    if (!isMcpServerName(server) || serverProblem !== undefined) {
      problems.push(`MCP server ${shownName(server)} left out: ${serverProblem ?? 'invalid name'}`);
      continue;
    }
    servers.push(server);
    if (truncated) problems.push(`MCP server ${shownName(server)} lists more tools than ${MAX_TOOLS_PER_SERVER} (or ${MAX_LIST_PAGES} pages); the rest are left out`);
    const candidates: { tool: McpToolName; description: string; inputShape: string; checkOutput: McpToolEntry['checkOutput'] }[] = [];
    const counts = new Map<string, number>();
    // A name the server listed again past the cap is a duplicate all the same.
    for (const name of overflowNames) counts.set(name, (counts.get(name) ?? 0) + 1);
    for (const raw of tools) {
      const parsed = ToolSchema.safeParse(raw);
      if (!parsed.success) {
        problems.push(`a tool of MCP server ${shownName(server)} left out: its tools/list entry is invalid`);
        continue;
      }
      const name = parsed.data.name;
      const problem = mcpNameProblem(name);
      if (problem !== undefined || !isMcpToolName(name)) {
        problems.push(`tool ${shownName(name)} of MCP server ${shownName(server)} left out: ${problem ?? 'invalid name'}`);
        continue;
      }
      counts.set(name, (counts.get(name) ?? 0) + 1);
      let checkOutput: McpToolEntry['checkOutput'];
      try {
        checkOutput = outputCheck(parsed.data.outputSchema);
      } catch (err) {
        problems.push(`tool ${shownName(name)} of MCP server ${shownName(server)} left out: ${oneLine(errorMessage(err), 200)}`);
        continue;
      }
      candidates.push({ tool: name, description: oneLine(parsed.data.description ?? '', MAX_TOOL_DESCRIPTION_CHARS), inputShape: compactSchema(parsed.data.inputSchema), checkOutput });
    }
    for (const c of candidates) {
      const qualifiedName = qualifiedMcpName(server, c.tool);
      if ((counts.get(c.tool) ?? 0) > 1 || seen.has(qualifiedName)) {
        if (!seen.has(`!${qualifiedName}`)) problems.push(`tool ${shownName(c.tool)} of MCP server ${shownName(server)} left out: ${qualifiedName} names more than one tool`);
        seen.add(`!${qualifiedName}`);
        continue;
      }
      seen.add(qualifiedName);
      const entry: McpToolEntry = { server, tool: c.tool, qualifiedName, description: c.description, inputShape: c.inputShape, ...(c.checkOutput === undefined ? {} : { checkOutput: c.checkOutput }) };
      entries.push(entry);
      byKey.set(JSON.stringify([server, c.tool]), entry);
    }
  }
  return {
    tools: entries,
    servers,
    problems,
    lookup: (server, tool) => byKey.get(JSON.stringify([server, tool])),
  };
}

/** Brands a server name that passes the name rules (the only way to mint one). */
function isMcpServerName(name: string): name is McpServerName {
  return mcpNameProblem(name) === undefined;
}

/** Brands a tool name that passes the name rules. */
function isMcpToolName(name: string): name is McpToolName {
  return mcpNameProblem(name) === undefined;
}

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

/**
 * Every page of `tools/list` up to `MAX_LIST_PAGES`. The first `MAX_TOOLS_PER_SERVER` entries are kept; past
 * that only the names are, so that a name listed twice is still found when one copy is beyond the cap.
 */
async function listAll(client: Client, timeoutMs: number): Promise<{ tools: unknown[]; truncated: boolean; overflowNames: string[] }> {
  const tools: unknown[] = [];
  const overflowNames: string[] = [];
  let truncated = false;
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const raw: unknown = await client.listTools(cursor === undefined ? undefined : { cursor }, { timeout: timeoutMs });
    const parsed = ListPageSchema.safeParse(raw);
    if (!parsed.success) throw new Error('tools/list returned an invalid result');
    for (const t of parsed.data.tools) {
      if (tools.length < MAX_TOOLS_PER_SERVER) {
        tools.push(t);
        continue;
      }
      truncated = true;
      const named = NameOnly.safeParse(t);
      if (named.success && overflowNames.length < MAX_OVERFLOW_NAMES) overflowNames.push(named.data.name);
    }
    cursor = parsed.data.nextCursor;
    if (cursor === undefined) return { tools, truncated, overflowNames };
  }
  return { tools, truncated: true, overflowNames };
}

/**
 * Spawns, initializes and lists every configured server, in parallel. Never
 * rejects: a server that fails is closed and reported in `catalog.problems`.
 * When `opts.signal` aborts, every server process spawned so far is closed at
 * once (connected or still connecting) and the result has no server.
 */
export async function connectUpstreams(configs: readonly McpServerConfig[], opts: ConnectOptions = {}): Promise<McpUpstream> {
  const problems: string[] = [];
  const connectMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const listMs = opts.listTimeoutMs ?? DEFAULT_LIST_TIMEOUT_MS;
  const stopped = (): boolean => opts.signal?.aborted === true;
  const results = await Promise.all(
    configs.map(async (config): Promise<{ conn: Connection; tools: unknown[]; truncated: boolean; overflowNames: string[] } | undefined> => {
      if (stopped()) return undefined;
      if (!isMcpServerName(config.name)) {
        problems.push(`MCP server ${shownName(config.name)} left out: ${mcpNameProblem(config.name) ?? 'invalid name'}`);
        return undefined;
      }
      const name = config.name;
      const transport = new StdioClientTransport({
        command: config.command,
        args: [...config.args],
        env: { ...getDefaultEnvironment(), ...config.env },
        stderr: 'pipe',
        ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
      });
      let stderrTail = '';
      transport.stderr?.on('data', (chunk: Buffer | string) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_CHARS);
      });
      const client = new Client({ name: opts.clientName ?? 'agent-code-mode', version: opts.clientVersion ?? '0.0.0' }, { capabilities: {} });
      const conn: Connection = { name, client, closedReason: undefined };
      client.onclose = () => {
        conn.closedReason ??= 'the server process exited or closed its pipes';
      };
      // Errors of the transport (a line that is not JSON) are not fatal by themselves.
      client.onerror = () => undefined;
      const abort = (): void => {
        void client.close().catch(() => undefined);
        void transport.close().catch(() => undefined);
      };
      opts.signal?.addEventListener('abort', abort, { once: true });
      try {
        await withTimeout(client.connect(transport, { timeout: connectMs }), connectMs, 'starting and initializing the server');
        const listed = await withTimeout(listAll(client, listMs), listMs * MAX_LIST_PAGES, 'listing the tools');
        if (conn.closedReason !== undefined) throw new Error(conn.closedReason);
        if (stopped()) throw new Error('the start was stopped');
        return { conn, ...listed };
      } catch (err) {
        await client.close().catch(() => undefined);
        await transport.close().catch(() => undefined);
        const tail = oneLine(stderrTail, 300);
        problems.push(`MCP server ${shownName(name)} left out: ${oneLine(errorMessage(err), 300)}${tail === '' ? '' : ` (stderr: ${tail})`}`);
        return undefined;
      } finally {
        opts.signal?.removeEventListener('abort', abort);
      }
    }),
  );
  const connected = results.filter((r): r is NonNullable<typeof r> => r !== undefined);
  const catalog = buildCatalog(
    connected.map((r) => ({ server: r.conn.name, tools: r.tools, truncated: r.truncated, overflowNames: r.overflowNames })),
    problems,
  );
  return new UpstreamSet(catalog, new Map(connected.map((r) => [r.conn.name, r.conn])));
}
