/**
 * Codex CLI host adapter: authorizes every binding call the way Codex 0.169
 * authorizes the equivalent native action.
 *
 * Reference: openai/codex rust-v0.169.0 (commit d32063f96c2d). See config.ts,
 * exec-policy.ts, hooks.ts and apply-patch.ts for the parts of the source
 * each piece follows.
 *
 * checkStatic (no I/O):
 * - Shell-shaped calls (bash, read shown as the shell command Codex would
 *   run, and grep/glob lowered to the exact rg command they run as) go
 *   through the exec policy rules on every simple
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

import path from 'node:path';
import { stateDirPath } from '../../core/state-dir.js';
import type { BashContainment, BashShell, Decision, HostAdapter, PolicyLoadError, PolicySnapshot, PreparedCall, PreparedCallOf, SearchLowering, SessionContext } from '../../core/types.js';
import { codexSessionIo, ConfigError, getPath, isTable, loadCodexConfig, ruleFiles, type ApprovalPolicy, type ConfigIo, type SandboxMode } from './config.js';
import { executableLookupKey, isDangerousCommand, matchRules, parseRulesFile, RulesParseError, strictest, type ExecPolicy, type PrefixRule } from './exec-policy.js';
import { discoverHooks, matcherMatches, runHooks, type HookHandler } from './hooks.js';
import { APPLY_PATCH_NAMES, BASH_NAMES, mapUpdatedInput, nativeCall, NativeShapeError, shellCommandFor, type NativeCall } from './native.js';
import { lowerSearch } from './search.js';
import { ShellParseError, shlexSplit, splitShellCommands } from './shell.js';

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
const SANDBOX_MODES_BY_PERMISSIVENESS: readonly SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access'];

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** `dir` and each of its parents, nearest first. */
function ancestors(dir: string): string[] {
  const out = [path.resolve(dir)];
  for (let parent = path.dirname(out[0] ?? dir); parent !== out[out.length - 1]; parent = path.dirname(parent)) out.push(parent);
  return out;
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
    const io = this.#opts.io ? this.#opts.io(ctx) : codexSessionIo();
    const config = loadCodexConfig(ctx.cwd, io);

    const rules: PrefixRule[] = [];
    for (const file of ruleFiles(config, io)) {
      const text = io.readFile(file);
      if (text === undefined) throw new ConfigError(`rule file ${file} disappeared while the rules were read`);
      rules.push(...parseRulesFile(text, file));
    }
    const { hooks, notes: hookNotes } = discoverHooks(config, io);

    let sandboxMode = config.sandboxMode;
    if (ctx.sandboxMode !== undefined) {
      const turn = SANDBOX_MODES_BY_PERMISSIVENESS.find((m) => m === ctx.sandboxMode);
      if (turn === undefined) throw new ConfigError(`unknown Codex sandbox mode ${JSON.stringify(ctx.sandboxMode)}`);
      if (SANDBOX_MODES_BY_PERMISSIVENESS.indexOf(turn) < SANDBOX_MODES_BY_PERMISSIVENESS.indexOf(sandboxMode)) sandboxMode = turn;
    }
    const allowed = config.requirements?.allowedSandboxModes;
    if (allowed !== undefined && !allowed.includes(sandboxMode)) {
      const below = SANDBOX_MODES_BY_PERMISSIVENESS.slice(0, SANDBOX_MODES_BY_PERMISSIVENESS.indexOf(sandboxMode)).reverse().find((m) => allowed.includes(m));
      if (below === undefined) throw new ConfigError(`the requirements allow no sandbox mode at most ${sandboxMode}`);
      sandboxMode = below;
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
    const canonical = (p: string): string => {
      if (io.exists(p)) return io.realpath(p);
      const parent = path.dirname(p);
      return parent === p ? p : path.join(canonical(parent), path.basename(p));
    };
    const both = (p: string): string[] => [p, canonical(p)];
    // Absolute patterns only: an OS sandbox can deny writing a literal directory, never a glob like `**/.codex/**`.
    const upward = ancestors(config.cwd);
    const projectDirs = upward.slice(0, Math.max(upward.indexOf(path.resolve(config.projectRoot)), 0) + 1);
    const codexDirs = unique([...projectDirs, ...writableRoots]).map((d) => path.join(d, '.codex'));
    const readOnlySubpaths = sandboxMode === 'workspace-write' ? writableRoots.flatMap((r) => READ_ONLY_SUBPATHS.map((sub) => path.join(r, sub))) : [];
    const protectedPaths = unique([
      ...[...codexDirs, ...readOnlySubpaths, config.codexHome, homeCodex, io.systemDir, stateDir].flatMap(both).map((d) => `${d}/**`),
      ...[path.join(config.cwd, '.mcp.json'), path.join(config.projectRoot, '.mcp.json')].flatMap(both),
    ]);
    const policyFolders = unique([
      config.codexHome,
      homeCodex,
      io.systemDir,
      ...projectDirs.map((d) => path.join(d, '.codex')),
      ...config.layers.flatMap((l) => [l.folder, l.hooksFolder].filter((f): f is string => typeof f === 'string')),
      ...config.untrustedProjectFolders,
    ]);
    const watchedPaths = unique([
      ...policyFolders.flatMap((f) => [path.join(f, 'config.toml'), path.join(f, 'hooks.json'), path.join(f, 'rules', '*.rules')]),
      ...config.layers.map((l) => l.file).filter((f) => path.isAbsolute(f)),
      path.join(io.systemDir, 'requirements.toml'),
      path.join(io.systemDir, 'managed_config.toml'),
      path.join(config.cwd, '.mcp.json'),
      path.join(config.projectRoot, '.mcp.json'),
    ]);

    return {
      host: 'codex',
      bashContainment,
      protectedPaths,
      watchedPaths,
      // Configured writable roots and --add-dir widen the tools' workspace in workspace-write only; /tmp and $TMPDIR do not.
      ...(sandboxMode === 'workspace-write' ? { additionalRoots: unique(config.writableRoots.map((p) => path.resolve(p))) } : {}),
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

  lowerSearch(prepared: PreparedCallOf<'grep'> | PreparedCallOf<'glob'>): SearchLowering {
    return lowerSearch(prepared);
  }

  checkStatic(prepared: PreparedCall, _ctx: SessionContext, policy: PolicySnapshot<CodexPolicy>): Decision {
    const p = policy.payload;
    if (prepared.tool === 'write' || prepared.tool === 'edit') return checkFileWrite(prepared.effect.absPath, p);
    if (prepared.tool === 'bash') {
      const shell = prepared.effect.shell;
      if (!isBashExecutor(shell)) {
        return {
          kind: 'deny',
          source: 'unsupported-config',
          reason: `the command would run as ${JSON.stringify([shell.path, ...shell.args])}, a shell whose dialect the Codex exec policy check does not evaluate (only bash -c)`,
        };
      }
      return checkShellCommand(prepared.effect.command, p, [shell.path, ...shell.args]);
    }
    const command = shellCommandFor(prepared);
    if (command === undefined) return { kind: 'deny', source: 'rule', reason: 'no shell form for this call' };
    return checkShellCommand(command, p);
  }

  async authorize(prepared: PreparedCall, ctx: SessionContext, policy: PolicySnapshot<CodexPolicy>, signal: AbortSignal): Promise<Decision> {
    const p = policy.payload;
    if (!p.hooksEnabled || p.hooks.length === 0) return { kind: 'allow' };
    const names = prepared.tool === 'write' || prepared.tool === 'edit' ? APPLY_PATCH_NAMES : BASH_NAMES;
    if (!p.hooks.some((h) => matcherMatches(h.matcher, names))) return { kind: 'allow' };
    let native: NativeCall;
    try {
      native = await nativeCall(prepared, ctx, this.#opts.readCurrent);
    } catch (err) {
      const reason = err instanceof NativeShapeError ? err.message : `cannot build the Codex tool input: ${err instanceof Error ? err.message : String(err)}`;
      return { kind: 'deny', source: 'hook-error', reason };
    }
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

/** Variables that name a command or a config file a program reads commands from. */
const COMMAND_VARIABLES = /^(GIT_PAGER|PAGER|MANPAGER|GIT_EXTERNAL_DIFF|GIT_SSH_COMMAND|GIT_SSH|GIT_EDITOR|GIT_SEQUENCE_EDITOR|EDITOR|VISUAL|GIT_ASKPASS|SSH_ASKPASS|GIT_CONFIG_PARAMETERS|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|RIPGREP_CONFIG_PATH|LESSOPEN|LESSCLOSE|BASH_ENV|ENV|LD_PRELOAD)\+?=/;

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
/** Builtins whose NAME=VALUE operands set shell variables, which reach the environment when exported. */
const DECLARING = new Set(['export', 'declare', 'typeset', 'local', 'readonly']);

/**
 * The words of a command that set the environment of what it runs: leading
 * NAME=VALUE words (as a wrapper such as `sudo` passes them on), the
 * NAME=VALUE operands of `env` after its options, and the assignment
 * operands of `export`, `declare`, `typeset`, `local` and `readonly`. Other
 * arguments are data, so `printf '%s' GIT_PAGER=cat` sets nothing.
 */
function environmentWords(argv: readonly string[]): string[] {
  const leading: string[] = [];
  let i = 0;
  while (i < argv.length && ASSIGNMENT.test(argv[i] ?? '')) leading.push(argv[i++] ?? '');
  const program = argv[i] === undefined ? '' : (executableLookupKey(argv[i] ?? '', process.platform) ?? argv[i] ?? '');
  const operands = argv.slice(i + 1);
  if (DECLARING.has(program)) return [...leading, ...operands.filter((w) => ASSIGNMENT.test(w))];
  if (program !== 'env') return leading;
  const set: string[] = [];
  for (let k = 0; k < operands.length; k++) {
    const w = operands[k] ?? '';
    if (w === '--') continue;
    if (w === '-u' || w === '--unset' || w === '-C' || w === '--chdir' || w === '-S' || w === '--split-string') {
      k++;
      continue;
    }
    if (w.startsWith('-')) continue;
    if (!ASSIGNMENT.test(w)) break;
    set.push(w);
  }
  return [...leading, ...set];
}

/** git subcommands that never run their arguments as commands. */
const GIT_DATA_SUBCOMMANDS = new Set(['add', 'blame', 'branch', 'commit', 'diff', 'log', 'mv', 'reset', 'restore', 'rm', 'show', 'stash', 'status', 'switch', 'tag']);
/** Programs that read or print their arguments and never run them. */
const DATA_PROGRAMS = new Set(['cat', 'echo', 'egrep', 'fgrep', 'grep', 'head', 'ls', 'mkdir', 'printf', 'tail', 'touch', 'wc']);

/**
 * Whether a command's arguments are data, never a command line: printers and
 * readers, `rg` without `--pre`, and `git` with a subcommand that runs
 * nothing given directly (no global option such as `-c`, which can define an
 * alias that runs a shell command).
 */
function argumentsAreData(argv: readonly string[]): boolean {
  const program = executableLookupKey(argv[0] ?? '', process.platform) ?? argv[0] ?? '';
  if (DATA_PROGRAMS.has(program)) return true;
  if (program === 'rg') return !argv.some((a) => a.startsWith('--pre'));
  if (program === 'git') return GIT_DATA_SUBCOMMANDS.has(argv[1] ?? '');
  return false;
}

/** The program a command-line argument would start, e.g. `rm` for `'rm -rf x'`. */
function firstShellWord(word: string): string {
  return shlexSplit(word)?.[0] ?? /^\s*(\S+)/.exec(word)?.[1] ?? '';
}

export function isBashExecutor(shell: BashShell): boolean {
  const base = path.basename(shell.path.replace(/\\/g, '/')).toLowerCase();
  return path.isAbsolute(shell.path) && (base === 'bash' || base === 'bash.exe') && shell.args.length === 1 && shell.args[0] === '-c';
}

/**
 * Static decision for a shell command (exec policy rules plus Codex
 * heuristics). `executor` is the argv prefix that runs the command; a script
 * Codex would not split is also evaluated as that argv.
 */
export function checkShellCommand(command: string, p: CodexPolicy, executor?: readonly string[]): Decision {
  let split;
  try {
    split = splitShellCommands(command);
  } catch (err) {
    const why = err instanceof ShellParseError ? err.message : String(err);
    return { kind: 'deny', source: 'rule', reason: `the command cannot be parsed for the Codex exec policy: ${why}` };
  }
  const commands = [...split.commands];
  // Codex evaluates a script it cannot split as the single argv `bash -lc <script>`;
  // the argv that really runs it is evaluated too.
  if (!split.plain) {
    commands.push(['bash', '-lc', command]);
    if (executor !== undefined) commands.push([...executor, command]);
  }

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
  if (split.unsure.length > 0) unmatchedAsk ??= `cannot tell which command runs behind a wrapper (${split.unsure[0] ?? ''})`;
  // A variable that makes a program start another command (a pager, an editor, a config path) runs a command this check does not see.
  const setsCommand = [...split.assignments, ...split.commands.flatMap(environmentWords)].find((w) => COMMAND_VARIABLES.test(w));
  if (setsCommand !== undefined) unmatchedAsk ??= `${setsCommand.split('=')[0] ?? ''} makes a program start a command this check cannot see`;
  // A forbidden or prompted program given as a whole argument may run through a wrapper this splitter does not model.
  const guarded = new Set(p.rules.rules.filter((r) => r.decision !== 'allow').map((r) => executableLookupKey(r.program, process.platform) ?? r.program));
  if (guarded.size > 0) {
    const isGuarded = (word: string): boolean => guarded.has(executableLookupKey(word, process.platform) ?? word);
    for (const argv of split.commands) {
      // An argument may also be a whole command line for a program this splitter does not model (`watch 'rm x'`, `ssh host 'rm x'`).
      const data = argumentsAreData(argv);
      // `--opt=rm x` and `key=rm x` carry the command line after the `=`.
      const commandLines = (word: string): string[] => (word.includes('=') ? [word, word.slice(word.indexOf('=') + 1)] : [word]);
      const hit = argv.slice(1).find((word) => isGuarded(word) || (!data && commandLines(word).some((line) => isGuarded(firstShellWord(line)))));
      if (hit !== undefined) {
        unmatchedAsk ??= `${hit} appears as an argument of ${argv[0] ?? ''}, which may run it in a way this check does not model`;
        break;
      }
    }
  }
  for (const argv of split.dynamic) {
    const program = argv[0] ?? '';
    const base = path.basename(program);
    const relevant = /[$`*?[{~]/.test(program) || ['rm', 'sudo', 'env'].includes(base) || p.rules.rules.some((r) => r.program === program || r.program === base);
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

export function codexToolTimeoutSec(cwd: string, serverName: string, io?: ConfigIo): number | undefined {
  let merged;
  try {
    merged = loadCodexConfig(cwd, io ?? codexSessionIo()).merged;
  } catch {
    return undefined;
  }
  const servers = getPath(merged, ['mcp_servers']);
  if (!isTable(servers) || !Object.hasOwn(servers, serverName)) return undefined;
  const entry = servers[serverName];
  const value = isTable(entry) && Object.hasOwn(entry, 'tool_timeout_sec') ? entry['tool_timeout_sec'] : undefined;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
