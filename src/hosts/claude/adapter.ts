import { realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { errorMessage } from '../../core/errors.js';
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
  matcherMatches,
  nativeCall,
  nativeResponse,
  runHook,
  unsupportedReason,
  type CompiledHook,
  type HookOutcome,
  type NativeCall,
} from './hooks.js';
import { parseClaudeFlags, readParentClaudeProcess, type ClaudeCliFlags, type ParentArgsReader } from './parent-args.js';
import {
  bashSpecMayMatchDynamic,
  isInsidePath,
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
  readonly preHooks: readonly CompiledHook[];
  readonly postHooks: readonly CompiledHook[];
  /** Env added for every hook. */
  readonly hookEnv: Readonly<Record<string, string>>;
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
      if (cmd.dynamic && bashSpecMayMatchDynamic(spec, cmd.staticPrefix)) verdict = 'maybe';
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
  const applicable = rules.filter((r) => r.matcher.type !== 'never');
  if (prepared.tool === 'bash') {
    const analysis = view.analysis;
    if (!analysis || analysis.uncertain.length > 0 || analysis.commands.length === 0) {
      return applicable.some((r) => governs(r, 'Bash') && r.matcher.type === 'all');
    }
    if (applicable.some((r) => governs(r, 'Bash') && r.matcher.type === 'all') && view.bashFiles.length === 0) return true;
    // Every subcommand must be approved; files it names must be inside the working directories.
    const everyCommand = analysis.commands.every((cmd) => {
      const form = cmd.allowForm;
      if (form === undefined) return false;
      return applicable.some((r) => governs(r, 'Bash') && (r.matcher.type === 'all' || (r.matcher.type === 'bash' && matchesBashSpec(r.matcher.spec, form))));
    });
    const filesInside = view.bashFiles.every((f) => f.path !== undefined && policy.workingDirs.some((d) => isInsidePath(f.path ?? '', d)));
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
  if (mode === 'auto' || mode === 'bypassPermissions') return { kind: 'allow' };
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

function describe(rule: Rule): string {
  return `${rule.kind} rule ${JSON.stringify(rule.raw)} from ${rule.source} settings`;
}

function compileHooks(entries: readonly HookMatcherEntry[] | undefined, origin: string, env: Readonly<Record<string, string>>, platform: NodeJS.Platform, seen: Set<string>): CompiledHook[] {
  const out: CompiledHook[] = [];
  for (const entry of entries ?? []) {
    for (const handler of entry.hooks) {
      // The same handler defined in several settings files runs once.
      const key = JSON.stringify([entry.matcher ?? '', handler, env]);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ handler, matcher: entry.matcher, origin, env, unsupported: unsupportedReason(handler, platform) });
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
    const flags = parent ? parseClaudeFlags(parent.argv) : NO_FLAGS;
    const settings: LoadedSettings = await loadSettings({ projectRoot, home, configDir, managedDir, env, flags, parentCwd: parent?.cwd });
    const docs = settings.docs;

    // Permission rules.
    const managedOnly = firstSetting(docs.filter((d) => d.source === 'managed'), (s) => s.allowManagedPermissionRulesOnly) === true;
    const ruleDocs = managedOnly ? docs.filter((d) => d.source === 'managed') : docs;
    const holdsCapability = (doc: SettingsDoc): boolean => (doc.source === 'project' || doc.source === 'local') && !settings.projectTrusted;
    const rules: { deny: Rule[]; ask: Rule[]; allow: Rule[] } = { deny: [], ask: [], allow: [] };
    for (const doc of ruleDocs) {
      const anchors = { cwd: ctx.cwd, sourceDir: doc.anchorDir, home };
      for (const kind of ['deny', 'ask', 'allow'] as const) {
        if (kind === 'allow' && holdsCapability(doc)) continue;
        for (const raw of doc.data.permissions?.[kind] ?? []) {
          const rule = parseRule(raw, kind, doc.source, anchors);
          if (rule) rules[kind].push(await withRealAnchors(rule));
          else if (kind !== 'allow') throw new Error(`${kind} rule ${JSON.stringify(raw)} in ${doc.file ?? doc.source} cannot be parsed`);
        }
      }
    }

    // Working directories.
    const workingDirs = new Set<string>([projectRoot, ctx.cwd, ...ctx.roots]);
    for (const doc of docs) {
      if (holdsCapability(doc)) continue;
      for (const dir of doc.data.permissions?.additionalDirectories ?? []) workingDirs.add(resolveDir(dir, projectRoot, home));
    }

    // Permission mode: the live mode from the companion hook, else the CLI flag, else settings, else default.
    const fromCtx = ctx.sources['permissionMode'] !== undefined && ctx.sources['permissionMode'] !== 'default' ? toMode(ctx.permissionMode) : undefined;
    let mode: PermissionMode = fromCtx ?? toMode(flags.permissionMode) ?? toMode(firstSetting(docs, (s) => s.permissions?.defaultMode)) ?? 'default';
    if (mode === 'bypassPermissions' && firstSetting(docs, (s) => s.permissions?.disableBypassPermissionsMode) === 'disable') mode = 'default';

    // Hooks.
    const managedDocs = docs.filter((d) => d.source === 'managed');
    const managedDisable = firstSetting(managedDocs, (s) => s.disableAllHooks) === true;
    const otherDisable = firstSetting(docs.filter((d) => d.source !== 'managed'), (s) => s.disableAllHooks) === true;
    const managedOnlyHooks = firstSetting(managedDocs, (s) => s.allowManagedHooksOnly) === true;
    const seen = new Set<string>();
    const pre: CompiledHook[] = [];
    const post: CompiledHook[] = [];
    for (const doc of docs) {
      const isManaged = doc.source === 'managed';
      if (managedDisable) break;
      if (!isManaged && (otherDisable || managedOnlyHooks)) continue;
      const origin = `${doc.source} settings`;
      pre.push(...compileHooks(doc.data.hooks?.PreToolUse, origin, {}, platform, seen));
      post.push(...compileHooks(doc.data.hooks?.PostToolUse, origin, {}, platform, seen));
    }
    if (!managedDisable && !otherDisable && !managedOnlyHooks) {
      for (const plugin of settings.plugins) {
        const env = { CLAUDE_PLUGIN_ROOT: plugin.root };
        pre.push(...compileHooks(plugin.hooks.PreToolUse, `plugin ${plugin.plugin}`, env, platform, seen));
        post.push(...compileHooks(plugin.hooks.PostToolUse, `plugin ${plugin.plugin}`, env, platform, seen));
      }
    }

    // Bash containment: Claude's sandbox when enabled.
    let bashContainment: BashContainment = { mode: 'none' };
    if (firstSetting(docs, (s) => s.sandbox?.enabled) === true) {
      const roots = new Set<string>([projectRoot, ...workingDirs]);
      const fsDisabled = firstSetting(
        docs.filter((d) => d.source === 'managed' || d.source === 'user' || d.source === 'flag-settings'),
        (s) => s.sandbox?.filesystem?.disabled,
      );
      for (const doc of docs) {
        for (const entry of doc.data.sandbox?.filesystem?.allowWrite ?? []) roots.add(resolveDir(entry, projectRoot, home));
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

    const protectedPaths = [
      ...new Set([
        ...[projectRoot, ctx.cwd].flatMap((root) => [
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
        ...docs.flatMap((d) => (d.source === 'flag-settings' && d.file !== undefined ? [d.file] : [])),
      ]),
    ];

    return {
      host: 'claude',
      bashContainment,
      protectedPaths,
      payload: {
        projectRoot,
        cwd: ctx.cwd,
        home,
        configDir,
        mode,
        rules,
        workingDirs: [...workingDirs],
        preHooks: pre,
        postHooks: post,
        hookEnv: { CLAUDE_PROJECT_DIR: projectRoot },
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

  checkStatic(prepared: PreparedCall, _ctx: SessionContext, snapshot: PolicySnapshot<ClaudePolicy>): Decision {
    const policy = snapshot.payload;
    const view = this.#view(prepared, policy);
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
    if (view.analysis && view.analysis.uncertain.length > 0) {
      return askOrDeny(`the command cannot be checked statically (${view.analysis.uncertain.join('; ')})`);
    }
    if (allowedByRule(view, policy.rules.allow, policy)) return { kind: 'allow' };
    return modeDecision(view, policy);
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
        (cmd) => cmd.denyForms.some((f) => matchesBashSpec(m.spec, f)) || (cmd.dynamic && (specific || bashSpecMayMatchDynamic(m.spec, cmd.staticPrefix))),
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
      cwd: prepared.tool === 'bash' ? prepared.effect.cwd : ctx.cwd,
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
    const view = this.#view(prepared, policy);
    const hooks = this.#select(policy.preHooks, view, policy);
    const unsupported = hooks.find((h) => h.unsupported !== undefined);
    if (unsupported) {
      return { kind: 'deny', source: 'unsupported-config', reason: `${unsupported.origin}: ${unsupported.unsupported ?? 'unsupported hook'}` };
    }
    if (hooks.length === 0) return { kind: 'allow' };
    const input = this.#input(view, ctx, policy, 'PreToolUse');
    const opts = { event: 'PreToolUse' as const, input, cwd: policy.projectRoot, env: policy.hookEnv, signal };
    const blocking: Promise<HookOutcome>[] = [];
    for (const hook of hooks) {
      if (hook.handler.async === true || hook.handler.asyncRewake === true) {
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

  async postToolUse(prepared: PreparedCall, result: ToolResult, ctx: SessionContext, snapshot: PolicySnapshot<ClaudePolicy>): Promise<void> {
    const policy = snapshot.payload;
    const view = this.#view(prepared, policy);
    const hooks = this.#select(policy.postHooks, view, policy);
    if (hooks.length === 0) return;
    const input = { ...this.#input(view, ctx, policy, 'PostToolUse'), tool_response: nativeResponse(prepared, result) };
    const controller = new AbortController();
    const opts = { event: 'PostToolUse' as const, input, cwd: policy.projectRoot, env: policy.hookEnv, signal: controller.signal };
    const notes: string[] = [];
    const outcomes = await Promise.all(
      hooks.map(async (hook) => {
        if (hook.unsupported !== undefined) return { hook, outcome: { kind: 'failure', source: 'hook-error', reason: hook.unsupported } satisfies HookOutcome };
        if (hook.handler.async === true || hook.handler.asyncRewake === true) {
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
