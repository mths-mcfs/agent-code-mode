/**
 * Name rules for upstream MCP servers and their tools. A name ends up inside
 * the host's tool name `mcp__<server>__<tool>`, which permission rules and
 * hook matchers are written against, so a name must keep that string
 * unambiguous: no `__` inside, no `_` or `-` at either end (`a_` + `_b` would
 * read as `a` + `__` + `b`), only `[A-Za-z0-9_-]`, bounded length, and none of
 * the names that mean something to a JavaScript object.
 */

/** Longest server or tool name accepted. */
export const MAX_MCP_NAME_CHARS = 64;

const NAME = /^[A-Za-z0-9_-]+$/;
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);

/** Why `name` cannot be used as a server or tool name, or undefined when it can. */
export function mcpNameProblem(name: string): string | undefined {
  if (name.length === 0) return 'the name is empty';
  if (name.length > MAX_MCP_NAME_CHARS) return `the name is longer than ${MAX_MCP_NAME_CHARS} characters`;
  if (!NAME.test(name)) return 'the name may only contain letters, digits, `_` and `-`';
  if (RESERVED.has(name)) return 'the name is reserved';
  if (name.includes('__')) return 'the name contains `__`, which separates server and tool in mcp__<server>__<tool>';
  if (/^[_-]|[_-]$/.test(name)) return 'the name starts or ends with `_` or `-`';
  return undefined;
}

/** The host's name of an upstream tool. */
export function qualifiedMcpName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

/** A short, single-line, printable form of an untrusted name for messages. */
export function shownName(name: string): string {
  const flat = name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
  return JSON.stringify(flat.length > 80 ? `${flat.slice(0, 79)}…` : flat);
}
