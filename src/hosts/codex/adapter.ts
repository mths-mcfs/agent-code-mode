/**
 * Codex CLI host adapter: authorizes every binding call the way Codex 0.169
 * authorizes the equivalent native action.
 *
 * Reference: openai/codex rust-v0.169.0 (commit d32063f96c2d). See config.ts,
 * exec-policy.ts, hooks.ts and apply-patch.ts for the parts of the source
 * each piece follows.
 *
 * checkStatic (no I/O):
 * - Shell-shaped calls (bash, and read/grep/glob shown as the shell command
 *   Codex would run) go through the exec policy rules on every simple
 *   command: forbidden → deny, prompt → ask, allow → allow; strictest wins.
 *   Unmatched commands follow Codex's heuristics: a forced `rm` asks, and the
 *   `untrusted` approval policy asks for everything not allowed by a rule.
 *   With approval `never`, Codex rejects what it would ask: deny.
 * - write/edit follow the sandbox mode: `read-only` asks, `workspace-write`
 *   allows inside the writable roots (except `.git`, `.agents`, `.codex`,
 *   `.aws` below them) and asks elsewhere, `danger-full-access` allows.
 *
 * Deviation (stricter than Codex): an exec-policy `allow` does not lift bash
 * containment; the containment is always the sandbox mode's.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { stateDirPath } from '../../core/state-dir.js';
import type { BashContainment, Decision, HostAdapter, HostCall, PolicyLoadError, PolicySnapshot, PreparedCall, SessionContext } from '../../core/types.js';
import { ConfigError, loadCodexConfig, nodeConfigIo, ruleFiles, type ApprovalPolicy, type ConfigIo, type SandboxMode } from './config.js';
import { isDangerousCommand, matchRules, parseRulesFile, RulesParseError, strictest, type ExecPolicy, type PrefixRule } from './exec-policy.js';
import { discoverHooks, matcherMatches, runHooks, type HookHandler } from './hooks.js';
import { mapUpdatedInput, nativeCall, NativeShapeError, shellCommandFor, type NativeCall } from './native.js';
import { INEXACT, ShellParseError, splitShellCommands } from './shell.js';

/** Adapter-specific part of the policy snapshot. */
export interface CodexPolicy {
  readonly sandboxMode: SandboxMode;
  readonly approvalPolicy: ApprovalPolicy;
  /** Roots write/edit may change without asking (workspace-write only). */
  readonly writableRoots: readonly string[];
  readonly rules: ExecPolicy;
  readonly hooks: readonly HookHandler[];
  readonly hooksEnabled: boolean;
  /** Hook `permission_mode`: `bypassPermissions` when approval is `never`, else `default`. */
  readonly permissionMode: string;
  readonly codexHome: string;
  readonly notes: readonly string[];
}

export interface CodexHostAdapterOptions {
  /** Filesystem and process access (tests). Defaults to the real ones. */
  readonly io?: (ctx: SessionContext) => ConfigIo;
  /** Environment of hook processes. Defaults to `process.env`. */
  readonly hookEnv?: Readonly<Record<string, string | undefined>>;
  /** Server state directory, protected from writes. */
  readonly stateDir?: string;
  /** Temp directories writable in workspace-write. Defaults to `/tmp` and `$TMPDIR`. */
  readonly tmpDirs?: { readonly slashTmp: string | null; readonly tmpdir: string | null };
  /** Replaces how the current file is read for write/edit (tests). */
  readonly readCurrent?: (absPath: string, beforeHash: string | null) => Promise<string | null>;
}

const READ_ONLY_SUBPATHS = ['.git', '.agents', '.codex', '.aws'];
const SANDBOX_MODES: readonly string[] = ['read-only', 'workspace-write', 'danger-full-access'];

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function unique(xs: readonly string[]): string[] {
  return [...new Set(xs)];
}

/** Codex PreToolUse hook input (hooks/src/schema.rs `PreToolUseCommandInput`). */
export function hookInput(prepared: PreparedCall, native: NativeCall, ctx: SessionContext, policy: CodexPolicy): Record<string, unknown> {
  return {
    session_id: ctx.sessionId ?? '',
    turn_id: ctx.turnId ?? '',
    transcript_path: ctx.transcriptPath ?? null,
    cwd: native.cwd,
    hook_event_name: 'PreToolUse',
    model: ctx.model ?? '',
    permission_mode: policy.permissionMode,
    tool_name: native.toolName,
    tool_input: native.toolInput,
    tool_use_id: ctx.toolUseId === undefined ? prepared.id : `${ctx.toolUseId}/${prepared.id}`,
  };
}

/** Builds the bash containment of a sandbox mode. */
export function containmentFor(mode: SandboxMode, writableRoots: readonly string[], network: boolean): BashContainment {
  switch (mode) {
    case 'read-only':
      return { mode: 'sandbox', readOnly: true, writableRoots: [], network: false };
    case 'workspace-write':
      return { mode: 'sandbox', readOnly: false, writableRoots: [...writableRoots], network };
    case 'danger-full-access':
      return { mode: 'none' };
  }
}

/** Why `mcpCall` is refused under Codex: its MCP approval rules are not reproduced yet. */
export const CODEX_MCP_UNSUPPORTED = 'upstream MCP calls (mcpCall) are only supported under Claude Code; Codex MCP approvals are not reproduced';

export class CodexHostAdapter implements HostAdapter<CodexPolicy> {
  readonly host = 'codex' as const;
  readonly usesScratch = true;
  readonly #opts: CodexHostAdapterOptions;

  constructor(opts: CodexHostAdapterOptions = {}) {
    this.#opts = opts;
  }

  async loadPolicy(ctx: SessionContext): Promise<PolicySnapshot<CodexPolicy> | PolicyLoadError> {
    try {
      return this.#load(ctx);
    } catch (err) {
      if (err instanceof ConfigError || err instanceof RulesParseError) return { error: err.message };
      return { error: `cannot load the Codex configuration: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  #load(ctx: SessionContext): PolicySnapshot<CodexPolicy> {
    const io = this.#opts.io ? this.#opts.io(ctx) : nodeConfigIo(parentAwareEnv());
    const config = loadCodexConfig(ctx.cwd, io);

    const rules: PrefixRule[] = [];
    for (const file of ruleFiles(config, io)) {
      const text = io.readFile(file);
      if (text === undefined) continue;
      rules.push(...parseRulesFile(text, file));
    }
    const { hooks, notes: hookNotes } = discoverHooks(config, io);

    // The host's own turn metadata is authoritative for the sandbox mode.
    let sandboxMode = config.sandboxMode;
    if (ctx.sandboxMode !== undefined) {
      if (!SANDBOX_MODES.includes(ctx.sandboxMode)) throw new ConfigError(`unknown Codex sandbox mode ${JSON.stringify(ctx.sandboxMode)}`);
      sandboxMode = ctx.sandboxMode === 'read-only' ? 'read-only' : ctx.sandboxMode === 'workspace-write' ? 'workspace-write' : 'danger-full-access';
    }

    const tmp = this.#opts.tmpDirs ?? { slashTmp: process.platform === 'win32' ? null : '/tmp', tmpdir: io.env['TMPDIR'] ?? null };
    const tmpRoots = [
      ...(config.excludeSlashTmp || tmp.slashTmp === null ? [] : [tmp.slashTmp]),
      ...(config.excludeTmpdirEnvVar || tmp.tmpdir === null || !path.isAbsolute(tmp.tmpdir) ? [] : [tmp.tmpdir]),
    ];
    // The scratch directory is one more writable root, so the read-only mode still refuses it.
    const writableRoots = unique([config.cwd, ...config.writableRoots, ...tmpRoots, ...(ctx.scratchDir === undefined ? [] : [ctx.scratchDir])].map((p) => path.resolve(p)));
    const bashContainment = containmentFor(sandboxMode, writableRoots, config.networkAccess);

    const stateDir = this.#opts.stateDir ?? stateDirPath(io.env, io.home);
    const homeCodex = path.join(io.home, '.codex');
    const protectedPaths = unique([
      '**/.codex/**',
      `${config.codexHome}/**`,
      `${io.realpath(config.codexHome)}/**`,
      `${homeCodex}/**`,
      `${io.systemDir}/**`,
      `${stateDir}/**`,
      path.join(config.cwd, '.mcp.json'),
      path.join(config.projectRoot, '.mcp.json'),
    ]);

    // What the bash watch fingerprints: the policy files Codex reads (config, hooks and exec-policy rules of every
    // config folder, the system requirements) and the state dir, not the rest of ~/.codex (sessions, logs, caches).
    const policyFolders = unique([
      config.codexHome,
      homeCodex,
      io.systemDir,
      ...config.layers.flatMap((l) => (l.folder === null ? [] : [l.folder])),
      ...config.untrustedProjectFolders,
      path.join(config.cwd, '.codex'),
      path.join(config.projectRoot, '.codex'),
    ]);
    const watchedPaths = unique([
      `${stateDir}/**`,
      ...policyFolders.flatMap((f) => [path.join(f, 'config.toml'), path.join(f, 'hooks.json'), path.join(f, 'rules', '*.rules')]),
      path.join(io.systemDir, 'requirements.toml'),
      path.join(io.systemDir, 'managed_config.toml'),
      path.join(config.cwd, '.mcp.json'),
      path.join(config.projectRoot, '.mcp.json'),
    ]);

    // The configured writable roots (`sandbox_workspace_write.writable_roots`) are where Codex lets
    // file edits land besides the cwd, so the tools jail must reach them too (real paths, like the jail's).
    const additionalRoots =
      sandboxMode === 'workspace-write' ? unique(config.writableRoots.filter((p) => path.isAbsolute(p)).map((p) => io.realpath(path.resolve(p)))) : [];

    return {
      host: 'codex',
      bashContainment,
      protectedPaths,
      watchedPaths,
      ...(additionalRoots.length > 0 ? { additionalRoots } : {}),
      ...(ctx.scratchDir === undefined ? {} : { scratchRoot: ctx.scratchDir }),
      payload: {
        sandboxMode,
        approvalPolicy: config.approvalPolicy,
        writableRoots: sandboxMode === 'workspace-write' ? writableRoots : [],
        rules: { rules },
        hooks,
        hooksEnabled: config.hooksEnabled,
        permissionMode: config.approvalPolicy === 'never' ? 'bypassPermissions' : 'default',
        codexHome: config.codexHome,
        notes: [...config.notes, ...hookNotes],
      },
    };
  }

  checkStatic(prepared: HostCall, _ctx: SessionContext, policy: PolicySnapshot<CodexPolicy>): Decision {
    if (prepared.tool === 'mcp') return { kind: 'deny', source: 'unsupported-config', reason: CODEX_MCP_UNSUPPORTED };
    const p = policy.payload;
    if (prepared.tool === 'write' || prepared.tool === 'edit') return checkFileWrite(prepared.effect.absPath, p);
    const command = shellCommandFor(prepared);
    if (command === undefined) return { kind: 'deny', source: 'rule', reason: 'no shell form for this call' };
    return checkShellCommand(command, p);
  }

  async authorize(prepared: HostCall, ctx: SessionContext, policy: PolicySnapshot<CodexPolicy>, signal: AbortSignal): Promise<Decision> {
    if (prepared.tool === 'mcp') return { kind: 'deny', source: 'unsupported-config', reason: CODEX_MCP_UNSUPPORTED };
    const p = policy.payload;
    if (!p.hooksEnabled || p.hooks.length === 0) return { kind: 'allow' };
    let native: NativeCall;
    try {
      native = await nativeCall(prepared, ctx, this.#opts.readCurrent);
    } catch (err) {
      const reason = err instanceof NativeShapeError ? err.message : `cannot build the Codex tool input: ${err instanceof Error ? err.message : String(err)}`;
      return { kind: 'deny', source: 'hook-error', reason };
    }
    if (!p.hooks.some((h) => matcherMatches(h.matcher, native.names))) return { kind: 'allow' };
    // The patch grammar cannot express every byte sequence (a missing final
    // newline, line endings other than the file's first). A hook must not
    // approve a change different from the one that would be applied.
    if (native.exact === false) {
      return {
        kind: 'deny',
        source: 'unsupported-config',
        reason: 'this change cannot be shown to Codex apply_patch hooks exactly (missing final newline or mixed/CRLF line endings the patch format cannot express); write the content with a trailing newline and the file\'s line endings',
      };
    }
    const result = await runHooks({
      hooks: p.hooks,
      names: native.names,
      stdin: JSON.stringify(hookInput(prepared, native, ctx, p)),
      cwd: native.cwd,
      env: this.#opts.hookEnv ?? process.env,
      platform: process.platform,
      signal,
    });
    if (result.kind === 'deny') return { kind: 'deny', source: result.source, reason: result.reason };
    if (result.updatedInput === undefined) return { kind: 'allow' };
    const mapped = mapUpdatedInput(prepared, native, result.updatedInput, ctx);
    switch (mapped.kind) {
      case 'unchanged':
        return { kind: 'allow' };
      case 'updated':
        return { kind: 'allow', updatedArgs: mapped.args, reason: 'rewritten by a Codex PreToolUse hook' };
      case 'invalid':
        return { kind: 'deny', source: 'hook-error', reason: mapped.reason };
      case 'unsupported':
        return { kind: 'deny', source: 'unsupported-config', reason: mapped.reason };
    }
  }
}

/** Static decision for a shell command (exec policy rules plus Codex heuristics). */
/**
 * Whether `rule` could match `argv` once bash expands its first inexact word
 * (see `INEXACT`): the words before it match the rule, and the rule goes on
 * past it.
 */
function mayMatchInexact(rule: PrefixRule, argv: readonly string[]): boolean {
  const at = argv.findIndex((a) => a.startsWith(INEXACT));
  if (at === -1 || rule.rest.length + 1 <= at) return false;
  for (let j = 0; j < at; j++) {
    const a = argv[j] ?? '';
    if (j === 0) {
      if (a !== rule.program && !(a.startsWith('/') && a.endsWith(`/${rule.program}`))) return false;
    } else if (!(rule.rest[j - 1] ?? []).includes(a)) return false;
  }
  return true;
}

/** argv for messages, without the inexact markers. */
function shown(argv: readonly string[]): string {
  return argv.map((a) => a.replaceAll(INEXACT, '')).join(' ');
}

export function checkShellCommand(command: string, p: CodexPolicy): Decision {
  let split;
  try {
    split = splitShellCommands(command);
  } catch (err) {
    const why = err instanceof ShellParseError ? err.message : String(err);
    return { kind: 'deny', source: 'rule', reason: `the command cannot be parsed for the Codex exec policy: ${why}` };
  }
  const commands = [...split.commands];
  // Codex evaluates a script it cannot split as the single argv `bash -lc <script>`.
  if (!split.plain) commands.push(['bash', '-lc', command]);

  const matched: PrefixRule[] = [];
  let unmatchedAsk: string | undefined;
  for (const argv of commands) {
    // A forbidden or prompt rule that may match a word bash changes at run time cannot be settled statically.
    const maybe = p.rules.rules.find((r) => r.decision !== 'allow' && mayMatchInexact(r, argv));
    if (maybe) unmatchedAsk ??= `${shown(argv)} has a word bash expands at run time, which Codex rule ${maybe.source} may match`;
    const rules = matchRules(p.rules, argv);
    if (rules.length > 0) {
      matched.push(...rules);
      continue;
    }
    if (isDangerousCommand(argv)) unmatchedAsk ??= `${shown(argv)} is a forced rm (Codex asks before running it)`;
    else if (p.approvalPolicy === 'untrusted') unmatchedAsk ??= `${shown(argv)} is not allowed by an exec policy rule and the approval policy is untrusted`;
  }
  // A wrapper whose options this server does not know may run anything: ask.
  if (split.unsure.length > 0) unmatchedAsk ??= `cannot tell which command runs behind a wrapper (${split.unsure[0] ?? ''})`;
  const top = strictest(matched);
  const why = (r: PrefixRule): string => `${r.decision} by Codex rule ${r.source} (${[r.program, ...r.rest.map((a) => a.join('|'))].join(' ')})${r.justification ? `: ${r.justification}` : ''}`;
  if (top?.decision === 'forbidden') return { kind: 'deny', source: 'rule', reason: why(top) };
  const askReason = top?.decision === 'prompt' ? why(top) : unmatchedAsk;
  if (askReason !== undefined) {
    if (p.approvalPolicy === 'never') return { kind: 'deny', source: 'rule', reason: `${askReason}; approval policy never rejects it` };
    return { kind: 'ask', reason: askReason };
  }
  return { kind: 'allow' };
}

/** Static decision for a file write under the sandbox mode. */
export function checkFileWrite(absPath: string, p: CodexPolicy): Decision {
  const ask = (reason: string): Decision =>
    p.approvalPolicy === 'never' ? { kind: 'deny', source: 'rule', reason: `${reason}; approval policy never rejects it` } : { kind: 'ask', reason };
  switch (p.sandboxMode) {
    case 'danger-full-access':
      return { kind: 'allow' };
    case 'read-only':
      return ask(`writing ${absPath} needs approval in the read-only sandbox`);
    case 'workspace-write': {
      const root = p.writableRoots.find((r) => isInside(absPath, r));
      if (root === undefined) return ask(`${absPath} is outside the writable roots of the workspace-write sandbox`);
      for (const r of p.writableRoots) {
        for (const sub of READ_ONLY_SUBPATHS) {
          if (isInside(absPath, path.join(r, sub))) return ask(`${absPath} is inside the read-only ${sub} folder of the workspace-write sandbox`);
        }
      }
      return { kind: 'allow' };
    }
  }
}

/**
 * Codex starts MCP servers with a minimal environment that drops
 * `CODEX_HOME`. On Linux the parent's value is read from `/proc`; elsewhere
 * only the server's own environment is used.
 */
function parentAwareEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  if (env['CODEX_HOME'] === undefined && process.platform === 'linux') {
    try {
      const hit = readFileSync(`/proc/${process.ppid}/environ`, 'utf8')
        .split('\0')
        .find((kv) => kv.startsWith('CODEX_HOME='));
      if (hit !== undefined) env['CODEX_HOME'] = hit.slice('CODEX_HOME='.length);
    } catch {
      // Not readable: keep the server's environment.
    }
  }
  return env;
}

/**
 * `mcp_servers.<serverName>.tool_timeout_sec` as the Codex configuration for
 * `cwd` sets it (the same layers `loadPolicy` reads), or undefined when it is
 * not set, not a positive number, or the configuration cannot be loaded.
 */
export function codexToolTimeoutSec(cwd: string, serverName: string, io: ConfigIo = nodeConfigIo(parentAwareEnv())): number | undefined {
  let config;
  try {
    config = loadCodexConfig(cwd, io);
  } catch {
    return undefined;
  }
  const servers = config.merged['mcp_servers'];
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) return undefined;
  const entry: unknown = Object.entries(servers).find(([name]) => name === serverName)?.[1];
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
  const value: unknown = Object.entries(entry).find(([key]) => key === 'tool_timeout_sec')?.[1];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
