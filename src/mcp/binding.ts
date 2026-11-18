import { z } from 'zod';
import { ToolError } from '../core/errors.js';
import { formatIssues } from '../core/schemas.js';
import type { McpCall, McpResult, McpRuntime, PreparedMcpCall } from '../core/types.js';
import { shownName } from './names.js';
import type { McpToolEntry, McpUpstream } from './upstream.js';

/**
 * The `mcpCall(server, tool, args, options?)` binding: validation against the
 * catalog fixed at start, the effect that is authorized, the call upstream
 * and the shaping of its result (size-capped before it goes back to the
 * sandbox).
 */

/** Per-call timeout when the script gives none. */
export const DEFAULT_MCP_CALL_TIMEOUT_MS = 60_000;
/** Largest per-call timeout a script may ask for. */
export const MAX_MCP_CALL_TIMEOUT_MS = 600_000;
/** Largest result (characters of its JSON) handed back whole; a larger one is cut. */
export const MCP_RESULT_MAX_CHARS = 200_000;

const RawCallSchema = z.strictObject({
  server: z.string().max(200),
  tool: z.string().max(200),
  args: z.unknown().optional(),
  options: z.strictObject({ timeoutMs: z.number().int().min(1).max(MAX_MCP_CALL_TIMEOUT_MS).optional() }).optional(),
});

/** A plain JSON object (what `JSON.parse` returns for `{...}`): not null, not an array. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Content blocks as the MCP SDK's ContentBlockSchema defines them: a block of another shape, or of a type
// the protocol does not have, makes the whole result invalid (as the SDK's own result schema would).
const TextBlock = z.looseObject({ type: z.literal('text'), text: z.string() });
const MediaBlock = z.looseObject({ type: z.enum(['image', 'audio']), data: z.string(), mimeType: z.string() });
const LinkBlock = z.looseObject({ type: z.literal('resource_link'), uri: z.string(), name: z.string(), mimeType: z.string().optional() });
const ResourceBlock = z.looseObject({
  type: z.literal('resource'),
  resource: z.union([
    z.looseObject({ uri: z.string(), text: z.string(), mimeType: z.string().optional() }),
    z.looseObject({ uri: z.string(), blob: z.string(), mimeType: z.string().optional() }),
  ]),
});
const ContentBlock = z.discriminatedUnion('type', [TextBlock, MediaBlock, LinkBlock, ResourceBlock]);
const CallResultSchema = z.looseObject({
  content: z.array(ContentBlock).optional(),
  // Checked as a plain object below: a parsed record would turn a `__proto__` key into a prototype.
  structuredContent: z.unknown().optional(),
  isError: z.boolean().optional(),
});

/** The text of a content block; non-text blocks become a short note. */
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
      return 'text' in block.resource && typeof block.resource.text === 'string'
        ? block.resource.text
        : `[resource ${block.resource.uri}${block.resource.mimeType ? ` (${block.resource.mimeType})` : ''}: binary content omitted]`;
  }
}

/** Where a cut result is kept for `readOverflow`. */
export interface McpOverflowSink {
  put(text: string): string | undefined;
}

export interface McpBindingOptions {
  readonly upstream: McpUpstream;
  /** Keeps results over the cap for `readOverflow`. Without it they are only cut. */
  readonly overflow?: McpOverflowSink;
  readonly defaultTimeoutMs?: number;
  readonly maxResultChars?: number;
}

/**
 * Shapes a raw `tools/call` result: `structuredContent` when present, else
 * the text of the content blocks joined with newlines, plus `isError`. Above
 * `maxChars` (JSON characters) the result is cut and the whole text kept in
 * `overflow` when possible. Throws `ToolError` when the result is invalid.
 */
export function shapeResult(raw: unknown, maxChars: number, overflow: McpOverflowSink | undefined, what: string): McpResult {
  const parsed = CallResultSchema.safeParse(raw);
  if (!parsed.success) throw new ToolError('tool-error', `${what} returned a result that is not a valid tools/call result: ${formatIssues(parsed.error)}`);
  const isError = parsed.data.isError === true;
  const structured = parsed.data.structuredContent;
  if (structured !== undefined && !isJsonObject(structured)) throw new ToolError('tool-error', `${what} returned a structuredContent that is not an object`);
  // `content` is required by the protocol; a result with only `structuredContent` is accepted, one with neither is not a result.
  if (parsed.data.content === undefined && structured === undefined) throw new ToolError('tool-error', `${what} returned a result that is not a valid tools/call result: it has neither content nor structuredContent`);
  const whole: McpResult = structured !== undefined ? { isError, structuredContent: structured } : { isError, text: (parsed.data.content ?? []).map(blockText).join('\n') };
  if (JSON.stringify(whole).length <= maxChars) return whole;
  const full = structured !== undefined ? JSON.stringify(structured) : (whole.text ?? '');
  const id = overflow?.put(full);
  const cut = (head: string): McpResult =>
    id !== undefined
      ? { isError, text: head, truncated: true, overflow: { id, chars: full.length } }
      : { isError, text: head, truncated: true, warning: `the result was cut to ${head.length} of ${full.length} characters and could not be kept for readOverflow; ask the tool for less` };
  return cut(full.slice(0, longestHead(full, maxChars, (head) => JSON.stringify(cut(head)).length)));
}

/**
 * The most characters of `full` whose cut result serializes to at most `maxChars`: the cap is on the JSON
 * that goes to the sandbox, where a newline or a control character takes 2 to 6 characters.
 */
function longestHead(full: string, maxChars: number, size: (head: string) => number): number {
  let lo = 0;
  let hi = Math.min(full.length, maxChars);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (size(full.slice(0, mid)) <= maxChars) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** `McpRuntime` over a set of connected upstream servers. */
export class McpBindingRuntime implements McpRuntime {
  readonly #opts: McpBindingOptions;

  constructor(opts: McpBindingOptions) {
    this.#opts = opts;
  }

  parse(args: unknown, id: string): { ok: true; call: McpCall } | { ok: false; message: string } {
    const r = RawCallSchema.safeParse(args);
    if (!r.success) return { ok: false, message: formatIssues(r.error) };
    const { server, tool } = r.data;
    const catalog = this.#opts.upstream.catalog;
    const entry = catalog.lookup(server, tool);
    if (entry === undefined) {
      if (!catalog.servers.some((s) => s === server)) {
        const known = catalog.servers.length === 0 ? 'none connected' : catalog.servers.map((s) => shownName(s)).join(', ');
        return { ok: false, message: `unknown MCP server ${shownName(server)} (servers: ${known})` };
      }
      const tools = catalog.tools.filter((t) => t.server === server).map((t) => t.tool);
      const listed = tools.slice(0, 20).join(', ') + (tools.length > 20 ? `, … (${tools.length - 20} more)` : '');
      return { ok: false, message: `MCP server ${shownName(server)} has no tool ${shownName(tool)} (tools: ${listed || 'none'})` };
    }
    const input = r.data.args === undefined ? {} : r.data.args;
    if (!isJsonObject(input)) return { ok: false, message: 'args must be an object (the tool arguments), e.g. mcpCall("srv", "tool", {key: "value"})' };
    const timeoutMs = r.data.options?.timeoutMs;
    return { ok: true, call: { id, tool: 'mcp', args: { server: entry.server, tool: entry.tool, input, ...(timeoutMs === undefined ? {} : { timeoutMs }) } } };
  }

  prepare(call: McpCall): PreparedMcpCall {
    const entry = this.#entry(call.args.server, call.args.tool);
    return {
      id: call.id,
      tool: 'mcp',
      args: call.args,
      effect: {
        server: entry.server,
        tool: entry.tool,
        qualifiedName: entry.qualifiedName,
        input: call.args.input,
        timeoutMs: call.args.timeoutMs ?? this.#opts.defaultTimeoutMs ?? DEFAULT_MCP_CALL_TIMEOUT_MS,
      },
    };
  }

  async commit(prepared: PreparedMcpCall, signal: AbortSignal, onSent?: () => void): Promise<McpResult> {
    const entry = this.#entry(prepared.effect.server, prepared.effect.tool);
    const outcome = await this.#opts.upstream.call(entry, prepared.effect.input, { signal, timeoutMs: prepared.effect.timeoutMs, ...(onSent === undefined ? {} : { onSent }) });
    if (!outcome.ok) throw new ToolError(outcome.failure.kind === 'cancelled' ? 'cancelled' : 'tool-error', outcome.failure.message);
    return shapeResult(outcome.result, this.#opts.maxResultChars ?? MCP_RESULT_MAX_CHARS, this.#opts.overflow, entry.qualifiedName);
  }

  #entry(server: string, tool: string): McpToolEntry {
    const entry = this.#opts.upstream.catalog.lookup(server, tool);
    if (entry === undefined) throw new ToolError('invalid-args', `MCP tool ${shownName(server)}.${shownName(tool)} is not in the catalog`);
    return entry;
  }
}
