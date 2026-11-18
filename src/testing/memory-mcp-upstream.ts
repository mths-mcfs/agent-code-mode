import { fileURLToPath } from 'node:url';
import type { McpCall, PreparedMcpCall } from '../core/types.js';
import { McpBindingRuntime, type McpBindingOptions } from '../mcp/binding.js';
import { buildCatalog, type McpToolEntry, type McpUpstream, type UpstreamCallOptions, type UpstreamFailure } from '../mcp/upstream.js';

/** Absolute path of the stdio fake upstream server (`node <path> <variant>`). */
export const FAKE_MCP_UPSTREAM = fileURLToPath(new URL('./fake-mcp-upstream.ts', import.meta.url));

/** What an in-memory upstream tool does with a call. */
export type MemoryMcpHandler = (
  entry: McpToolEntry,
  input: Readonly<Record<string, unknown>>,
  opts: UpstreamCallOptions,
) => Promise<{ ok: true; result: unknown } | { ok: false; failure: UpstreamFailure }>;

/** An upstream set held in memory: `tools` maps each server to its tool names. Records every call it gets. */
export class MemoryMcpUpstream implements McpUpstream {
  readonly catalog;
  readonly calls: { qualifiedName: string; input: Readonly<Record<string, unknown>> }[] = [];
  closed = false;
  readonly #handler: MemoryMcpHandler;

  constructor(tools: Readonly<Record<string, readonly string[]>>, handler?: MemoryMcpHandler) {
    this.catalog = buildCatalog(
      Object.entries(tools).map(([server, names]) => ({ server, tools: names.map((name) => ({ name, inputSchema: { type: 'object' } })), truncated: false })),
      [],
    );
    this.#handler = handler ?? (async (entry, input) => ({ ok: true, result: { content: [{ type: 'text', text: `${entry.qualifiedName} ${JSON.stringify(input)}` }] } }));
  }

  async call(entry: McpToolEntry, input: Readonly<Record<string, unknown>>, opts: UpstreamCallOptions): Promise<{ ok: true; result: unknown } | { ok: false; failure: UpstreamFailure }> {
    this.calls.push({ qualifiedName: entry.qualifiedName, input });
    opts.onSent?.();
    return this.#handler(entry, input, opts);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** A binding runtime over `upstream`, for tests. */
export function memoryMcpRuntime(upstream: McpUpstream, opts: Omit<McpBindingOptions, 'upstream'> = {}): McpBindingRuntime {
  return new McpBindingRuntime({ upstream, ...opts });
}

/** A prepared `mcpCall` for adapter tests; throws when the tool is not in the catalog or the input is not an object. */
export function preparedMcpCall(upstream: McpUpstream, server: string, tool: string, input: unknown = {}, id = 'c1'): PreparedMcpCall {
  const runtime = memoryMcpRuntime(upstream);
  const parsed = runtime.parse({ server, tool, args: input }, id);
  if (!parsed.ok) throw new Error(parsed.message);
  const call: McpCall = parsed.call;
  return runtime.prepare(call);
}
