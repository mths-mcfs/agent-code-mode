/**
 * Name rules for upstream MCP servers and their tools. A name ends up inside
 * the host's tool name `mcp__<server>__<tool>`, which permission rules and
 * hook matchers are written against, so it must keep that string
 * unambiguous: only `[A-Za-z0-9_-]`, no `__` inside, no `_` or `-` at either
 * end (`a_` + `_b` would read as `a` + `__` + `b`), bounded length.
 */

export const MAX_MCP_NAME_CHARS = 64;

const NAME = /^[A-Za-z0-9_-]+$/;

/** Why `name` cannot be a server or tool name, or undefined when it can. */
export function mcpNameProblem(name: string): string | undefined {
  if (name.length === 0) return 'the name is empty';
  if (name.length > MAX_MCP_NAME_CHARS) return `the name is longer than ${MAX_MCP_NAME_CHARS} characters`;
  if (!NAME.test(name)) return 'the name may only contain letters, digits, `_` and `-`';
  if (name.includes('__')) return 'the name contains `__`, which separates server and tool in mcp__<server>__<tool>';
  if (/^[_-]|[_-]$/.test(name)) return 'the name starts or ends with `_` or `-`';
  return undefined;
}

export function qualifiedMcpName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

/** A short, single-line, printable form of an untrusted name for messages. */
export function shownName(name: string): string {
  const flat = name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '?');
  return JSON.stringify(flat.length > 80 ? `${flat.slice(0, 79)}…` : flat);
}
