import path from 'node:path';
import { DEFAULT_CASE_INSENSITIVE, matchesPathPattern } from '../../core/paths.js';

/**
 * Claude Code permission rules: `Tool` or `Tool(specifier)`.
 *
 * Semantics follow https://code.claude.com/docs/en/permissions:
 * - Bash specifiers match the whole (sub)command text; `*` matches any text;
 *   a trailing ` *` (or legacy `:*`) also matches the bare prefix; no `*`
 *   means an exact match.
 * - Read/Edit specifiers are gitignore-style paths: `//abs`, `~/home`,
 *   `/relative-to-the-settings-source`, `./relative-to-cwd` and bare
 *   relative patterns (a bare name matches at any depth).
 * - Read rules also govern Grep and Glob; Edit rules govern Write and Edit.
 *   A Read deny rule also blocks Write/Edit on the same path.
 * - `Tool(param:value)` deny/ask rules match a top-level native input field.
 */

export type RuleSourceName = 'managed' | 'cli' | 'flag-settings' | 'local' | 'project' | 'user';

export type RuleKind = 'deny' | 'ask' | 'allow';

export type NativeToolName = 'Bash' | 'Read' | 'Write' | 'Edit' | 'Grep' | 'Glob';

export interface PathPattern {
  readonly anchor: string;
  readonly pattern: string;
}

export type RuleMatcher =
  | { readonly type: 'all' }
  /** Never matches (accepted by Claude but not matched, e.g. `Write(path)`, `!negation`). */
  | { readonly type: 'never' }
  | { readonly type: 'bash'; readonly spec: string }
  | { readonly type: 'path'; readonly patterns: readonly PathPattern[] }
  /** `Bash(timeout:*)` is ambiguous (parameter or the `timeout` command): `bashSpec` keeps the command reading. */
  | { readonly type: 'param'; readonly name: string; readonly value: string; readonly bashSpec?: string };

export interface Rule {
  readonly raw: string;
  readonly kind: RuleKind;
  readonly source: RuleSourceName;
  readonly tool: string;
  readonly matcher: RuleMatcher;
}

export interface RuleAnchors {
  readonly cwd: string;
  readonly sourceDir: string;
  readonly home: string;
}

/** Native input fields that `Tool(param:value)` rules may match (primary content fields excluded, as in Claude). */
const PARAM_FIELDS: Record<string, ReadonlySet<string>> = {
  Bash: new Set(['timeout', 'description', 'run_in_background', 'dangerouslyDisableSandbox']),
  Read: new Set(['offset', 'limit', 'pages']),
  Write: new Set(['content']),
  Edit: new Set(['old_string', 'new_string', 'replace_all']),
  Grep: new Set(['pattern', 'glob', 'output_mode', '-i', '-n', 'head_limit', 'type', 'multiline']),
  Glob: new Set(['pattern']),
};

export function toPosixPath(p: string): string {
  const slashed = p.replace(/\\/g, '/');
  const drive = /^([A-Za-z]):(\/|$)/.exec(slashed);
  if (drive?.[1]) return `/${drive[1].toLowerCase()}${slashed.slice(2) || '/'}`;
  return slashed;
}

function posixJoin(base: string, rel: string): string {
  return path.posix.normalize(path.posix.join(base, rel));
}

export function splitRule(raw: string): { tool: string; spec: string | undefined } | undefined {
  const text = raw.trim();
  const open = text.indexOf('(');
  if (open === -1) return text.length > 0 && !/\s/.test(text) ? { tool: text, spec: undefined } : undefined;
  if (!text.endsWith(')')) return undefined;
  const tool = text.slice(0, open).trim();
  if (tool.length === 0) return undefined;
  return { tool, spec: text.slice(open + 1, -1) };
}

const TOOL_NAME = /^[A-Za-z0-9_]+$/;
const MCP_RULE = /^mcp__[A-Za-z0-9_-]+(?:__[A-Za-z0-9_-]+)?$/;
const TOOL_GLOB = /^[A-Za-z0-9_*]+$/;
const MCP_GLOB = /^mcp__[A-Za-z0-9_*-]*$/;
const ANCHORED_MCP_GLOB = /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_*-]*$/;

/**
 * Whether a rule string has a form the Claude Code docs define
 * (https://code.claude.com/docs/en/permissions, "Permission rule syntax" and
 * "Tool name wildcards"): `Tool`, `Tool(specifier)` with a `[A-Za-z0-9_]+`
 * tool name, the MCP forms without a specifier, or a tool-name glob without a
 * specifier. Anything else would be silently ignored, so callers refuse it.
 */
export function isValidRuleSyntax(raw: string): boolean {
  const split = splitRule(raw);
  if (!split) return false;
  const { tool, spec } = split;
  if (tool.includes('*')) return spec === undefined && (tool.startsWith('mcp__') ? MCP_GLOB.test(tool) : TOOL_GLOB.test(tool));
  // MCP rules take no specifier (Claude Code skips `mcp__…(…)` in settings files).
  if (tool.startsWith('mcp__')) return spec === undefined && MCP_RULE.test(tool);
  return TOOL_NAME.test(tool);
}

export function compilePathSpec(spec: string, kind: RuleKind, anchors: RuleAnchors): RuleMatcher | undefined {
  const s = spec.trim();
  if (/[\\[\]]/.test(s)) return kind === 'allow' ? { type: 'never' } : undefined;
  if (s === '' || s === '*' || s === '**') return { type: 'all' };
  if (s.startsWith('!')) return { type: 'never' };
  const cwd = toPosixPath(anchors.cwd);
  let anchor: string;
  let rest: string;
  let anchored: boolean;
  if (s.startsWith('//')) {
    anchor = '/';
    rest = s.slice(2);
    anchored = true;
  } else if (s === '~' || s.startsWith('~/')) {
    anchor = toPosixPath(anchors.home);
    rest = s === '~' ? '**' : s.slice(2);
    anchored = true;
  } else if (s.startsWith('/')) {
    anchor = toPosixPath(anchors.sourceDir);
    rest = s.slice(1);
    anchored = true;
  } else if (s.startsWith('./')) {
    anchor = cwd;
    rest = s.slice(2);
    anchored = true;
  } else {
    anchor = cwd;
    rest = s;
    anchored = false;
  }
  let dirOnly = false;
  while (rest.endsWith('/') && rest.length > 1) {
    rest = rest.slice(0, -1);
    dirOnly = true;
  }
  if (rest === '' || rest === '**') return { type: 'path', patterns: [{ anchor, pattern: '**' }] };
  const segments = rest.split('/').filter((seg) => seg !== '');
  let anyDepth = false;
  if (!anchored) {
    if (segments.length === 1) {
      // A bare name matches at any depth (gitignore).
      anyDepth = true;
    } else if (segments.length === 2 && segments[1] === '**' && kind !== 'allow') {
      anyDepth = true;
    }
  }
  const body = segments.join('/');
  const patterns: PathPattern[] = [{ anchor, pattern: anyDepth ? `**/${body}` : body }];
  if (dirOnly) patterns.push({ anchor, pattern: `${anyDepth ? `**/${body}` : body}/**` });
  return { type: 'path', patterns };
}

export function parseRule(raw: string, kind: RuleKind, source: RuleSourceName, anchors: RuleAnchors): Rule | undefined {
  const split = splitRule(raw);
  if (!split) return undefined;
  const { tool, spec } = split;
  const base = { raw, kind, source, tool };
  if (spec === undefined) {
    // Allow rules take tool-name globs only after a literal `mcp__<server>__`;
    // an unanchored allow glob (`*`, `B*`, `mcp__*`) is documented as skipped.
    if (kind === 'allow' && tool.includes('*') && !ANCHORED_MCP_GLOB.test(tool)) return { ...base, matcher: { type: 'never' } };
    return { ...base, matcher: { type: 'all' } };
  }
  if (tool.includes('*') || tool.startsWith('mcp__')) return { ...base, matcher: { type: 'never' } };
  const param = /^\s*([A-Za-z_-][A-Za-z0-9_-]*)\s*:(.*)$/s.exec(spec);
  if (param?.[1] !== undefined && param[2] !== undefined && PARAM_FIELDS[tool]?.has(param[1])) {
    // Parameter rules only restrict; as allow rules Claude ignores them.
    if (kind === 'allow') return { ...base, matcher: { type: 'never' } };
    const matcher: RuleMatcher = { type: 'param', name: param[1], value: param[2].trim(), ...(tool === 'Bash' ? { bashSpec: spec } : {}) };
    return { ...base, matcher };
  }
  switch (tool) {
    case 'Bash':
      return { ...base, matcher: spec.trim() === '*' || spec.trim() === '' ? { type: 'all' } : { type: 'bash', spec } };
    case 'Read':
    case 'Edit': {
      const matcher = compilePathSpec(spec, kind, anchors);
      return matcher === undefined ? undefined : { ...base, matcher };
    }
    case 'Write':
    case 'Grep':
    case 'Glob':
      // Claude accepts these with a path but does not match calls against it; `Tool(*)` is the whole tool.
      return { ...base, matcher: spec.trim() === '*' ? { type: 'all' } : { type: 'never' } };
    default:
      return { ...base, matcher: { type: 'never' } };
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const bashCache = new Map<string, RegExp | string>();

export function matchesBashSpec(spec: string, command: string): boolean {
  let compiled = bashCache.get(spec);
  if (compiled === undefined) {
    let s = spec;
    if (s.endsWith(':*')) s = `${s.slice(0, -2)} *`;
    const stars = s.split('*').length - 1;
    if (stars === 0) {
      compiled = s;
    } else {
      const parts = s.split('*').map(escapeRegExp);
      let src = parts.join('[\\s\\S]*');
      if (stars === 1 && s.endsWith(' *')) {
        src = `${escapeRegExp(s.slice(0, -2))}(?: [\\s\\S]*)?`;
      }
      compiled = new RegExp(`^${src}$`);
    }
    bashCache.set(spec, compiled);
  }
  const text = command.trim();
  return typeof compiled === 'string' ? text === compiled.trim() : compiled.test(text);
}

export function bashSpecMayMatchDynamic(spec: string, staticPrefix: string): boolean {
  let s = spec;
  if (s.endsWith(':*')) s = `${s.slice(0, -2)} *`;
  const literalHead = s.split('*')[0] ?? '';
  const prefix = staticPrefix.trim();
  if (prefix === '') return true;
  return literalHead.startsWith(prefix) || prefix.startsWith(literalHead.trimEnd());
}

export function matchesToolName(pattern: string, tool: string): boolean {
  if (!pattern.includes('*')) return pattern === tool;
  const re = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`);
  return re.test(tool);
}

export function matchesPath(absPath: string, patterns: readonly PathPattern[], caseInsensitive = DEFAULT_CASE_INSENSITIVE): boolean {
  for (const { anchor, pattern } of patterns) {
    const rel = relativeInside(absPath, anchor, caseInsensitive);
    if (rel === undefined) continue;
    if (rel === '') {
      if (pattern === '**') return true;
      continue;
    }
    const segments = rel.split('/');
    for (let n = segments.length; n >= 1; n--) {
      const candidate = segments.slice(0, n).join('/');
      if (matchesPathPattern(candidate, pattern, caseInsensitive)) return true;
    }
  }
  return false;
}

export function resolveCommandPath(p: string, cwd: string, home: string): string {
  if (p === '~') return toPosixPath(home);
  if (p.startsWith('~/')) return posixJoin(toPosixPath(home), p.slice(2));
  const posix = toPosixPath(p);
  if (posix.startsWith('/')) return path.posix.normalize(posix);
  return posixJoin(toPosixPath(cwd), posix);
}

function relativeInside(child: string, parent: string, caseInsensitive: boolean): string | undefined {
  const fold = (p: string): string => {
    const n = path.posix.normalize(toPosixPath(p));
    return caseInsensitive ? n.toLowerCase() : n;
  };
  const rel = path.posix.relative(fold(parent), fold(child));
  return rel === '..' || rel.startsWith('../') || path.posix.isAbsolute(rel) ? undefined : rel;
}

export function isInsidePath(child: string, parent: string, caseInsensitive = DEFAULT_CASE_INSENSITIVE): boolean {
  return relativeInside(child, parent, caseInsensitive) !== undefined;
}

/** Splits a CLI tool list (`"Bash(git log:*) Read,Edit"`) into rules, respecting parentheses. */
export function splitToolList(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === ',' || /\s/.test(ch))) {
      if (current.trim() !== '') out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim() !== '') out.push(current.trim());
  return out;
}

export function matchesParamValue(pattern: string, value: unknown): boolean {
  if (value === undefined || value === null) return false;
  const text = typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined;
  if (text === undefined) return false;
  if (!pattern.includes('*')) return text === pattern;
  return new RegExp(`^${pattern.split('*').map(escapeRegExp).join('[\\s\\S]*')}$`).test(text);
}
