import { lstat, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { errorMessage } from '../../core/errors.js';
import { findMatchingPattern } from '../../core/paths.js';
import { stateDirPath } from '../../core/state-dir.js';
import type {
  BashContainment,
  Decision,
  HostAdapter,
  PolicyLoadError,
  PolicySnapshot,
  PreparedCall,
  SessionContext,
  ToolResult,
} from '../../core/types.js';
import { BashAnalyzer, type BashAnalysis } from './bash.js';
import {
  NATIVE_TOOL,
  combineOutcomes,
  mapUpdatedInput,
  invalidMatcher,
  matcherMatches,
  nativeCall,
  nativeResponse,
  runHook,
  unsupportedReason,
  type CompiledHook,
  type HookOutcome,
  type NativeCall,
} from './hooks.js';
import { conservativeFlags, parseClaudeFlags, readParentClaudeProcess, type ClaudeCliFlags, type ParentArgsReader } from './parent-args.js';
import {
  bashSpecMayMatchDynamic,
  isInsidePath,
  isValidRuleSyntax,
  matchesBashSpec,
  matchesParamValue,
  matchesPath,
  matchesToolName,
  parseRule,
  resolveCommandPath,
  toPosixPath,
  type NativeToolName,
  type PathPattern,
  type Rule,
  type RuleKind,
} from './rules.js';
import { claudeConfigDir, firstSetting, loadSettings, managedSettingsDir, type LoadedSettings, type SettingsDoc } from './settings.js';
import type { HookMatcherEntry } from './settings.js';

/**
 * Claude Code host adapter.
 *
 * Static check (`checkStatic`, no I/O): permission rules from every settings
 * source, deny → ask → allow, first match wins, then the permission mode for
 * calls no rule decides. Hooks (`authorize`): the PreToolUse hooks that match
 * the native tool name, run in parallel with the JSON Claude Code would send.
 */

/** Claude permission modes. Unknown values are treated as `default`. */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'auto' | 'bypassPermissions';

const MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan', 'dontAsk', 'auto', 'bypassPermissions'];

function toMode(value: string | undefined): PermissionMode | undefined {
  if (value === 'manual') return 'default';
  return MODES.find((m) => m === value);
}

export interface ClaudePolicy {
  readonly projectRoot: string;
  readonly cwd: string;
  readonly home: string;
  readonly configDir: string;
  readonly mode: PermissionMode;
  readonly rules: { readonly deny: readonly Rule[]; readonly ask: readonly Rule[]; readonly allow: readonly Rule[] };
  /** Project root, MCP roots and additional directories: reads there need no approval. */
  readonly workingDirs: readonly string[];
  /** Working directories for the block-outside settings: directories only repository settings add do not count. */
  readonly blockDirs: readonly string[];
  /** On Windows no trusted record carries the live permission mode: only calls every mode allows may run. */
  readonly modeUnknown: boolean;
  readonly preHooks: readonly CompiledHook[];
  readonly postHooks: readonly CompiledHook[];
  /** Env added for every hook. */
  readonly hookEnv: Readonly<Record<string, string>>;
  /** Set when a sandbox restriction cannot be expressed as bash containment: every bash call is denied. */
  readonly bashUnsupported: string | undefined;
  /** `blockReadsOutsideWorkingDirectories` / `blockWritesOutsideWorkingDirectories` from any source. */
  readonly blockReadsOutside: boolean;
  readonly blockWritesOutside: boolean;
  /**
   * Whether a Read deny rule covers a real absolute path. The tool runtime
   * must drop such files from grep and glob results: a recursive search
   * otherwise returns what `read` would refuse.
   */
  readonly isReadDenied: (absPath: string) => boolean;
}

export interface ClaudeHostAdapterOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly home?: string;
  /** Managed settings directory; `null` disables managed settings (tests). Defaults to the platform path. */
  readonly managedDir?: string | null;
  /** Server state directory (protected). Defaults to `stateDirPath()`. */
  readonly stateDir?: string;
  /** Reads the parent Claude process argv. Defaults to the platform reader. */
  readonly readParent?: ParentArgsReader;
  readonly platform?: NodeJS.Platform;
}

const NO_FLAGS: ClaudeCliFlags = { settings: [], allowedTools: [], disallowedTools: [], addDirs: [] };

/** Which native tools a rule's tool name governs. */
function governs(rule: Rule, tool: NativeToolName): boolean {
  if (matchesToolName(rule.tool, tool)) return true;
  if (rule.tool === 'Read') return tool === 'Grep' || tool === 'Glob' || (rule.kind === 'deny' && (tool === 'Write' || tool === 'Edit'));
  if (rule.tool === 'Edit') return tool === 'Write';
  return false;
}

/** Paths a file call touches: the path as given in args (may be the requested path) and the real path of the effect. */
function callPaths(prepared: PreparedCall): string[] {
  switch (prepared.tool) {
    case 'read':
    case 'write':
    case 'edit':
      return [...new Set([prepared.args.path, prepared.effect.absPath])];
    case 'grep':
    case 'glob':
      return [...new Set([...(prepared.args.path === undefined ? [] : [prepared.args.path]), prepared.effect.absRoot])];
    case 'bash':
      return [];
  }
}

type Verdict = 'match' | 'maybe' | 'no';

interface CallView {
  readonly prepared: PreparedCall;
  readonly native: NativeCall;
  readonly analysis: BashAnalysis | undefined;
  /** Resolved file targets of a bash command; undefined path = only known at run time. */
  readonly bashFiles: readonly { readonly access: 'read' | 'write'; readonly path: string | undefined }[];
}

function pathRuleVerdict(patterns: readonly PathPattern[], paths: readonly string[], kind: RuleKind): Verdict {
  if (paths.length === 0) return 'no';
  const hits = paths.map((p) => matchesPath(p, patterns));
  // Deny/ask: either the requested or the real path. Allow: both.
  return (kind === 'allow' ? hits.every(Boolean) : hits.some(Boolean)) ? 'match' : 'no';
}

/** Evaluates one deny/ask rule against a call. */
function restrictVerdict(rule: Rule, view: CallView): Verdict {
  const { prepared, native } = view;
  const m = rule.matcher;
  if (m.type === 'never') return 'no';
  if (prepared.tool === 'bash' && view.analysis) {
    // File targets of the command (redirects, tee, cat ...) against Read/Edit rules.
    let fileVerdict: Verdict = 'no';
    const targetTool = (access: 'read' | 'write'): NativeToolName => (access === 'read' ? 'Read' : 'Edit');
    for (const target of view.bashFiles) {
      const asTool = targetTool(target.access);
      if (!(matchesToolName(rule.tool, asTool) || (rule.tool === 'Read' && rule.kind === 'deny' && asTool === 'Edit'))) continue;
      if (m.type === 'all') return 'match';
      if (m.type !== 'path') continue;
      if (target.path === undefined) fileVerdict = 'maybe';
      else if (matchesPath(target.path, m.patterns)) return 'match';
    }
    if (!governs(rule, 'Bash')) return fileVerdict;
    if (m.type === 'all') return 'match';
    if (m.type === 'param') {
      if (matchesParamValue(m.value, native.toolInput[m.name])) return 'match';
      if (m.bashSpec === undefined) return fileVerdict;
    }
    const spec = m.type === 'bash' ? m.spec : m.type === 'param' ? m.bashSpec : undefined;
    if (spec === undefined) return fileVerdict;
    let verdict: Verdict = fileVerdict;
    for (const cmd of view.analysis.commands) {
      if (cmd.denyForms.some((form) => matchesBashSpec(spec, form))) return 'match';
      if (cmd.dynamic && cmd.staticPrefixes.some((prefix) => bashSpecMayMatchDynamic(spec, prefix))) verdict = 'maybe';
    }
    return verdict;
  }
  if (!governs(rule, native.toolName)) return 'no';
  switch (m.type) {
    case 'all':
      return 'match';
    case 'param':
      return matchesParamValue(m.value, native.toolInput[m.name]) ? 'match' : 'no';
    case 'path':
      return pathRuleVerdict(m.patterns, callPaths(prepared), rule.kind);
    case 'bash':
      return 'no';
  }
}

function insideWorkingDirs(paths: readonly string[], dirs: readonly string[]): boolean {
  return paths.length > 0 && paths.every((p) => dirs.some((d) => isInsidePath(p, d)));
}

/** Whether allow rules approve the call. */
function allowedByRule(view: CallView, rules: readonly Rule[], policy: ClaudePolicy): boolean {
  const { prepared, native } = view;
  // Auto mode drops shell allow rules broader than one exact command.
  const broadShell = (r: Rule): boolean => governs(r, 'Bash') && (r.matcher.type === 'all' || (r.matcher.type === 'bash' && r.matcher.spec.includes('*')));
  const applicable = rules.filter((r) => r.matcher.type !== 'never' && !(policy.mode === 'auto' && broadShell(r)));
  if (prepared.tool === 'bash') {
    const analysis = view.analysis;
    const blanket = applicable.some((r) => governs(r, 'Bash') && r.matcher.type === 'all');
    // Files the command names must be inside the working directories, whatever approves the command.
    const filesInside = view.bashFiles.every((f) => f.path !== undefined && policy.workingDirs.some((d) => isInsidePath(f.path ?? '', d)));
    if (!analysis || analysis.uncertain.length > 0 || analysis.commands.length === 0) return blanket && filesInside;
    if (blanket && view.bashFiles.length === 0) return true;
    // Every subcommand must be approved; files it names must be inside the working directories.
    const everyCommand = analysis.commands.every((cmd) => {
      const form = cmd.allowForm;
      if (form === undefined) return false;
      // An exec wrapper or effectful `find` needs an exact rule, not a wildcard one.
      return applicable.some((r) => governs(r, 'Bash') && (r.matcher.type === 'all' || (r.matcher.type === 'bash' && !(cmd.exactOnly && r.matcher.spec.includes('*')) && matchesBashSpec(r.matcher.spec, form))));
    });
    return everyCommand && filesInside;
  }
  const paths = callPaths(prepared);
  return applicable.some((r) => {
    if (!governs(r, native.toolName) || r.kind !== 'allow') return false;
    if (r.matcher.type === 'all') return true;
    if (r.matcher.type === 'path') return pathRuleVerdict(r.matcher.patterns, paths, 'allow') === 'match';
    return false;
  });
}

/** What the permission mode does with a call that no rule decided. */
function modeDecision(view: CallView, policy: ClaudePolicy): Decision {
  const { prepared } = view;
  const mode = policy.mode;
  const tool = NATIVE_TOOL[prepared.tool];
  const isRead = prepared.tool === 'read' || prepared.tool === 'grep' || prepared.tool === 'glob';
  const isEdit = prepared.tool === 'write' || prepared.tool === 'edit';
  const inside = isRead || isEdit ? insideWorkingDirs(callPaths(prepared), policy.workingDirs) : false;
  if (mode === 'bypassPermissions') return { kind: 'allow' };
  if (mode === 'auto') {
    // No classifier verdict reaches this server: only step 2 (reads and edits inside the working directories) applies.
    if ((isRead || isEdit) && inside) return { kind: 'allow' };
    return {
      kind: 'ask',
      reason: `auto mode: no classifier verdict covers this script; ${tool}${isRead || isEdit ? ' outside the working directories' : ''} needs approval`,
    };
  }
  if (isRead) {
    if (inside) return { kind: 'allow' };
    if (mode === 'dontAsk') return { kind: 'deny', source: 'rule', reason: `dontAsk mode: ${tool} outside the working directories is not pre-approved by an allow rule` };
    return { kind: 'ask', reason: `${tool} outside the working directories needs approval in ${mode} mode` };
  }
  if (mode === 'plan') return { kind: 'deny', source: 'rule', reason: `plan mode does not allow ${tool}` };
  if (mode === 'dontAsk') return { kind: 'deny', source: 'rule', reason: `dontAsk mode: ${tool} is not pre-approved by an allow rule` };
  if (isEdit && mode === 'acceptEdits' && inside) return { kind: 'allow' };
  return { kind: 'ask', reason: `${tool} needs approval in ${mode} mode` };
}

/** Limits no rule or mode lifts: protected host paths and the block-outside settings; an unknown bash target asks. */
function hardLimit(view: CallView, policy: ClaudePolicy, protectedPaths: readonly string[]): Decision | undefined {
  const { prepared } = view;
  const outside = (p: string): boolean => !policy.blockDirs.some((d) => isInsidePath(p, d));
  const blocked = (access: 'read' | 'write'): boolean => (access === 'read' ? policy.blockReadsOutside : policy.blockWritesOutside);
  const deny = (reason: string): Decision => ({ kind: 'deny', source: 'rule', reason });
  if (prepared.tool !== 'bash') {
    const access = prepared.tool === 'write' || prepared.tool === 'edit' ? 'write' : 'read';
    return blocked(access) && callPaths(prepared).some(outside) ? deny(`${NATIVE_TOOL[prepared.tool]} outside the working directories is blocked by settings`) : undefined;
  }
  for (const f of view.bashFiles) {
    if (f.path === undefined) {
      if (f.access === 'write' || blocked('read')) return { kind: 'ask', reason: `the command ${f.access === 'write' ? 'writes' : 'reads'} a file only known at run time, which cannot be checked statically` };
      continue;
    }
    if (f.access === 'write' && findMatchingPattern(nativePath(f.path), protectedPaths) !== undefined) return deny(`the command writes ${f.path}, a protected host policy path`);
    if (blocked(f.access) && outside(f.path)) return deny(`the command ${f.access === 'write' ? 'writes' : 'reads'} ${f.path} outside the working directories, which settings block`);
  }
  return undefined;
}

const TOP_LEVEL = /^\/[^/]+$/;

/**
 * A recognized `rm`/`rmdir` removal of a critical path (filesystem root, a
 * top-level directory, home, the working directory or a parent of it, a bare
 * `*` glob under a working directory, a recursive removal of a target only
 * known at run time). No allow rule, mode or hook approves one
 * (https://code.claude.com/docs/en/permission-modes, "Critical paths").
 */
function criticalRemoval(view: CallView, policy: ClaudePolicy): string | undefined {
  const analysis = view.analysis;
  if (!analysis || view.prepared.tool !== 'bash') return undefined;
  const cwd = view.prepared.effect.cwd;
  const anchors = [cwd, policy.projectRoot];
  const isCritical = (p: string, glob: boolean): boolean => {
    const posix = toPosixPath(p);
    if (posix === '/' || TOP_LEVEL.test(posix)) return true;
    if (isInsidePath(toPosixPath(policy.home), posix) && isInsidePath(posix, toPosixPath(policy.home))) return true;
    if (anchors.some((a) => isInsidePath(a, posix))) return true; // the working directory or one of its parents
    return glob && policy.workingDirs.some((d) => isInsidePath(d, posix));
  };
  for (const removal of analysis.removals) {
    for (const target of removal.targets) {
      if (target.value === undefined) {
        if (removal.recursive || target.glob) return `\`rm ${target.raw}\` removes a target only known at run time`;
        continue;
      }
      let value = target.value;
      let glob = false;
      if (target.glob) {
        const segments = value.split('/');
        const stars = segments.filter((seg) => /[*?[]/.test(seg));
        if (stars.length > 1) return `\`rm ${target.raw}\` reaches directories that cannot be known before it runs`;
        const at = segments.findIndex((seg) => seg === '*');
        if (at === -1) continue;
        value = segments.slice(0, at).join('/') || (value.startsWith('/') ? '/' : '.');
        glob = true;
      }
      const relative = !(value.startsWith('/') || value.startsWith('~') || path.isAbsolute(value));
      if (relative && analysis.changesDirectory) {
        if (glob || value === '.' || value === '..' || value.startsWith('../')) return `\`rm ${target.raw}\` after \`cd\` may remove a working directory`;
        continue;
      }
      if (isCritical(resolveCommandPath(value, cwd, policy.home), glob)) return `\`rm ${target.raw}\` removes a critical path`;
    }
  }
  return undefined;
}

/** A POSIX-form path (`/c/x`) in the platform's own form (`c:/x` on Windows). */
function nativePath(p: string): string {
  return process.platform === 'win32' ? p.replace(/^\/([A-Za-z])(\/|$)/, '$1:/') : p;
}

function errnoCode(err: unknown): unknown {
  return err !== null && typeof err === 'object' && 'code' in err ? err.code : undefined;
}

/** Resolves links (symlinks, junctions) of a command's file target: its deepest existing ancestor, plus the missing rest; undefined when unknown. */
async function realTarget(p: string): Promise<string | undefined> {
  const missing: string[] = [];
  for (let dir = p; ; ) {
    try {
      return path.posix.join(toPosixPath(await realpath(nativePath(dir))), ...missing);
    } catch (err) {
      // Only an absent name is a missing suffix: a dangling link (also ENOENT for `realpath`) or another error is unknown.
      if (errnoCode(err) !== 'ENOENT' || (await lstat(nativePath(dir)).then(() => true, (e: unknown) => errnoCode(e) !== 'ENOENT'))) return undefined;
      const parent = path.posix.dirname(dir);
      if (parent === dir) return undefined;
      missing.unshift(path.posix.basename(dir));
      dir = parent;
    }
  }
}

/** The canonical location of a protected pattern written through a link (`~/.claude/**` under a linked home), if different. */
async function canonicalPattern(pattern: string): Promise<string | undefined> {
  const { head, rest } = literalHead(toPosixPath(pattern));
  if (head === '') return undefined;
  const real = await realTarget(head);
  return real === undefined || real === head ? undefined : path.join(nativePath(real), rest);
}

function describe(rule: Rule): string {
  return `${rule.kind} rule ${JSON.stringify(rule.raw)} from ${rule.source} settings`;
}

function compileHooks(entries: readonly HookMatcherEntry[] | undefined, origin: string, env: Readonly<Record<string, string>>, platform: NodeJS.Platform, seen: Set<string>, http: { readonly urls: readonly string[][]; readonly envVars: readonly string[][] }, blocked?: string): CompiledHook[] {
  const out: CompiledHook[] = [];
  for (const entry of entries ?? []) {
    for (const configured of entry.hooks) {
      // The same handler defined in several settings files runs once.
      const key = JSON.stringify([entry.matcher ?? '', configured, env]);
      if (seen.has(key)) continue;
      seen.add(key);
      let unsupported = blocked ?? invalidMatcher(entry.matcher) ?? unsupportedReason(configured, platform);
      let handler = configured;
      if (configured.type === 'http') {
        // The allowlists are matched against the URL fetch will request (`https://h` names `https://h/` too), and fetch gets that URL.
        const raw = configured.url ?? '';
        const href = URL.canParse(raw) ? new URL(raw).href : undefined;
        const forms = href === `${raw}/` ? [href, raw] : [href ?? ''];
        if (unsupported === undefined && href === undefined) unsupported = 'http hook url cannot be parsed';
        else if (unsupported === undefined && !http.urls.every((list) => list.some((pattern) => forms.some((form) => matchesParamValue(pattern, form))))) unsupported = 'http hook url is not allowed by allowedHttpHookUrls';
        // A header may interpolate only variables every applicable list allows.
        handler = { ...configured, ...(href === undefined ? {} : { url: href }), allowedEnvVars: (configured.allowedEnvVars ?? []).filter((name) => http.envVars.every((list) => list.includes(name))) };
      }
      out.push({ handler, matcher: entry.matcher, origin, env, unsupported });
    }
  }
  return out;
}

/** Literal leading directory of a glob pattern (before the first segment with a glob character). */
function literalHead(pattern: string): { head: string; rest: string } {
  const segments = pattern.split('/');
  const i = segments.findIndex((s) => /[*?[]/.test(s));
  const cut = i === -1 ? Math.max(0, segments.length - 1) : i;
  return { head: segments.slice(0, cut).join('/'), rest: segments.slice(cut).join('/') };
}

/** Adds the real location of rules written through a symlinked directory (`//etc/**` → `/private/etc/**`). */
async function withRealAnchors(rule: Rule): Promise<Rule> {
  if (rule.matcher.type !== 'path' || rule.kind === 'allow') return rule;
  const extra: PathPattern[] = [];
  for (const p of rule.matcher.patterns) {
    if (p.pattern.startsWith('**')) continue;
    const { head, rest } = literalHead(p.pattern);
    const dir = path.posix.join(p.anchor, head);
    try {
      const real = toPosixPath(await realpath(dir));
      if (real !== dir && rest !== '') extra.push({ anchor: real, pattern: rest });
      else if (real !== dir) extra.push({ anchor: path.posix.dirname(real), pattern: path.posix.basename(real) });
    } catch {
      // Missing directory: nothing to alias.
    }
  }
  return extra.length === 0 ? rule : { ...rule, matcher: { type: 'path', patterns: [...rule.matcher.patterns, ...extra] } };
}

function resolveDir(p: string, base: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return path.resolve(base, p);
}

export class ClaudeHostAdapter implements HostAdapter<ClaudePolicy> {
  readonly host = 'claude' as const;
  readonly #opts: ClaudeHostAdapterOptions;

  constructor(opts: ClaudeHostAdapterOptions = {}) {
    this.#opts = opts;
  }

  async loadPolicy(ctx: SessionContext): Promise<PolicySnapshot<ClaudePolicy> | PolicyLoadError> {
    try {
      return await this.#load(ctx);
    } catch (err) {
      return { error: errorMessage(err) };
    }
  }

  async #load(ctx: SessionContext): Promise<PolicySnapshot<ClaudePolicy>> {
    const env = this.#opts.env ?? process.env;
    const home = this.#opts.home ?? os.homedir();
    const platform = this.#opts.platform ?? process.platform;
    const configDir = claudeConfigDir(env, home);
    const projectRoot = ctx.roots[0] ?? ctx.cwd;
    const stateDir = this.#opts.stateDir ?? stateDirPath(env, home);
    const managedDir = this.#opts.managedDir === null ? undefined : (this.#opts.managedDir ?? managedSettingsDir(platform));
    const parent = await (this.#opts.readParent ?? readParentClaudeProcess)();
    // A joined command line (macOS `ps`) is never run through the exact-argv parser.
    const flags = parent === undefined ? NO_FLAGS : parent.lossy === true ? conservativeFlags(parent.argv) : parseClaudeFlags(parent.argv);
    const parentCwd = parent?.cwd !== undefined && path.isAbsolute(parent.cwd) ? parent.cwd : undefined;
    const liveCwd = ctx.sources['cwd'] === 'ctx-file' ? ctx.cwd : undefined;
    // Project and local settings and their rules anchor at the primary directory: Claude's process directory, else the
    // companion record's cwd, else the first MCP root. Hooks run in the session's cwd. CLAUDE_PROJECT_DIR stays the startup root.
    const primaryDir = parentCwd ?? liveCwd ?? projectRoot;
    const sessionCwd = liveCwd ?? parentCwd ?? ctx.cwd;
    const settings: LoadedSettings = await loadSettings({ projectRoot: primaryDir, home, configDir, managedDir, env, flags, parentCwd: parent?.cwd });
    const docs = settings.docs;

    // Permission rules.
    const managedOnly = firstSetting(docs.filter((d) => d.source === 'managed'), (s) => s.allowManagedPermissionRulesOnly) === true;
    const ruleDocs = managedOnly ? docs.filter((d) => d.source === 'managed') : docs;
    const holdsCapability = (doc: SettingsDoc): boolean => (doc.source === 'project' || doc.source === 'local') && !settings.projectTrusted;
    const rules: { deny: Rule[]; ask: Rule[]; allow: Rule[] } = { deny: [], ask: [], allow: [] };
    // A malformed rule would match nothing; refuse the whole policy instead of failing open.
    for (const doc of docs) {
      for (const kind of ['deny', 'ask', 'allow'] as const) {
        for (const raw of doc.data.permissions?.[kind] ?? []) {
          if (!isValidRuleSyntax(raw)) {
            throw new Error(`${kind} rule ${JSON.stringify(raw)} in ${doc.file ?? `${doc.source} settings`} is not a valid \`Tool\` or \`Tool(specifier)\` rule`);
          }
        }
      }
    }
    for (const doc of ruleDocs) {
      const anchors = { cwd: ctx.cwd, sourceDir: doc.anchorDir, home };
      for (const kind of ['deny', 'ask', 'allow'] as const) {
        if (kind === 'allow' && holdsCapability(doc)) continue;
        for (const raw of doc.data.permissions?.[kind] ?? []) {
          const rule = parseRule(raw, kind, doc.source, anchors);
          if (!rule) throw new Error(`${kind} rule ${JSON.stringify(raw)} in ${doc.file ?? doc.source} cannot be parsed`);
          rules[kind].push(await withRealAnchors(rule));
        }
      }
    }

    // Working directories. The block-outside settings ignore directories only repository settings add.
    const startDirs = [projectRoot, primaryDir, ctx.cwd, sessionCwd, ...ctx.roots];
    const workingDirs = new Set<string>(startDirs);
    const blockDirs = new Set<string>(startDirs);
    for (const doc of docs) {
      if (holdsCapability(doc)) continue;
      for (const dir of doc.data.permissions?.additionalDirectories ?? []) {
        const resolved = resolveDir(dir, primaryDir, home);
        workingDirs.add(resolved);
        if (doc.source !== 'project' && doc.source !== 'local') blockDirs.add(resolved);
      }
    }

    // Permission mode: the live mode from the companion hook, else the CLI flag, else the highest settings default.
    // Project and local settings cannot start auto or bypassPermissions, nor acceptEdits before the workspace is trusted:
    // a rejected one starts Manual (default) mode, it does not fall through to a lower source.
    const fromCtx = ctx.sources['permissionMode'] !== undefined && ctx.sources['permissionMode'] !== 'default' ? toMode(ctx.permissionMode) : undefined;
    const defaultDoc = docs.find((d) => toMode(d.data.permissions?.defaultMode) !== undefined);
    const settingsMode = toMode(defaultDoc?.data.permissions?.defaultMode);
    const rejected = (defaultDoc?.source === 'project' || defaultDoc?.source === 'local') && (settingsMode === 'auto' || settingsMode === 'bypassPermissions' || (settingsMode === 'acceptEdits' && !settings.projectTrusted));
    let mode: PermissionMode = fromCtx ?? toMode(flags.permissionMode) ?? (rejected ? 'default' : settingsMode) ?? 'default';
    if (mode === 'bypassPermissions' && firstSetting(docs, (s) => s.permissions?.disableBypassPermissionsMode) === 'disable') mode = 'default';
    if (mode === 'auto' && firstSetting(docs, (s) => s.permissions?.disableAutoMode) === 'disable') mode = 'default';

    // Hooks, under the controls the loader resolved.
    const controls = settings.hookControls;
    // A handler defined in several sources runs once per event, never across events.
    const seenPre = new Set<string>();
    const seenPost = new Set<string>();
    const pre: CompiledHook[] = [];
    const post: CompiledHook[] = [];
    // `allowedHttpHookUrls` / `httpHookAllowedEnvVars` of every source that sets them: each list must allow.
    const http = {
      urls: docs.flatMap((d) => (d.data.allowedHttpHookUrls === undefined ? [] : [d.data.allowedHttpHookUrls])),
      envVars: docs.flatMap((d) => (d.data.httpHookAllowedEnvVars === undefined ? [] : [d.data.httpHookAllowedEnvVars])),
    };
    for (const doc of docs) {
      if (controls.allOff) break;
      if (doc.source !== 'managed' && controls.managedOnly) continue;
      const origin = `${doc.source} settings`;
      pre.push(...compileHooks(doc.data.hooks?.PreToolUse, origin, {}, platform, seenPre, http));
      post.push(...compileHooks(doc.data.hooks?.PostToolUse, origin, {}, platform, seenPost, http));
    }
    // The loader already applied the hook controls to plugins; an unverifiable plugin source makes its hooks deny.
    const unverified = controls.commandPluginsBlocked ? 'the plugin installation source cannot be verified while command-sourced plugins are disabled' : undefined;
    for (const plugin of settings.plugins) {
      const env = { CLAUDE_PLUGIN_ROOT: plugin.root };
      pre.push(...compileHooks(plugin.hooks.PreToolUse, `plugin ${plugin.plugin}`, env, platform, seenPre, http, unverified));
      post.push(...compileHooks(plugin.hooks.PostToolUse, `plugin ${plugin.plugin}`, env, platform, seenPost, http, unverified));
    }

    // Bash containment: Claude's sandbox when enabled.
    let bashContainment: BashContainment = { mode: 'none' };
    let bashUnsupported: string | undefined;
    const blockReadsOutside = docs.some((d) => d.data.permissions?.blockReadsOutsideWorkingDirectories === true);
    if (firstSetting(docs, (s) => s.sandbox?.enabled) === true) {
      const roots = new Set<string>([projectRoot, ...workingDirs]);
      // Managed filesystem settings lock the key: lower sources cannot turn the filesystem sandbox off.
      const managedFs = docs.some((d) => d.source === 'managed' && d.data.sandbox?.filesystem !== undefined);
      const fsDisabled = firstSetting(
        docs.filter((d) => d.source === 'managed' || (!managedFs && (d.source === 'user' || d.source === 'flag-settings'))),
        (s) => s.sandbox?.filesystem?.disabled,
      );
      // Containment has writable roots only: no read or write exclusion the sandbox would enforce can be expressed.
      // Claude adds Read and Edit deny rules to denyRead/denyWrite, and the read block narrows sandbox reads.
      const projected = fsDisabled !== true && (blockReadsOutside || rules.deny.some((r) => (governs(r, 'Read') || governs(r, 'Edit')) && (r.matcher.type === 'path' || r.matcher.type === 'all')));
      if (projected || docs.some((d) => (d.data.sandbox?.filesystem?.denyWrite?.length ?? 0) > 0 || (d.data.sandbox?.filesystem?.denyRead?.length ?? 0) > 0)) {
        bashUnsupported = 'sandbox filesystem exclusions (denyRead/denyWrite, Read and Edit deny rules, blockReadsOutsideWorkingDirectories) cannot be enforced by bash containment';
      }
      // Sandbox paths: `//` or `/` absolute, `~/` home, others relative to the settings file's anchor (project root or
      // config directory); a relative path from a source without a documented anchor adds no root.
      for (const doc of docs) {
        const anchored = doc.source === 'project' || doc.source === 'local' || doc.source === 'user';
        for (const entry of doc.data.sandbox?.filesystem?.allowWrite ?? []) {
          const e = entry.startsWith('//') ? entry.slice(1) : entry;
          if (anchored || path.isAbsolute(e) || e === '~' || e.startsWith('~/')) roots.add(path.resolve(resolveDir(e, doc.anchorDir, home)));
        }
      }
      bashContainment = {
        mode: 'sandbox',
        readOnly: false,
        writableRoots: fsDisabled === true ? [path.parse(projectRoot).root] : [...roots],
        // Claude's sandbox filters network by domain through a proxy; a boolean
        // cannot express an allowlist, so network stays off (strict).
        network: false,
      };
    }

    const lexicalProtected = [
      ...new Set([
        ...[projectRoot, primaryDir, ctx.cwd, sessionCwd].flatMap((root) => [
          path.join(root, '.claude', 'settings*.json'),
          path.join(root, '.claude', 'hooks', '**'),
          path.join(root, '.claude', 'agents', '**'),
          path.join(root, '.mcp.json'),
        ]),
        path.join(configDir, '**'),
        path.join(home, '.claude', '**'),
        path.join(home, '.claude.json'),
        ...(managedDir === undefined ? [] : [path.join(managedDir, '**')]),
        path.join(stateDir, '**'),
        ...docs.flatMap((d) => ((d.source === 'flag-settings' || d.source === 'local') && d.file !== undefined ? [d.file] : [])),
      ]),
    ];
    // A write that resolves through a link is checked at its canonical location: protect that location too.
    const canonical = await Promise.all(lexicalProtected.map(canonicalPattern));
    const protectedPaths = [...new Set([...lexicalProtected, ...canonical.filter((p) => p !== undefined)])];

    return {
      host: 'claude',
      bashContainment,
      protectedPaths,
      payload: {
        projectRoot,
        cwd: sessionCwd,
        home,
        configDir,
        mode,
        rules,
        workingDirs: [...workingDirs],
        blockDirs: [...blockDirs],
        modeUnknown: platform === 'win32' && fromCtx === undefined,
        preHooks: pre,
        postHooks: post,
        hookEnv: { CLAUDE_PROJECT_DIR: projectRoot },
        bashUnsupported,
        blockReadsOutside,
        blockWritesOutside: docs.some((d) => d.data.permissions?.blockWritesOutsideWorkingDirectories === true),
        isReadDenied: (absPath: string): boolean =>
          rules.deny.some((r) => governs(r, 'Read') && (r.matcher.type === 'all' || (r.matcher.type === 'path' && matchesPath(absPath, r.matcher.patterns)))),
      },
    };
  }

  #view(prepared: PreparedCall, policy: ClaudePolicy): CallView {
    const native = nativeCall(prepared);
    if (prepared.tool !== 'bash') return { prepared, native, analysis: undefined, bashFiles: [] };
    const analysis = BashAnalyzer.analyze(prepared.effect.command);
    const bashFiles = analysis.files.map((f) => {
      if (f.path === undefined) return { access: f.access, path: undefined };
      const relative = !(f.path.startsWith('/') || f.path.startsWith('~') || path.isAbsolute(f.path));
      // After a `cd`, a relative target cannot be resolved statically.
      if (relative && analysis.changesDirectory) return { access: f.access, path: undefined };
      return { access: f.access, path: resolveCommandPath(f.path, prepared.effect.cwd, policy.home) };
    });
    return { prepared, native, analysis, bashFiles };
  }

  /** Deny and ask rules. Undefined when none decides. */
  #restrictions(view: CallView, policy: ClaudePolicy): Decision | undefined {
    const askOrDeny = (reason: string): Decision =>
      policy.mode === 'dontAsk' ? { kind: 'deny', source: 'rule', reason: `dontAsk mode denies what would ask: ${reason}` } : { kind: 'ask', reason };
    for (const rule of policy.rules.deny) {
      const v = restrictVerdict(rule, view);
      if (v === 'match') return { kind: 'deny', source: 'rule', reason: `denied by ${describe(rule)}` };
    }
    // A deny rule that may match once run-time values are known: cannot be settled statically.
    for (const rule of policy.rules.deny) {
      if (restrictVerdict(rule, view) === 'maybe') return askOrDeny(`${describe(rule)} may match parts of the command that are only known at run time`);
    }
    for (const rule of policy.rules.ask) {
      const v = restrictVerdict(rule, view);
      if (v !== 'no') return askOrDeny(`${describe(rule)} matches`);
    }
    return undefined;
  }

  checkStatic(prepared: PreparedCall, _ctx: SessionContext, snapshot: PolicySnapshot<ClaudePolicy>): Decision {
    return this.#decide(this.#view(prepared, snapshot.payload), snapshot);
  }

  #decide(view: CallView, snapshot: PolicySnapshot<ClaudePolicy>): Decision {
    const decision = this.#decideInMode(view, snapshot);
    if (!snapshot.payload.modeUnknown || decision.kind === 'deny') return decision;
    // Unknown live mode (Windows): only what every mode allows runs, which is a read that needs no prompt.
    const readOnly = view.prepared.tool === 'read' || view.prepared.tool === 'grep' || view.prepared.tool === 'glob';
    if (decision.kind === 'allow' && readOnly) return decision;
    return {
      kind: 'deny',
      source: 'unsupported-config',
      reason: `the live Claude Code permission mode is unknown on Windows (no trusted session record), so ${NATIVE_TOOL[view.prepared.tool]} cannot be authorized`,
    };
  }

  #decideInMode(view: CallView, snapshot: PolicySnapshot<ClaudePolicy>): Decision {
    const policy = snapshot.payload;
    const askOrDeny = (reason: string): Decision =>
      policy.mode === 'dontAsk' ? { kind: 'deny', source: 'rule', reason: `dontAsk mode denies what would ask: ${reason}` } : { kind: 'ask', reason };
    if (view.prepared.tool === 'bash' && policy.bashUnsupported !== undefined) return { kind: 'deny', source: 'unsupported-config', reason: policy.bashUnsupported };
    const restricted = this.#restrictions(view, policy);
    if (restricted) return restricted;
    if (view.analysis && view.analysis.uncertain.length > 0) {
      return askOrDeny(`the command cannot be checked statically (${view.analysis.uncertain.join('; ')})`);
    }
    const limit = hardLimit(view, policy, snapshot.protectedPaths);
    if (limit) return limit.kind === 'ask' ? askOrDeny(limit.reason) : limit;
    const critical = criticalRemoval(view, policy);
    if (critical !== undefined) return askOrDeny(`${critical}; no rule or mode approves it`);
    // Plan mode allows no change before the plan is approved, whatever the allow rules say.
    const readOnly = view.prepared.tool === 'read' || view.prepared.tool === 'grep' || view.prepared.tool === 'glob';
    if (policy.mode === 'plan' && !readOnly) return modeDecision(view, policy);
    if (allowedByRule(view, policy.rules.allow, policy)) return { kind: 'allow' };
    return modeDecision(view, policy);
  }

  /**
   * Re-decides a bash command on its file targets with links resolved (I/O, so not in `checkStatic`):
   * `cat link` where `link -> .env` is denied, a target resolving outside the working dirs loses its allow.
   */
  async #realFiles(prepared: PreparedCall, snapshot: PolicySnapshot<ClaudePolicy>): Promise<Decision | undefined> {
    if (prepared.tool !== 'bash') return undefined;
    const view = this.#view(prepared, snapshot.payload);
    const real = await Promise.all(view.bashFiles.map(async (f) => ({ access: f.access, path: f.path === undefined ? undefined : await realTarget(f.path) })));
    if (real.every((f, i) => f.path === view.bashFiles[i]?.path)) return undefined;
    const again = this.#decide({ ...view, bashFiles: real }, snapshot);
    return again.kind === 'allow' ? undefined : again;
  }

  #select(hooks: readonly CompiledHook[], view: CallView, policy: ClaudePolicy): CompiledHook[] {
    return hooks.filter((hook) => matcherMatches(hook.matcher, view.native.toolName) && this.#ifMatches(hook, view, policy));
  }

  /** The `if` filter: a hook is skipped only when the call certainly does not match its rule. */
  #ifMatches(hook: CompiledHook, view: CallView, policy: ClaudePolicy): boolean {
    const condition = hook.handler.if;
    if (condition === undefined) return true;
    const rule = parseRule(condition, 'allow', 'project', { cwd: policy.cwd, sourceDir: policy.projectRoot, home: policy.home });
    if (!rule || rule.matcher.type === 'never') return true;
    if (!matchesToolName(rule.tool, view.native.toolName) && !governs(rule, view.native.toolName)) return false;
    const m = rule.matcher;
    if (m.type === 'all') return true;
    if (m.type === 'bash') {
      const a = view.analysis;
      if (!a || a.uncertain.length > 0) return true;
      // Documented: a pattern naming more than the command (`Bash(git push *)`) runs the hook on any `$()`, backticks or `$VAR`.
      const specific = (m.spec.split('*')[0] ?? '').trim().split(/\s+/).length > 1;
      return a.commands.some(
        (cmd) => cmd.denyForms.some((f) => matchesBashSpec(m.spec, f)) || (cmd.dynamic && (specific || cmd.staticPrefixes.some((prefix) => bashSpecMayMatchDynamic(m.spec, prefix)))),
      );
    }
    if (m.type === 'path') return pathRuleVerdict(m.patterns, callPaths(view.prepared), 'deny') === 'match';
    if (m.type === 'param') return matchesParamValue(m.value, view.native.toolInput[m.name]);
    return true;
  }

  #input(view: CallView, ctx: SessionContext, policy: ClaudePolicy, event: 'PreToolUse' | 'PostToolUse'): Record<string, unknown> {
    const { prepared, native } = view;
    return {
      session_id: ctx.sessionId ?? null,
      transcript_path: ctx.transcriptPath ?? null,
      // For bash the command runs in the effect's cwd, so that is what the hook is told.
      cwd: prepared.tool === 'bash' ? prepared.effect.cwd : policy.cwd,
      permission_mode: policy.mode,
      hook_event_name: event,
      tool_name: native.toolName,
      tool_input: native.toolInput,
      tool_use_id: `${ctx.toolUseId ?? 'unknown'}/${prepared.id}`,
      ...(ctx.agentId === undefined ? {} : { agent_id: ctx.agentId }),
      ...(ctx.agentType === undefined ? {} : { agent_type: ctx.agentType }),
    };
  }

  async authorize(prepared: PreparedCall, ctx: SessionContext, snapshot: PolicySnapshot<ClaudePolicy>, signal: AbortSignal): Promise<Decision> {
    const policy = snapshot.payload;
    const realFiles = await this.#realFiles(prepared, snapshot);
    if (realFiles) return realFiles;
    const view = this.#view(prepared, policy);
    const hooks = this.#select(policy.preHooks, view, policy);
    const unsupported = hooks.find((h) => h.unsupported !== undefined);
    if (unsupported) {
      return { kind: 'deny', source: 'unsupported-config', reason: `${unsupported.origin}: ${unsupported.unsupported ?? 'unsupported hook'}` };
    }
    if (hooks.length === 0) return { kind: 'allow' };
    const input = this.#input(view, ctx, policy, 'PreToolUse');
    const opts = { event: 'PreToolUse' as const, input, cwd: policy.cwd, env: policy.hookEnv, signal };
    const blocking: Promise<HookOutcome>[] = [];
    for (const hook of hooks) {
      if (hook.handler.type === 'command' && (hook.handler.async === true || hook.handler.asyncRewake === true)) {
        // Background hooks cannot block natively either; run them and ignore the result.
        void runHook(hook, opts);
        continue;
      }
      blocking.push(runHook(hook, opts));
    }
    const combined = combineOutcomes(await Promise.all(blocking));
    switch (combined.kind) {
      case 'deny':
        return combined;
      case 'ask':
        return { kind: 'ask', reason: combined.reason };
      case 'none':
      case 'allow': {
        if (combined.updatedInput === undefined) return { kind: 'allow', ...(combined.reason === undefined ? {} : { reason: combined.reason }) };
        const mapped = mapUpdatedInput(prepared, combined.updatedInput);
        if ('error' in mapped) return { kind: 'deny', source: 'hook', reason: mapped.error };
        if (prepared.tool === 'bash' && 'command' in mapped.args) {
          // The dispatcher re-checks the rewrite statically; the symlink check needs I/O, so it runs here.
          const command = mapped.args.command;
          const rewritten: PreparedCall = { ...prepared, args: { ...prepared.args, command }, effect: { ...prepared.effect, command } };
          const again = await this.#realFiles(rewritten, snapshot);
          if (again) return again.kind === 'deny' ? again : { kind: 'ask', reason: `hook rewrite: ${again.reason}` };
        }
        return { kind: 'allow', updatedArgs: mapped.args, ...(combined.reason === undefined ? {} : { reason: combined.reason }) };
      }
    }
  }

  async postToolUse(prepared: PreparedCall, result: ToolResult, ctx: SessionContext, snapshot: PolicySnapshot<ClaudePolicy>, signal: AbortSignal): Promise<void> {
    const policy = snapshot.payload;
    const view = this.#view(prepared, policy);
    const hooks = this.#select(policy.postHooks, view, policy);
    if (hooks.length === 0) return;
    const input = { ...this.#input(view, ctx, policy, 'PostToolUse'), tool_response: nativeResponse(prepared, result) };
    const opts = { event: 'PostToolUse' as const, input, cwd: policy.cwd, env: policy.hookEnv, signal };
    const notes: string[] = [];
    const outcomes = await Promise.all(
      hooks.map(async (hook) => {
        if (hook.unsupported !== undefined) return { hook, outcome: { kind: 'failure', source: 'hook-error', reason: hook.unsupported } satisfies HookOutcome };
        if (hook.handler.type === 'command' && (hook.handler.async === true || hook.handler.asyncRewake === true)) {
          void runHook(hook, opts);
          return { hook, outcome: { kind: 'none' } satisfies HookOutcome };
        }
        return { hook, outcome: await runHook(hook, opts) };
      }),
    );
    for (const { hook, outcome } of outcomes) {
      if (outcome.kind === 'deny') notes.push(`${hook.origin} PostToolUse hook blocked after the call ran (it was not undone): ${outcome.reason}`);
      else if (outcome.kind === 'failure') notes.push(`${hook.origin} PostToolUse hook failed: ${outcome.reason}`);
    }
    if (notes.length > 0) throw new Error(notes.join('; '));
  }
}
