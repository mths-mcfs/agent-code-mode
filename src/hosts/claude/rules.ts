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

/** Where a rule came from; decides what `/path` anchors to. */
export type RuleSourceName = 'managed' | 'cli' | 'flag-settings' | 'local' | 'project' | 'user';

export type RuleKind = 'deny' | 'ask' | 'allow';

/** Native tool names this project maps to. */
export type NativeToolName = 'Bash' | 'Read' | 'Write' | 'Edit' | 'Grep' | 'Glob';

export interface PathPattern {
  /** Absolute POSIX-form directory the pattern is relative to. */
  readonly anchor: string;
  /** Pattern relative to the anchor, `/`-separated, never empty. */
  readonly pattern: string;
}

export type RuleMatcher =
  /** Matches every call of the tool. */
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
  /** Tool-name pattern (`Bash`, `Read`, `*`, `B*`); matched as a whole-name glob. */
  readonly tool: string;
  readonly matcher: RuleMatcher;
}

export interface RuleAnchors {
  /** Session cwd: anchor of `./x` and bare patterns. */
  readonly cwd: string;
  /** Anchor of `/x` patterns for this source. */
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

/** Converts a native path to POSIX form for matching: `C:\x` → `/c/x`. */
export function toPosixPath(p: string): string {
  const slashed = p.replace(/\\/g, '/');
  const drive = /^([A-Za-z]):(\/|$)/.exec(slashed);
  if (drive?.[1]) return `/${drive[1].toLowerCase()}${slashed.slice(2) || '/'}`;
  return slashed;
}

function posixJoin(base: string, rel: string): string {
  return path.posix.normalize(path.posix.join(base, rel));
}

/**
 * Splits `Tool(spec)`. Returns undefined when the text is not a rule.
 * Parentheses inside the specifier are literal.
 */
export function splitRule(raw: string): { tool: string; spec: string | undefined } | undefined {
  const text = raw.trim();
  const open = text.indexOf('(');
  if (open === -1) return text.length > 0 && !/\s/.test(text) ? { tool: text, spec: undefined } : undefined;
  if (!text.endsWith(')')) return undefined;
  const tool = text.slice(0, open).trim();
  if (tool.length === 0) return undefined;
  return { tool, spec: text.slice(open + 1, -1) };
}

/** Compiles a gitignore-style Read/Edit specifier into absolute patterns. */
export function compilePathSpec(spec: string, kind: RuleKind, anchors: RuleAnchors): RuleMatcher {
  const s = spec.trim();
  if (s === '' || s === '*' || s === '**') return { type: 'all' };
  // `!negation` carves paths out of earlier rules in Claude. We never carve
  // anything out (strictness): the negation itself matches nothing.
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
  rest = rest.replace(/\\/g, '/');
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
      // `src/**` as a deny/ask rule matches a `src` directory at any depth.
      anyDepth = true;
    }
  }
  const body = segments.join('/');
  const patterns: PathPattern[] = [{ anchor, pattern: anyDepth ? `**/${body}` : body }];
  if (dirOnly) patterns.push({ anchor, pattern: `${anyDepth ? `**/${body}` : body}/**` });
  return { type: 'path', patterns };
}

/** Parses one rule string. Unknown tools still parse (they match by name). */
export function parseRule(raw: string, kind: RuleKind, source: RuleSourceName, anchors: RuleAnchors): Rule | undefined {
  const split = splitRule(raw);
  if (!split) return undefined;
  const { tool, spec } = split;
  const base = { raw, kind, source, tool };
  if (spec === undefined) return { ...base, matcher: { type: 'all' } };
  // Tool-name globs are only meaningful without a specifier, and MCP rules never concern our calls.
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
    case 'Edit':
      return { ...base, matcher: compilePathSpec(spec, kind, anchors) };
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

/** Whether a Bash rule specifier matches one (sub)command text. */
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
        // A trailing ` *` that is the only wildcard also matches the bare command.
        src = `${escapeRegExp(s.slice(0, -2))}(?: [\\s\\S]*)?`;
      }
      compiled = new RegExp(`^${src}$`);
    }
    bashCache.set(spec, compiled);
  }
  const text = command.trim();
  return typeof compiled === 'string' ? text === compiled.trim() : compiled.test(text);
}

/**
 * Whether a deny/ask Bash spec could match a command whose words after
 * `staticPrefix` are only known at run time.
 */
export function bashSpecMayMatchDynamic(spec: string, staticPrefix: string): boolean {
  let s = spec;
  if (s.endsWith(':*')) s = `${s.slice(0, -2)} *`;
  const literalHead = s.split('*')[0] ?? '';
  const prefix = staticPrefix.trim();
  if (prefix === '') return true;
  // The rule's literal head either extends the static prefix or is extended by it.
  return literalHead.startsWith(prefix) || prefix.startsWith(literalHead.trimEnd());
}

/** Whether a tool-name pattern (`Bash`, `*`, `B*`) names `tool`. */
export function matchesToolName(pattern: string, tool: string): boolean {
  if (!pattern.includes('*')) return pattern === tool;
  const re = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`);
  return re.test(tool);
}

/**
 * Whether an absolute path matches a compiled path pattern. Like gitignore,
 * a pattern that matches a directory also matches everything under it.
 */
export function matchesPath(absPath: string, patterns: readonly PathPattern[], caseInsensitive = DEFAULT_CASE_INSENSITIVE): boolean {
  const target = path.posix.normalize(toPosixPath(absPath));
  for (const { anchor, pattern } of patterns) {
    const rel = path.posix.relative(anchor, target);
    if (rel.startsWith('..') || path.posix.isAbsolute(rel)) continue;
    if (rel === '') {
      if (pattern === '**') return true;
      continue;
    }
    // Test the path and each ancestor inside the anchor.
    const segments = rel.split('/');
    for (let n = segments.length; n >= 1; n--) {
      const candidate = segments.slice(0, n).join('/');
      if (matchesPathPattern(candidate, pattern, caseInsensitive)) return true;
    }
  }
  return false;
}

/** Resolves a path written in a command against a directory, in POSIX form. `~` expands to `home`. */
export function resolveCommandPath(p: string, cwd: string, home: string): string {
  if (p === '~') return toPosixPath(home);
  if (p.startsWith('~/')) return posixJoin(toPosixPath(home), p.slice(2));
  const posix = toPosixPath(p);
  if (posix.startsWith('/')) return path.posix.normalize(posix);
  return posixJoin(toPosixPath(cwd), posix);
}

/** Whether `child` is `parent` or inside it (POSIX forms). */
export function isInsidePath(child: string, parent: string, caseInsensitive = DEFAULT_CASE_INSENSITIVE): boolean {
  const c = path.posix.normalize(toPosixPath(child));
  const p = path.posix.normalize(toPosixPath(parent));
  const a = caseInsensitive ? c.toLowerCase() : c;
  const b = caseInsensitive ? p.toLowerCase() : p;
  const rel = path.posix.relative(b, a);
  return rel === '' || (!rel.startsWith('..') && !path.posix.isAbsolute(rel));
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

/** Matches a `*` wildcard value against a scalar (`Tool(param:value)` rules). */
export function matchesParamValue(pattern: string, value: unknown): boolean {
  if (value === undefined || value === null) return false;
  const text = typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined;
  if (text === undefined) return false;
  if (!pattern.includes('*')) return text === pattern;
  return new RegExp(`^${pattern.split('*').map(escapeRegExp).join('[\\s\\S]*')}$`).test(text);
}
