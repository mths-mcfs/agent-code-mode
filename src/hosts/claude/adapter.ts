import { lstat, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { errorMessage } from '../../core/errors.js';
import { stateDirPath } from '../../core/state-dir.js';
import type {
  BashContainment,
  Decision,
  HostAdapter,
  PolicyLoadError,
  PolicySnapshot,
  PreparedCall,
  PreparedCallOf,
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
import { parentReaderFor, parseClaudeFlags, type ClaudeCliFlags, type ParentArgsReader } from './parent-args.js';
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
  /** `sandbox.autoAllowBashIfSandboxed` (default true): a contained command needs no allow rule. */
  readonly autoAllowSandboxedBash: boolean;
  /** Claude's sandbox isolates the filesystem (not `sandbox.filesystem.disabled`), so containment limits writes. */
  readonly sandboxLimitsWrites: boolean;
  /** `blockReadsOutsideWorkingDirectories` / `blockWritesOutsideWorkingDirectories` from any source. */
  readonly blockReadsOutside: boolean;
  readonly blockWritesOutside: boolean;
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

const NO_FLAGS: ClaudeCliFlags = { settings: [], allowedTools: [], disallowedTools: [], addDirs: [], agents: [] };

function governs(rule: Rule, tool: NativeToolName): boolean {
  if (matchesToolName(rule.tool, tool)) return true;
  if (rule.tool === 'Read') return tool === 'Grep' || tool === 'Glob' || (rule.kind === 'deny' && (tool === 'Write' || tool === 'Edit'));
  if (rule.tool === 'Edit') return tool === 'Write';
  return false;
}

function callPaths(prepared: PreparedCall, cwd: string, home: string): string[] {
  const written = prepared.requestedPath === undefined ? [] : [resolveWritten(prepared.requestedPath, cwd, home)];
  switch (prepared.tool) {
    case 'read':
    case 'write':
    case 'edit':
      return [...new Set([...written, prepared.args.path, prepared.effect.absPath])];
    case 'grep':
    case 'glob':
      return [...new Set([...written, ...(prepared.args.path === undefined ? [] : [prepared.args.path]), prepared.effect.absRoot])];
    case 'bash':
      return [];
  }
}

function resolveWritten(p: string, cwd: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
  return path.resolve(cwd, p);
}

type Verdict = 'match' | 'maybe' | 'no';

interface CallView {
  readonly prepared: PreparedCall;
  readonly native: NativeCall;
  readonly paths: readonly string[];
  readonly analysis: BashAnalysis | undefined;
}

function pathRuleVerdict(patterns: readonly PathPattern[], paths: readonly string[], kind: RuleKind): Verdict {
  if (paths.length === 0) return 'no';
  const hits = paths.map((p) => matchesPath(p, patterns));
  return (kind === 'allow' ? hits.every(Boolean) : hits.some(Boolean)) ? 'match' : 'no';
}

function restrictVerdict(rule: Rule, view: CallView): Verdict {
  const { prepared, native } = view;
  const m = rule.matcher;
  if (m.type === 'never') return 'no';
  if (prepared.tool === 'bash' && view.analysis) {
    if (!governs(rule, 'Bash')) return 'no';
    if (m.type === 'all') return 'match';
    if (m.type === 'param') {
      if (matchesParamValue(m.value, native.toolInput[m.name])) return 'match';
      if (m.bashSpec === undefined) return 'no';
    }
    const spec = m.type === 'bash' ? m.spec : m.type === 'param' ? m.bashSpec : undefined;
    if (spec === undefined) return 'no';
    let verdict: Verdict = 'no';
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
      return pathRuleVerdict(m.patterns, view.paths, rule.kind);
    case 'bash':
      return 'no';
  }
}

function insideWorkingDirs(paths: readonly string[], dirs: readonly string[]): boolean {
  return paths.length > 0 && paths.every((p) => dirs.some((d) => isInsidePath(p, d)));
}

function allowedByRule(view: CallView, rules: readonly Rule[]): boolean {
  const { native, paths } = view;
  return rules.some((r) => {
    if (!governs(r, native.toolName) || r.kind !== 'allow') return false;
    if (r.matcher.type === 'all') return true;
    if (r.matcher.type === 'path') return pathRuleVerdict(r.matcher.patterns, paths, 'allow') === 'match';
    return false;
  });
}

function modeDecision(view: CallView, policy: ClaudePolicy): Decision {
  const { prepared } = view;
  const mode = policy.mode;
  const tool = NATIVE_TOOL[prepared.tool];
  const isRead = prepared.tool === 'read' || prepared.tool === 'grep' || prepared.tool === 'glob';
  const isEdit = prepared.tool === 'write' || prepared.tool === 'edit';
  const inside = isRead || isEdit ? insideWorkingDirs(view.paths, policy.workingDirs) : false;
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

function blockedOutside(view: CallView, policy: ClaudePolicy): Decision | undefined {
  const { prepared } = view;
  if (prepared.tool === 'bash') return undefined;
  const blocked = prepared.tool === 'write' || prepared.tool === 'edit' ? policy.blockWritesOutside : policy.blockReadsOutside;
  if (!blocked || !view.paths.some((p) => !policy.blockDirs.some((d) => isInsidePath(p, d)))) return undefined;
  return { kind: 'deny', source: 'rule', reason: `${NATIVE_TOOL[prepared.tool]} outside the working directories is blocked by settings` };
}

function bashApproval(prepared: PreparedCallOf<'bash'>, policy: ClaudePolicy, containment: BashContainment): Decision {
  const contained = containment.mode === 'sandbox' && policy.sandboxLimitsWrites;
  if (policy.blockReadsOutside) return { kind: 'ask', reason: 'blockReadsOutsideWorkingDirectories is set and the files a shell command reads cannot be established' };
  if (policy.blockWritesOutside && !contained) return { kind: 'ask', reason: "blockWritesOutsideWorkingDirectories is set and the files a shell command writes cannot be established outside Claude's sandbox" };
  const command = prepared.effect.command.trim();
  const exact = policy.rules.allow.some((r) => r.tool === 'Bash' && r.matcher.type === 'bash' && !r.matcher.spec.includes('*') && r.matcher.spec.trim() === command);
  if (exact) return { kind: 'allow' };
  if (contained && (policy.autoAllowSandboxedBash || policy.mode === 'bypassPermissions')) return { kind: 'allow' };
  return {
    kind: 'ask',
    reason: contained
      ? 'autoAllowBashIfSandboxed is off and no exact Bash allow rule names this command'
      : "Bash runs only when an exact allow rule names the command or inside Claude's sandbox, and neither applies",
  };
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
    if (anchors.some((a) => isInsidePath(a, posix))) return true;
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

function nativePath(p: string): string {
  return process.platform === 'win32' ? p.replace(/^\/([A-Za-z])(\/|$)/, '$1:/') : p;
}

function errnoCode(err: unknown): unknown {
  return err !== null && typeof err === 'object' && 'code' in err ? err.code : undefined;
}

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

async function canonicalPatterns(pattern: string): Promise<string[]> {
  const posix = toPosixPath(pattern);
  const { head, rest } = literalHead(posix);
  const out: string[] = [];
  const real = head === '' ? undefined : await realTarget(head);
  if (real !== undefined && real !== head) out.push(path.join(nativePath(real), rest));
  if (!/[*?[]/.test(posix)) {
    const file = await realTarget(posix);
    if (file !== undefined && file !== posix) out.push(nativePath(file));
  }
  return out;
}

function describe(rule: Rule): string {
  return `${rule.kind} rule ${JSON.stringify(rule.raw)} from ${rule.source} settings`;
}

function foldHost(url: string): string {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/?#]*)(.*)$/s.exec(url);
  if (!m) return url;
  return `${(m[1] ?? '').toLowerCase()}${(m[2] ?? '').toLowerCase().replace(/\.(?=(:\d*)?$)/, '')}${m[3] ?? ''}`;
}

function compileHooks(entries: readonly HookMatcherEntry[] | undefined, origin: string, env: Readonly<Record<string, string>>, platform: NodeJS.Platform, seen: Set<string>, http: { readonly urls: readonly string[][]; readonly envVars: readonly string[][] }): CompiledHook[] {
  const out: CompiledHook[] = [];
  for (const entry of entries ?? []) {
    for (const configured of entry.hooks) {
      // The same handler defined in several settings files runs once.
      const key = JSON.stringify([entry.matcher ?? '', configured, env]);
      if (seen.has(key)) continue;
      seen.add(key);
      let unsupported = invalidMatcher(entry.matcher) ?? unsupportedReason(configured, platform);
      let handler = configured;
      if (configured.type === 'http') {
        // The allowlists are matched against the URL fetch will request (`https://h` names `https://h/` too), and fetch gets that URL.
        const raw = configured.url ?? '';
        const href = URL.canParse(raw) ? new URL(raw).href : undefined;
        const forms = href === `${raw}/` ? [href, raw] : [href ?? ''];
        if (unsupported === undefined && href === undefined) unsupported = 'http hook url cannot be parsed';
        else if (unsupported === undefined && !http.urls.every((list) => list.some((pattern) => forms.some((form) => matchesParamValue(foldHost(pattern), foldHost(form)))))) unsupported = 'http hook url is not allowed by allowedHttpHookUrls';
        // A header may interpolate only variables every applicable list allows.
        handler = { ...configured, ...(href === undefined ? {} : { url: href }), allowedEnvVars: (configured.allowedEnvVars ?? []).filter((name) => http.envVars.every((list) => list.includes(name))) };
      }
      out.push({ handler, matcher: entry.matcher, origin, env, unsupported });
    }
  }
  return out;
}

function literalHead(pattern: string): { head: string; rest: string } {
  const segments = pattern.split('/');
  const i = segments.findIndex((s) => /[*?[]/.test(s));
  const cut = i === -1 ? Math.max(0, segments.length - 1) : i;
  return { head: segments.slice(0, cut).join('/'), rest: segments.slice(cut).join('/') };
}

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
    }
  }
  return extra.length === 0 ? rule : { ...rule, matcher: { type: 'path', patterns: [...rule.matcher.patterns, ...extra] } };
}

const AgentsFlagSchema = z.record(z.string(), z.looseObject({ hooks: z.unknown().optional() }));

function definesAgentHooks(value: string): boolean {
  try {
    const parsed = AgentsFlagSchema.safeParse(JSON.parse(value));
    return !parsed.success || Object.values(parsed.data).some((agent) => agent.hooks !== undefined);
  } catch {
    return true;
  }
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
    const parent = await (this.#opts.readParent ?? parentReaderFor(platform))();
    const flags = parent === undefined ? NO_FLAGS : parseClaudeFlags(parent.argv);
    const parentCwd = parent?.cwd !== undefined && path.isAbsolute(parent.cwd) ? parent.cwd : undefined;
    const liveCwd = ctx.sources['cwd'] === 'ctx-file' ? ctx.cwd : undefined;
    // Project and local settings and their rules anchor at the primary directory: Claude's process directory, else the
    // companion record's cwd, else the first MCP root. Hooks run in the session's cwd. CLAUDE_PROJECT_DIR stays the startup root.
    const primaryDir = liveCwd ?? parentCwd ?? projectRoot;
    const sessionCwd = liveCwd ?? parentCwd ?? ctx.cwd;
    const extraDirs = flags.addDirs.map((dir) => resolveDir(dir, parentCwd ?? projectRoot, home));
    // The verified active directory first; the launch directory's settings keep applying after a `cd`.
    const settings: LoadedSettings = await loadSettings({ projectRoots: [primaryDir, parentCwd ?? projectRoot], home, configDir, managedDir, env, flags, parentCwd: parent?.cwd, extraDirs });
    if (settings.componentHooks !== undefined) {
      throw new Error(`${settings.componentHooks} defines hooks in its frontmatter; skill, subagent and command hooks cannot be applied to calls inside a script`);
    }
    for (const agents of flags.agents) {
      if (definesAgentHooks(agents)) throw new Error('--agents defines subagent hooks or cannot be read; subagent hooks cannot be applied to calls inside a script');
    }
    const docs = settings.docs;

    const managedOnly = firstSetting(docs.filter((d) => d.source === 'managed'), (s) => s.allowManagedPermissionRulesOnly) === true;
    const ruleDocs = managedOnly ? docs.filter((d) => d.source === 'managed') : docs;
    const holdsCapability = (doc: SettingsDoc): boolean => (doc.source === 'project' || doc.source === 'local') && !settings.projectTrusted;
    const rules: { deny: Rule[]; ask: Rule[]; allow: Rule[] } = { deny: [], ask: [], allow: [] };
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
      const anchors = { cwd: sessionCwd, sourceDir: doc.anchorDir, home };
      for (const kind of ['deny', 'ask', 'allow'] as const) {
        if (kind === 'allow' && holdsCapability(doc)) continue;
        for (const raw of doc.data.permissions?.[kind] ?? []) {
          const rule = parseRule(raw, kind, doc.source, anchors);
          if (!rule) throw new Error(`${kind} rule ${JSON.stringify(raw)} in ${doc.file ?? doc.source} cannot be parsed`);
          rules[kind].push(await withRealAnchors(rule));
        }
      }
    }

    const startDirs = [projectRoot, primaryDir, ctx.cwd, sessionCwd, ...ctx.roots];
    const workingDirs = new Set<string>(startDirs);
    const blockDirs = new Set<string>(startDirs);
    const additionalDirs: string[] = [];
    for (const doc of docs) {
      if (holdsCapability(doc)) continue;
      for (const dir of doc.data.permissions?.additionalDirectories ?? []) {
        const resolved = resolveDir(dir, primaryDir, home);
        workingDirs.add(resolved);
        additionalDirs.push(resolved);
        if (doc.source !== 'project' && doc.source !== 'local') blockDirs.add(resolved);
      }
    }
    const blockWritesOutside = docs.some((d) => d.data.permissions?.blockWritesOutsideWorkingDirectories === true);

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
    const modeUnknown = platform === 'win32' && fromCtx === undefined;
    if (modeUnknown) mode = 'default';

    const controls = settings.hookControls;
    const seenPre = new Set<string>();
    const seenPost = new Set<string>();
    const pre: CompiledHook[] = [];
    const post: CompiledHook[] = [];
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
    for (const plugin of settings.plugins) {
      const env = { CLAUDE_PLUGIN_ROOT: plugin.root };
      pre.push(...compileHooks(plugin.hooks.PreToolUse, `plugin ${plugin.plugin}`, env, platform, seenPre, http));
      post.push(...compileHooks(plugin.hooks.PostToolUse, `plugin ${plugin.plugin}`, env, platform, seenPost, http));
    }

    let bashContainment: BashContainment = { mode: 'none' };
    let bashUnsupported: string | undefined;
    let sandboxLimitsWrites = false;
    const blockReadsOutside = docs.some((d) => d.data.permissions?.blockReadsOutsideWorkingDirectories === true);
    if (firstSetting(docs, (s) => s.sandbox?.enabled) === true) {
      // Writes stay inside the directories Claude approved: its launch and session directories, the additional
      // directories of eligible sources (not the MCP roots), and the sandbox's own write grants.
      const roots = new Set<string>([primaryDir, sessionCwd, ...additionalDirs]);
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
          if (!(anchored || path.isAbsolute(e) || e === '~' || e.startsWith('~/'))) continue;
          const root = path.resolve(resolveDir(e, doc.anchorDir, home));
          if (!blockWritesOutside || [...blockDirs].some((d) => isInsidePath(root, d))) roots.add(root);
        }
      }
      sandboxLimitsWrites = fsDisabled !== true;
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
        ...docs.flatMap((d) => (d.file === undefined ? [] : [d.file])),
      ]),
    ];
    const canonical = await Promise.all(lexicalProtected.map(canonicalPatterns));
    const protectedPaths = [...new Set([...lexicalProtected, ...canonical.flat()])];

    const readRestrictions = [...rules.deny, ...rules.ask].filter((r) => governs(r, 'Read'));
    const isReadRestricted = (absPath: string): boolean =>
      readRestrictions.some((r) => r.matcher.type === 'all' || (r.matcher.type === 'path' && matchesPath(absPath, r.matcher.patterns)));

    return {
      host: 'claude',
      bashContainment,
      protectedPaths,
      additionalRoots: [...new Set(additionalDirs)],
      readFilter: (realAbsPath: string): boolean => !isReadRestricted(realAbsPath),
      payload: {
        projectRoot,
        cwd: sessionCwd,
        home,
        configDir,
        mode,
        rules,
        workingDirs: [...workingDirs],
        blockDirs: [...blockDirs],
        modeUnknown,
        preHooks: pre,
        postHooks: post,
        hookEnv: { CLAUDE_PROJECT_DIR: projectRoot },
        bashUnsupported,
        autoAllowSandboxedBash: firstSetting(docs, (s) => s.sandbox?.autoAllowBashIfSandboxed) !== false,
        sandboxLimitsWrites,
        blockReadsOutside,
        blockWritesOutside,
      },
    };
  }

  #view(prepared: PreparedCall, ctx: SessionContext, policy: ClaudePolicy): CallView {
    const native = nativeCall(prepared);
    const paths = callPaths(prepared, ctx.cwd, policy.home);
    return { prepared, native, paths, analysis: prepared.tool === 'bash' ? BashAnalyzer.analyze(prepared.effect.command) : undefined };
  }

  #restrictions(view: CallView, policy: ClaudePolicy): Decision | undefined {
    const askOrDeny = (reason: string): Decision =>
      policy.mode === 'dontAsk' ? { kind: 'deny', source: 'rule', reason: `dontAsk mode denies what would ask: ${reason}` } : { kind: 'ask', reason };
    for (const rule of policy.rules.deny) {
      const v = restrictVerdict(rule, view);
      if (v === 'match') return { kind: 'deny', source: 'rule', reason: `denied by ${describe(rule)}` };
    }
    for (const rule of policy.rules.deny) {
      if (restrictVerdict(rule, view) === 'maybe') return askOrDeny(`${describe(rule)} may match parts of the command that are only known at run time`);
    }
    for (const rule of policy.rules.ask) {
      const v = restrictVerdict(rule, view);
      if (v !== 'no') return askOrDeny(`${describe(rule)} matches`);
    }
    return undefined;
  }

  checkStatic(prepared: PreparedCall, ctx: SessionContext, snapshot: PolicySnapshot<ClaudePolicy>): Decision {
    return this.#decide(this.#view(prepared, ctx, snapshot.payload), snapshot);
  }

  #decide(view: CallView, snapshot: PolicySnapshot<ClaudePolicy>): Decision {
    const decision = this.#decideInMode(view, snapshot);
    if (!snapshot.payload.modeUnknown || decision.kind === 'deny') return decision;
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
    const limit = blockedOutside(view, policy);
    if (limit) return limit;
    const critical = criticalRemoval(view, policy);
    if (critical !== undefined) return askOrDeny(`${critical}; no rule or mode approves it`);
    // Plan mode allows no change before the plan is approved, whatever the allow rules say.
    const readOnly = view.prepared.tool === 'read' || view.prepared.tool === 'grep' || view.prepared.tool === 'glob';
    if (policy.mode === 'plan' && !readOnly) return modeDecision(view, policy);
    if (view.prepared.tool === 'bash') {
      const approval = bashApproval(view.prepared, policy, snapshot.bashContainment);
      return approval.kind === 'ask' ? askOrDeny(approval.reason) : approval;
    }
    if (allowedByRule(view, policy.rules.allow)) return { kind: 'allow' };
    return modeDecision(view, policy);
  }

  #select(hooks: readonly CompiledHook[], view: CallView, policy: ClaudePolicy): CompiledHook[] {
    return hooks.filter((hook) => matcherMatches(hook.matcher, view.native.toolName) && this.#ifMatches(hook, view, policy));
  }

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
    if (m.type === 'path') return pathRuleVerdict(m.patterns, view.paths, 'deny') === 'match';
    if (m.type === 'param') return matchesParamValue(m.value, view.native.toolInput[m.name]);
    return true;
  }

  #input(view: CallView, ctx: SessionContext, policy: ClaudePolicy, event: 'PreToolUse' | 'PostToolUse'): Record<string, unknown> {
    const { prepared, native } = view;
    return {
      session_id: ctx.sessionId ?? null,
      transcript_path: ctx.transcriptPath ?? null,
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
    const view = this.#view(prepared, ctx, policy);
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
        return { kind: 'allow', updatedArgs: mapped.args, ...(combined.reason === undefined ? {} : { reason: combined.reason }) };
      }
    }
  }

  async postToolUse(prepared: PreparedCall, result: ToolResult, ctx: SessionContext, snapshot: PolicySnapshot<ClaudePolicy>, signal: AbortSignal): Promise<void> {
    const policy = snapshot.payload;
    const view = this.#view(prepared, ctx, policy);
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
