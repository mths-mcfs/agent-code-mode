import { z } from 'zod';
import { ToolError } from '../core/errors.js';
import { formatIssues } from '../core/schemas.js';
import type { McpCall, McpPolicy, McpServerSpec, PreparedMcpCall } from '../core/types.js';
import { mcpNameProblem, qualifiedMcpName, shownName } from './names.js';

/** `mcpCall(server, tool, args?, options?)`: validation of the script's arguments and the prepared call. */

export const DEFAULT_MCP_CALL_TIMEOUT_MS = 60_000;
export const MAX_MCP_CALL_TIMEOUT_MS = 600_000;

const Name = z.string().max(200).superRefine((name, ctx) => {
  const problem = mcpNameProblem(name);
  if (problem !== undefined) ctx.addIssue({ code: 'custom', message: problem });
});

const RawCall = z.strictObject({
  server: Name,
  tool: Name,
  args: z.unknown().optional(),
  options: z.strictObject({ timeoutMs: z.number().int().min(1).max(MAX_MCP_CALL_TIMEOUT_MS).optional() }).optional(),
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Validates untrusted `mcpCall` arguments as they come from the sandbox. */
export function parseMcpCall(args: unknown, id: string): McpCall | ToolError {
  const r = RawCall.safeParse(args);
  if (!r.success) return new ToolError('invalid-args', `mcpCall: ${formatIssues(r.error)}`);
  const input = r.data.args ?? {};
  if (!isPlainObject(input)) return new ToolError('invalid-args', 'mcpCall: args must be an object of tool arguments, e.g. mcpCall("server", "tool", {key: "value"})');
  const timeoutMs = r.data.options?.timeoutMs;
  return { id, tool: 'mcp', args: { server: r.data.server, tool: r.data.tool, input, ...(timeoutMs === undefined ? {} : { timeoutMs }) } };
}

/** The server spec and the exact effect of a call, or why the host session has no such server. */
export function prepareMcpCall(call: McpCall, mcp: McpPolicy | undefined): { prepared: PreparedMcpCall; spec: McpServerSpec } | ToolError {
  const { server, tool, input } = call.args;
  const spec = mcp?.servers.find((s) => s.name === server);
  if (spec === undefined) {
    const known = mcp === undefined || mcp.servers.length === 0 ? 'none' : mcp.servers.map((s) => shownName(s.name)).join(', ');
    const notes = mcp === undefined || mcp.notes.length === 0 ? '' : `; left out: ${mcp.notes.slice(0, 5).join('; ')}${mcp.notes.length > 5 ? '; …' : ''}`;
    return new ToolError('invalid-args', `mcpCall: the host configures no MCP server ${shownName(server)} for this session (servers: ${known}${notes})`);
  }
  const timeoutMs = Math.min(call.args.timeoutMs ?? DEFAULT_MCP_CALL_TIMEOUT_MS, spec.toolTimeoutMs ?? MAX_MCP_CALL_TIMEOUT_MS);
  return { prepared: { id: call.id, tool: 'mcp', args: call.args, effect: { server, tool, qualifiedName: qualifiedMcpName(server, tool), input, timeoutMs } }, spec };
}
