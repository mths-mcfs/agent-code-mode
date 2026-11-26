import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { ToolError, errorMessage } from '../core/errors.js';
import { formatIssues } from '../core/schemas.js';
import type { McpEffect, McpResult, McpRuntime, McpServerSpec } from '../core/types.js';
import { shownName } from './names.js';

/** Largest result (characters of its JSON) handed back whole, as for bash output. */
export const MCP_RESULT_MAX_CHARS = 1024 * 1024;
const LIST_PAGES = 20;
const MAX_LISTED_TOOLS = 2_000;
const MAX_SERVERS = 32;

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
  readonly tools: Set<string>;
  closed: string | undefined;
}

const ListPage = z.looseObject({ tools: z.array(z.looseObject({ name: z.string() })), nextCursor: z.string().optional() });
const RawResult = z.unknown();
const McpErrorLike = z.looseObject({ code: z.number() });

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
  readonly #processes = new Set<StdioClientTransport>();
  #started: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(opts: McpUpstreamsOptions = {}) {
    this.#opts = opts;
  }

  /**
   * Starts the servers of the session, once, as the host does when the session starts. A server is never
   * started later, nor started again after it exits: a process spawned from files a script may have
   * changed since would run that script's code outside the host's limits.
   */
  start(specs: Promise<readonly McpServerSpec[]>): void {
    this.#started = specs.then(
      (list) => {
        for (const spec of list) {
          const key = specKey(spec);
          if (this.#closed || this.#connections.has(key) || this.#connections.size >= MAX_SERVERS) continue;
          const pending = this.#start(spec);
          pending.catch(() => undefined);
          this.#connections.set(key, pending);
        }
      },
      () => undefined,
    );
  }

  async call(spec: McpServerSpec, effect: McpEffect, signal: AbortSignal, onSent?: () => void): Promise<McpResult> {
    const what = effect.qualifiedName;
    if (signal.aborted) throw new ToolError('cancelled', `the run was stopped; ${what} was not sent`);
    await untilAborted(this.#started, signal, `the run was stopped while the session's MCP servers were starting`);
    const pending = this.#connections.get(specKey(spec));
    if (pending === undefined) {
      throw new ToolError('tool-error', `MCP server ${shownName(spec.name)} was not started with this session: servers start once, when the session starts, as the host starts them (restart the session after a config change)`);
    }
    const conn = await untilAborted(pending, signal, `the run was stopped while MCP server ${shownName(spec.name)} was starting`);
    if (conn.closed !== undefined) throw new ToolError('tool-error', `MCP server ${shownName(spec.name)} is no longer running (${conn.closed}); it is not started again in this session`);
    if (!conn.tools.has(effect.tool)) {
      const names = [...conn.tools].slice(0, 20).map(shownName).join(', ');
      throw new ToolError('invalid-args', `MCP server ${shownName(spec.name)} has no tool ${shownName(effect.tool)} (tools: ${names || 'none'}${conn.tools.size > 20 ? ', …' : ''})`);
    }
    let raw: unknown;
    try {
      onSent?.();
      raw = await conn.client.request({ method: 'tools/call', params: { name: effect.tool, arguments: { ...effect.input } } }, RawResult, { signal, timeout: effect.timeoutMs });
    } catch (err) {
      if (signal.aborted) throw new ToolError('cancelled', `${what} was cancelled while it ran; its effect is unknown`);
      const code = McpErrorLike.safeParse(err).data?.code;
      if (code === -32001) throw new ToolError('tool-error', `${what} did not answer within ${effect.timeoutMs} ms; its effect is unknown (the server may have run it) and it was not retried`);
      if (conn.closed !== undefined || code === -32000) {
        throw new ToolError('tool-error', `MCP server ${shownName(spec.name)} exited or closed its pipes during ${what}; its effect is unknown, and the server is not started again in this session`);
      }
      throw new ToolError('tool-error', `${what} failed: ${errorMessage(err)}`);
    }
    return shapeResult(raw, this.#opts.maxResultChars ?? MCP_RESULT_MAX_CHARS, this.#opts.overflow, what);
  }

  /** Ends every server process: stdin closed, then SIGTERM, then SIGKILL. */
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([...this.#processes].map((t) => t.close()));
  }

  /** For process exit and fatal signals, when no async cleanup can run: SIGKILL every server process. */
  killAll(): void {
    this.#closed = true;
    for (const transport of this.#processes) {
      const pid = transport.pid;
      if (pid === null) continue;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
      }
    }
  }

  async #start(spec: McpServerSpec): Promise<Connection> {
    const transport = new StdioClientTransport({ command: spec.command, args: [...spec.args], env: { ...spec.env }, cwd: spec.cwd, stderr: 'ignore' });
    const client = new Client({ name: 'agent-code-mode', version: this.#opts.clientVersion ?? '0.0.0' }, { capabilities: {} });
    const conn: Connection = { client, transport, tools: new Set(), closed: undefined };
    client.onclose = () => {
      conn.closed ??= 'the server process exited or closed its pipes';
      this.#processes.delete(transport);
    };
    // A line that is not JSON-RPC is not fatal by itself.
    client.onerror = () => undefined;
    this.#processes.add(transport);
    const deadline = Date.now() + spec.startupTimeoutMs;
    const left = (): number => Math.max(1, deadline - Date.now());
    try {
      await withTimeout(client.connect(transport), spec.startupTimeoutMs, `did not start and initialize within ${spec.startupTimeoutMs} ms`);
      let cursor: string | undefined;
      for (let page = 0; page < LIST_PAGES && conn.tools.size < MAX_LISTED_TOOLS; page++) {
        const raw = await client.request({ method: 'tools/list', params: cursor === undefined ? {} : { cursor } }, RawResult, { timeout: left() });
        const parsed = ListPage.safeParse(raw);
        if (!parsed.success) throw new Error('tools/list returned an invalid result');
        for (const t of parsed.data.tools) conn.tools.add(t.name);
        cursor = parsed.data.nextCursor;
        if (cursor === undefined) break;
      }
      if (conn.closed !== undefined) throw new Error(conn.closed);
      return conn;
    } catch (err) {
      await client.close().catch(() => undefined);
      throw new ToolError('tool-error', `MCP server ${shownName(spec.name)} (${spec.origin}) could not be started: ${errorMessage(err)}`);
    }
  }
}

function untilAborted<T>(pending: Promise<T>, signal: AbortSignal, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new ToolError('cancelled', message));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
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
