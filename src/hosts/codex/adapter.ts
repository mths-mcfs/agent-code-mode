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
import type { BashContainment, Decision, HostAdapter, PolicyLoadError, PolicySnapshot, PreparedCall, SessionContext } from '../../core/types.js';
import { ConfigError, loadCodexConfig, nodeConfigIo, ruleFiles, type ApprovalPolicy, type ConfigIo, type SandboxMode } from './config.js';
import { isDangerousCommand, matchRules, parseRulesFile, RulesParseError, strictest, type ExecPolicy, type PrefixRule } from './exec-policy.js';
import { discoverHooks, matcherMatches, runHooks, type HookHandler } from './hooks.js';
import { APPLY_PATCH_NAMES, BASH_NAMES, mapUpdatedInput, nativeCall, NativeShapeError, shellCommandFor, type NativeCall } from './native.js';
import { ShellParseError, splitShellCommands } from './shell.js';

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
/** Sandbox modes, least to most permissive. */
const SANDBOX_MODES: readonly SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access'];

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  // Compare whole segments: a child named `..name` is inside.
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
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

export class CodexHostAdapter implements HostAdapter<CodexPolicy> {
  readonly host = 'codex' as const;
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
      if (text === undefined) throw new ConfigError(`rule file ${file} disappeared while the rules were read`);
      rules.push(...parseRulesFile(text, file));
    }
    const { hooks, notes: hookNotes } = discoverHooks(config, io);

    // The turn metadata can narrow the sandbox mode, never widen it past the reconstructed policy.
    let sandboxMode = config.sandboxMode;
    if (ctx.sandboxMode !== undefined) {
      const turn = SANDBOX_MODES.find((m) => m === ctx.sandboxMode);
      if (turn === undefined) throw new ConfigError(`unknown Codex sandbox mode ${JSON.stringify(ctx.sandboxMode)}`);
      if (SANDBOX_MODES.indexOf(turn) < SANDBOX_MODES.indexOf(sandboxMode)) sandboxMode = turn;
    }

    const tmp = this.#opts.tmpDirs ?? { slashTmp: process.platform === 'win32' ? null : '/tmp', tmpdir: io.env['TMPDIR'] ?? null };
    const tmpRoots = [
      ...(config.excludeSlashTmp || tmp.slashTmp === null ? [] : [tmp.slashTmp]),
      ...(config.excludeTmpdirEnvVar || tmp.tmpdir === null || !path.isAbsolute(tmp.tmpdir) ? [] : [tmp.tmpdir]),
    ];
    const writableRoots = unique([config.cwd, ...config.writableRoots, ...tmpRoots].map((p) => path.resolve(p)));
    const bashContainment = containmentFor(sandboxMode, writableRoots, config.networkAccess);

    const stateDir = this.#opts.stateDir ?? stateDirPath(io.env, io.home);
    const homeCodex = path.join(io.home, '.codex');
    // Each protected path also by its canonical destination; a missing one through its nearest existing parent.
    const canonical = (p: string): string => {
      if (io.exists(p)) return io.realpath(p);
      const parent = path.dirname(p);
      return parent === p ? p : path.join(canonical(parent), path.basename(p));
    };
    const both = (p: string): string[] => [p, canonical(p)];
    const protectedPaths = unique([
      '**/.codex/**',
      ...[config.codexHome, homeCodex, io.systemDir, stateDir].flatMap(both).map((d) => `${d}/**`),
      ...[path.join(config.cwd, '.mcp.json'), path.join(config.projectRoot, '.mcp.json')].flatMap(both),
    ]);

    return {
      host: 'codex',
      bashContainment,
      protectedPaths,
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

  checkStatic(prepared: PreparedCall, _ctx: SessionContext, policy: PolicySnapshot<CodexPolicy>): Decision {
    const p = policy.payload;
    if (prepared.tool === 'write' || prepared.tool === 'edit') return checkFileWrite(prepared.effect.absPath, p);
    const command = shellCommandFor(prepared);
    if (command === undefined) return { kind: 'deny', source: 'rule', reason: 'no shell form for this call' };
    return checkShellCommand(command, p);
  }

  async authorize(prepared: PreparedCall, ctx: SessionContext, policy: PolicySnapshot<CodexPolicy>, signal: AbortSignal): Promise<Decision> {
    const p = policy.payload;
    if (!p.hooksEnabled || p.hooks.length === 0) return { kind: 'allow' };
    // Filter by the tool's names first: no file is read or patch built for a call no hook matches.
    const names = prepared.tool === 'write' || prepared.tool === 'edit' ? APPLY_PATCH_NAMES : BASH_NAMES;
    if (!p.hooks.some((h) => matcherMatches(h.matcher, names))) return { kind: 'allow' };
    let native: NativeCall;
    try {
      native = await nativeCall(prepared, ctx, this.#opts.readCurrent);
    } catch (err) {
      const reason = err instanceof NativeShapeError ? err.message : `cannot build the Codex tool input: ${err instanceof Error ? err.message : String(err)}`;
      return { kind: 'deny', source: 'hook-error', reason };
    }
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
      // Codex starts hooks in the session cwd; the tool's cwd is only in the input.
      cwd: ctx.cwd,
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
        return {
          kind: 'allow',
          updatedArgs: mapped.args,
          ...(mapped.bindsPreparedFile ? { bindsPreparedFile: true } : {}),
          reason: 'rewritten by a Codex PreToolUse hook',
        };
      case 'invalid':
        return { kind: 'deny', source: 'hook-error', reason: mapped.reason };
      case 'unsupported':
        return { kind: 'deny', source: 'unsupported-config', reason: mapped.reason };
    }
  }
}

/** Static decision for a shell command (exec policy rules plus Codex heuristics). */
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
    const rules = matchRules(p.rules, argv);
    if (rules.length > 0) {
      matched.push(...rules);
      continue;
    }
    if (isDangerousCommand(argv)) unmatchedAsk ??= `${argv.join(' ')} is a forced rm (Codex asks before running it)`;
    else if (p.approvalPolicy === 'untrusted') unmatchedAsk ??= `${argv.join(' ')} is not allowed by an exec policy rule and the approval policy is untrusted`;
  }
  // A wrapper whose options this server does not know may run anything: ask.
  if (split.unsure.length > 0) unmatchedAsk ??= `cannot tell which command runs behind a wrapper (${split.unsure[0] ?? ''})`;
  // Words expanded at run time: ask when they could reach a rule or the forced-rm check.
  for (const argv of split.dynamic) {
    const program = argv[0] ?? '';
    const base = path.basename(program);
    const relevant = /[$`*?[{]/.test(program) || ['rm', 'sudo', 'env'].includes(base) || p.rules.rules.some((r) => r.program === program || r.program === base);
    if (relevant) unmatchedAsk ??= `${argv.join(' ')} has words expanded at run time, so its exact command cannot be checked`;
  }
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
