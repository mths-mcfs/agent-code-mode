import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { ToolError, errorMessage } from '../core/errors.js';
import { formatIssues } from '../core/schemas.js';
import type { McpEffect, McpResult, McpRuntime, McpServerSpec } from '../core/types.js';
import { shownName } from './names.js';

/**
 * The upstream MCP server processes of one `serve` process. A server starts at
 * the first authorized call to it, with exactly the command, arguments,
 * environment and directory the host config gives, and is kept for later
 * calls with the same spec. A call that times out, or a server that exits,
 * drops the connection; the next call starts the server again. The server's
 * stderr is discarded and its environment never appears in a message: both
 * can hold credentials.
 */

/** Largest result (characters of its JSON) handed back whole, as for bash output. */
export const MCP_RESULT_MAX_CHARS = 1024 * 1024;
const LIST_PAGES = 20;
const MAX_LISTED_TOOLS = 2_000;
const MAX_SERVERS = 32;

/** Where a cut result is kept for `readOverflow`. */
export interface OverflowSink {
  put(text: string): string | undefined;
}

export interface McpUpstreamsOptions {
  readonly overflow?: OverflowSink;
  readonly maxResultChars?: number;
  readonly clientVersion?: string;
}

interface Connection {
  readonly client: Client;
  readonly transport: StdioClientTransport;
  readonly tools: ReadonlySet<string>;
  closed: string | undefined;
}

const ListPage = z.looseObject({ tools: z.array(z.looseObject({ name: z.string() })), nextCursor: z.string().optional() });
const RawResult = z.unknown();
const McpErrorLike = z.looseObject({ code: z.number() });

/** Who a spec runs as: two specs with these equal share one process. */
function specKey(spec: McpServerSpec): string {
  return JSON.stringify([spec.name, spec.command, spec.args, Object.entries(spec.env).sort(([a], [b]) => (a < b ? -1 : 1)), spec.cwd]);
}

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

export class McpUpstreams implements McpRuntime {
  readonly #opts: McpUpstreamsOptions;
  readonly #connections = new Map<string, Promise<Connection>>();
  readonly #live = new Set<Connection>();
  #closed = false;

  constructor(opts: McpUpstreamsOptions = {}) {
    this.#opts = opts;
  }

  async call(spec: McpServerSpec, effect: McpEffect, signal: AbortSignal, onSent?: () => void): Promise<McpResult> {
    const what = effect.qualifiedName;
    if (signal.aborted) throw new ToolError('cancelled', `the run was stopped; ${what} was not sent`);
    const key = specKey(spec);
    const conn = await this.#connection(key, spec, signal);
    if (!conn.tools.has(effect.tool)) {
      const names = [...conn.tools].slice(0, 20).map(shownName).join(', ');
      throw new ToolError('invalid-args', `MCP server ${shownName(spec.name)} has no tool ${shownName(effect.tool)} (tools: ${names || 'none'}${conn.tools.size > 20 ? ', …' : ''})`);
    }
    if (signal.aborted) throw new ToolError('cancelled', `the run was stopped; ${what} was not sent`);
    let raw: unknown;
    try {
      onSent?.();
      raw = await conn.client.request({ method: 'tools/call', params: { name: effect.tool, arguments: { ...effect.input } } }, RawResult, { signal, timeout: effect.timeoutMs });
    } catch (err) {
      if (signal.aborted) throw new ToolError('cancelled', `${what} was cancelled while it ran; its effect is unknown`);
      const code = McpErrorLike.safeParse(err).data?.code;
      if (code === -32001) {
        // A server that missed its deadline may be stuck: the next call gets a fresh process.
        this.#drop(key, conn, 'a call timed out');
        throw new ToolError('tool-error', `${what} did not answer within ${effect.timeoutMs} ms; its effect is unknown (the server may have run it) and it was not retried`);
      }
      if (conn.closed !== undefined || code === -32000) {
        this.#drop(key, conn, conn.closed ?? 'the connection closed');
        throw new ToolError('tool-error', `MCP server ${shownName(spec.name)} exited or closed its pipes during ${what}; its effect is unknown and it was not retried`);
      }
      throw new ToolError('tool-error', `${what} failed: ${errorMessage(err)}`);
    }
    return shapeResult(raw, this.#opts.maxResultChars ?? MCP_RESULT_MAX_CHARS, this.#opts.overflow, what);
  }

  /** Ends every server process: stdin closed, then SIGTERM, then SIGKILL. */
  async close(): Promise<void> {
    this.#closed = true;
    const all = [...this.#connections.values()];
    this.#connections.clear();
    await Promise.allSettled(all.map(async (pending) => (await pending).client.close()));
  }

  /** For process exit and fatal signals, when no async cleanup can run: SIGKILL every live server process. */
  killAll(): void {
    this.#closed = true;
    for (const conn of this.#live) {
      const pid = conn.transport.pid;
      if (pid !== null) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
    }
  }

  #connection(key: string, spec: McpServerSpec, signal: AbortSignal): Promise<Connection> {
    if (this.#closed) return Promise.reject(new ToolError('tool-error', 'the server is shutting down; no MCP server is started'));
    let pending = this.#connections.get(key);
    if (pending === undefined) {
      if (this.#connections.size >= MAX_SERVERS) {
        return Promise.reject(new ToolError('tool-error', `more than ${MAX_SERVERS} upstream MCP server processes would run at once`));
      }
      pending = this.#start(spec);
      this.#connections.set(key, pending);
      pending.catch(() => {
        if (this.#connections.get(key) === pending) this.#connections.delete(key);
      });
    }
    // The start goes on when the run stops (the next call can use it); this call stops waiting.
    return new Promise<Connection>((resolve, reject) => {
      const onAbort = (): void => reject(new ToolError('cancelled', `the run was stopped while MCP server ${shownName(spec.name)} was starting`));
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      pending.then(
        (conn) => {
          signal.removeEventListener('abort', onAbort);
          resolve(conn);
        },
        (err: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      );
    });
  }

  async #start(spec: McpServerSpec): Promise<Connection> {
    const transport = new StdioClientTransport({ command: spec.command, args: [...spec.args], env: { ...spec.env }, cwd: spec.cwd, stderr: 'ignore' });
    const client = new Client({ name: 'agent-code-mode', version: this.#opts.clientVersion ?? '0.0.0' }, { capabilities: {} });
    let closed: string | undefined;
    client.onclose = () => {
      closed ??= 'the server process exited or closed its pipes';
    };
    // A line that is not JSON-RPC is not fatal by itself.
    client.onerror = () => undefined;
    const deadline = Date.now() + spec.startupTimeoutMs;
    const left = (): number => Math.max(1, deadline - Date.now());
    try {
      await withTimeout(client.connect(transport), spec.startupTimeoutMs, `did not start and initialize within ${spec.startupTimeoutMs} ms`);
      const tools = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < LIST_PAGES && tools.size < MAX_LISTED_TOOLS; page++) {
        const raw = await client.request({ method: 'tools/list', params: cursor === undefined ? {} : { cursor } }, RawResult, { timeout: left() });
        const parsed = ListPage.safeParse(raw);
        if (!parsed.success) throw new Error('tools/list returned an invalid result');
        for (const t of parsed.data.tools) tools.add(t.name);
        cursor = parsed.data.nextCursor;
        if (cursor === undefined) break;
      }
      if (closed !== undefined) throw new Error(closed);
      const conn: Connection = { client, transport, tools, closed: undefined };
      client.onclose = () => {
        conn.closed ??= 'the server process exited or closed its pipes';
        this.#live.delete(conn);
      };
      this.#live.add(conn);
      if (this.#closed) {
        await client.close().catch(() => undefined);
        throw new Error('the server is shutting down');
      }
      return conn;
    } catch (err) {
      await client.close().catch(() => undefined);
      throw new ToolError('tool-error', `MCP server ${shownName(spec.name)} (${spec.origin}) could not be started: ${errorMessage(err)}`);
    }
  }

  #drop(key: string, conn: Connection, why: string): void {
    conn.closed ??= why;
    void this.#connections.get(key)?.then((current) => {
      if (current === conn) this.#connections.delete(key);
    }, () => undefined);
    this.#live.delete(conn);
    void conn.client.close().catch(() => undefined);
  }
}

// Content blocks as the MCP spec defines them; another shape makes the result invalid.
const TextBlock = z.looseObject({ type: z.literal('text'), text: z.string() });
const MediaBlock = z.looseObject({ type: z.enum(['image', 'audio']), data: z.string(), mimeType: z.string() });
const LinkBlock = z.looseObject({ type: z.literal('resource_link'), uri: z.string(), name: z.string() });
const ResourceBlock = z.looseObject({
  type: z.literal('resource'),
  resource: z.union([z.looseObject({ uri: z.string(), text: z.string() }), z.looseObject({ uri: z.string(), blob: z.string(), mimeType: z.string().optional() })]),
});
const ContentBlock = z.discriminatedUnion('type', [TextBlock, MediaBlock, LinkBlock, ResourceBlock]);
const CallResult = z.looseObject({ content: z.array(ContentBlock).optional(), structuredContent: z.unknown().optional(), isError: z.boolean().optional() });

function blockText(block: z.infer<typeof ContentBlock>): string {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'image':
    case 'audio':
      return `[${block.type} content omitted (${block.mimeType})]`;
    case 'resource_link':
      return `[resource link ${block.uri}]`;
    case 'resource':
      return 'text' in block.resource && typeof block.resource.text === 'string' ? block.resource.text : `[resource ${block.resource.uri}: binary content omitted]`;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * The script's view of a raw `tools/call` result: `structuredContent` when
 * present, else the joined text of the content blocks, plus `isError`. Past
 * `maxChars` of JSON the result is cut and the whole kept in `overflow`.
 */
export function shapeResult(raw: unknown, maxChars: number, overflow: OverflowSink | undefined, what: string): McpResult {
  const parsed = CallResult.safeParse(raw);
  if (!parsed.success) throw new ToolError('tool-error', `${what} returned a result that is not a valid tools/call result: ${formatIssues(parsed.error)}`);
  const { content, structuredContent, isError = false } = parsed.data;
  if (structuredContent !== undefined && !isPlainObject(structuredContent)) throw new ToolError('tool-error', `${what} returned a structuredContent that is not an object`);
  if (content === undefined && structuredContent === undefined) throw new ToolError('tool-error', `${what} returned a result with neither content nor structuredContent`);
  const whole: McpResult = structuredContent !== undefined ? { isError, structuredContent } : { isError, text: (content ?? []).map(blockText).join('\n') };
  if (JSON.stringify(whole).length <= maxChars) return whole;
  const full = structuredContent !== undefined ? JSON.stringify(structuredContent) : (whole.text ?? '');
  const id = overflow?.put(full);
  const cut = (head: string): McpResult =>
    id !== undefined
      ? { isError, text: head, truncated: true, overflow: { id, chars: full.length } }
      : { isError, text: head, truncated: true, warning: `the result was cut to ${head.length} of ${full.length} characters and could not be kept for readOverflow; ask the tool for less` };
  // The cap is on the JSON that goes to the sandbox, where one character can take up to 6.
  let lo = 0;
  let hi = Math.min(full.length, maxChars);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (JSON.stringify(cut(full.slice(0, mid))).length <= maxChars) lo = mid;
    else hi = mid - 1;
  }
  return cut(full.slice(0, lo));
}
