import { oneLine, type McpCatalog } from './upstream.js';

/** Characters of the catalog section of the `run` description. */
export const MAX_CATALOG_DESCRIPTION_CHARS = 8_000;

/** The `mcpCall` signature line of the `run` description. */
export const MCP_CALL_DECLARATION =
  'declare function mcpCall(server: string, tool: string, args?: object, options?: {timeoutMs?: number}): Promise<{isError: boolean; structuredContent?: unknown; text?: string; truncated?: true; overflow?: {id: string; chars: number}; warning?: string}>; // an upstream MCP tool, authorized as mcp__<server>__<tool>; never rolled back; a timeout leaves its effect unknown (not retried)';

/** The `--hybrid` line for MCP: chain the upstream calls in one script. */
export const MCP_HYBRID_GUIDANCE = 'To chain several upstream MCP tool calls, call them with mcpCall in one run script and return only the summary the next step needs.';

/**
 * The part of the `run` description that lists the upstream tools: the
 * `mcpCall` declaration, then one line per tool (`server.tool(shape)`: and
 * its description) up to `maxChars`, a note of how many were not listed,
 * and what was left out at start.
 */
export function describeCatalog(catalog: McpCatalog, maxChars: number = MAX_CATALOG_DESCRIPTION_CHARS): string {
  const head = [MCP_CALL_DECLARATION, 'Upstream MCP tools (mcpCall(server, tool, args)):'];
  const problems =
    catalog.problems.length === 0
      ? []
      : ['Left out at start:', ...catalog.problems.slice(0, 5).map((p) => `- ${oneLine(p, 200)}`), ...(catalog.problems.length > 5 ? [`- …[${catalog.problems.length - 5} more]`] : [])];
  const more = (n: number): string => `- …[${n} more tools not listed here: the description reached its size cap]`;
  const size = (lines: readonly string[]): number => lines.join('\n').length;
  // The tool lines get what the fixed parts leave, with room kept for the "more tools" note.
  const budget = maxChars - size([...head, ...problems]) - 1 - (more(catalog.tools.length).length + 1);
  const tools: string[] = [];
  let used = 0;
  for (const t of catalog.tools) {
    const line = `- ${t.server}.${t.tool}(${t.inputShape})${t.description === '' ? '' : `: ${t.description}`}`;
    if (used + line.length + 1 > budget) break;
    tools.push(line);
    used += line.length + 1;
  }
  if (catalog.tools.length === 0) tools.push('- none (no upstream server connected or none listed a usable tool)');
  if (tools.length < catalog.tools.length) tools.push(more(catalog.tools.length - tools.length));
  const text = [...head, ...tools, ...problems].join('\n');
  // Only fixed parts larger than the cap itself could still overflow: cut them, the cap is a hard bound.
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}
