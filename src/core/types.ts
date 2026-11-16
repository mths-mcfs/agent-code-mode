/**
 * Frozen contracts shared by every part of agent-code-mode.
 *
 * The sandbox (src/sandbox), the host adapters (src/hosts/*), the tool runtime
 * (src/tools) and the benchmark are built against these types without seeing
 * each other. Changing a type here is a cross-part change: do it in its own PR.
 *
 * Pipeline for every binding call made by a script:
 *   sandbox → Dispatcher.dispatch(tool, args)
 *     1. parse    : `parseToolCall` validates the raw args (schemas.ts).
 *     2. prepare  : `ToolRuntime.prepare` resolves paths and computes the exact
 *                   effect, with no side effect. Result is a deep-frozen
 *                   `PreparedCall`.
 *     3. authorize: `HostAdapter.checkStatic` (permission rules), then
 *                   `HostAdapter.authorize` (the host's PreToolUse hooks).
 *                   If a hook returns `updatedArgs`, the call is re-parsed,
 *                   re-prepared and re-checked statically (hooks are not re-run).
 *     4. commit   : `ToolRuntime.commit` executes exactly the prepared effect,
 *                   re-checking content hashes first.
 */

/** Names of the bindings a script can call. */
export type ToolName = 'bash' | 'read' | 'write' | 'edit' | 'grep' | 'glob';

/** Tools that change state. They are serialized per run, in call order. */
export type MutatingToolName = 'bash' | 'write' | 'edit';

/** Tools that only read. They may run concurrently. */
export type ReadOnlyToolName = 'read' | 'grep' | 'glob';

// ---------------------------------------------------------------------------
// Arguments, as the script passes them (camelCase).
// ---------------------------------------------------------------------------

/** `bash(args)`: run a shell command. */
export interface BashArgs {
  /** Shell command line, run with the platform shell. */
  readonly command: string;
  /** Working directory; relative paths resolve against the session cwd. Defaults to the session cwd. */
  readonly cwd?: string;
  /** Per-command timeout in milliseconds. The tool runtime applies its default when absent. */
  readonly timeoutMs?: number;
}

/** `read(args)`: read a text file. */
export interface ReadArgs {
  /** File path; relative paths resolve against the session cwd. */
  readonly path: string;
  /** 1-based line number of the first line to return. Defaults to 1. */
  readonly offset?: number;
  /** Maximum number of lines to return. The tool runtime applies its default when absent. */
  readonly limit?: number;
}

/** `write(args)`: create or overwrite a file with the given content. */
export interface WriteArgs {
  /** File path; relative paths resolve against the session cwd. */
  readonly path: string;
  /** Full new content of the file. */
  readonly content: string;
}

/** `edit(args)`: replace text in an existing file. */
export interface EditArgs {
  /** File path; relative paths resolve against the session cwd. */
  readonly path: string;
  /** Text to find. Must be non-empty. */
  readonly oldString: string;
  /** Replacement text. */
  readonly newString: string;
  /** Replace every occurrence instead of requiring exactly one. Defaults to false. */
  readonly replaceAll?: boolean;
}

/** `grep(args)`: search file contents with a regular expression. */
export interface GrepArgs {
  /** Regular expression (the tool runtime documents the dialect). */
  readonly pattern: string;
  /** File or directory to search. Defaults to the session cwd. */
  readonly path?: string;
  /** Glob that filters which files are searched, e.g. `*.ts`. */
  readonly glob?: string;
  /** Case-insensitive match. Defaults to false. */
  readonly ignoreCase?: boolean;
  /** Maximum number of matches returned. The tool runtime applies its default when absent. */
  readonly maxResults?: number;
}

/** `glob(args)`: list files matching a glob pattern. */
export interface GlobArgs {
  /** Glob pattern, e.g. `src/**\/*.ts`. */
  readonly pattern: string;
  /** Directory to search from. Defaults to the session cwd. */
  readonly path?: string;
  /** Maximum number of files returned. The tool runtime applies its default when absent. */
  readonly maxResults?: number;
}

/** Maps each tool to its argument type. */
export interface ToolArgsMap {
  readonly bash: BashArgs;
  readonly read: ReadArgs;
  readonly write: WriteArgs;
  readonly edit: EditArgs;
  readonly grep: GrepArgs;
  readonly glob: GlobArgs;
}

/**
 * A validated binding call. `id` is assigned by the dispatcher in call order:
 * `c1`, `c2`, ... It is unique within one run.
 */
export type ToolCall = {
  [K in ToolName]: { readonly id: string; readonly tool: K; readonly args: ToolArgsMap[K] };
}[ToolName];

// ---------------------------------------------------------------------------
// Results, as the script receives them.
// ---------------------------------------------------------------------------

/** Result of `bash`. A non-zero exit code is a result, not an error. */
export interface BashResult {
  /** Exit code, or null when the process was killed by a signal. */
  readonly exitCode: number | null;
  /** Signal name that killed the process, or null. */
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  /** True when stdout or stderr was cut to the tool runtime's cap. */
  readonly truncated: boolean;
  /** True when the command hit its timeout and was killed. */
  readonly timedOut: boolean;
}

/** Result of `read`. */
export interface ReadResult {
  /** Real path that was read; the script sees it relative to the session cwd when inside it. */
  readonly path: string;
  /** Exact text of the returned lines: each keeps its newline, except a last line the file leaves unterminated. */
  readonly content: string;
  /** 1-based line number of the first returned line. */
  readonly startLine: number;
  /** Number of lines in the whole file. */
  readonly totalLines: number;
  /** True when lines after the returned window exist or long lines were cut. */
  readonly truncated: boolean;
}

/** Result of `write`. */
export interface WriteResult {
  /** Real path that was written; the script sees it relative to the session cwd when inside it. */
  readonly path: string;
  /** True when the file did not exist before. */
  readonly created: boolean;
  /** Unified diff of the change. */
  readonly diff: string;
}

/**
 * How `edit` located `oldString`: the rung of the tolerant-match ladder that
 * found it, tried in this order. `exact` is a byte-for-byte match;
 * `line-endings` ignores CRLF/LF differences; `line-numbers` strips line
 * numbers copied from `read` output; `trailing-whitespace` ignores spaces at
 * line ends; `indentation` ignores a uniform indentation shift; `punctuation`
 * folds typographic quotes and dashes to ASCII.
 */
export type MatchStrategy = 'exact' | 'line-endings' | 'line-numbers' | 'trailing-whitespace' | 'indentation' | 'punctuation';

/** Result of `edit`. */
export interface EditResult {
  /** Real path that was edited; the script sees it relative to the session cwd when inside it. */
  readonly path: string;
  /** Number of occurrences replaced. */
  readonly replacements: number;
  readonly matchStrategy: MatchStrategy;
  /** Unified diff of the change. */
  readonly diff: string;
}

/** One `grep` match. */
export interface GrepMatch {
  /** Real path of the file; the script sees it relative to the session cwd when inside it. */
  readonly file: string;
  /** 1-based line number. */
  readonly line: number;
  /** The matching line (may be cut by the tool runtime). */
  readonly text: string;
}

/** Result of `grep`. */
export interface GrepResult {
  readonly matches: readonly GrepMatch[];
  /** True when more matches existed than were returned. */
  readonly truncated: boolean;
  /** Files left out of the search because the host's Read rules deny them (`PolicySnapshot.readFilter`). */
  readonly filtered: number;
}

/** Result of `glob`. */
export interface GlobResult {
  /** Real paths; the script sees them relative to the session cwd when inside it. */
  readonly files: readonly string[];
  /** True when more files existed than were returned. */
  readonly truncated: boolean;
  /** Entries left out because the host's Read rules deny them (`PolicySnapshot.readFilter`). */
  readonly filtered: number;
}

/** Maps each tool to its result type. */
export interface ToolResultMap {
  readonly bash: BashResult;
  readonly read: ReadResult;
  readonly write: WriteResult;
  readonly edit: EditResult;
  readonly grep: GrepResult;
  readonly glob: GlobResult;
}

/** Any tool result. */
export type ToolResult = ToolResultMap[ToolName];

// ---------------------------------------------------------------------------
// Prepared calls: the exact effect that is authorized and then committed.
// ---------------------------------------------------------------------------

/**
 * How `bash` is contained. `none` runs the command directly. `sandbox` runs it
 * inside an OS sandbox that the tool runtime must enforce: if it cannot,
 * `prepare` must throw `ToolError('containment-unavailable')`.
 */
export type BashContainment =
  | { readonly mode: 'none' }
  | {
      readonly mode: 'sandbox';
      /** No writes at all when true; `writableRoots` is then ignored. */
      readonly readOnly: boolean;
      /** Absolute directories the command may write to. */
      readonly writableRoots: readonly string[];
      /** Whether network access is allowed. */
      readonly network: boolean;
    };

/** Effect of a `bash` call. */
export interface BashEffect {
  readonly command: string;
  /** Absolute real working directory. */
  readonly cwd: string;
  /** Effective timeout in milliseconds. */
  readonly timeoutMs: number;
  /** Containment the tool runtime will enforce; must equal the policy's `bashContainment`. */
  readonly containment: BashContainment;
}

/** Effect of a `read` call. */
export interface ReadEffect {
  readonly absPath: string;
  /** Effective 1-based offset. */
  readonly offset: number;
  /** Effective line limit. */
  readonly limit: number;
}

/** Effect of a `write` call. */
export interface WriteEffect {
  readonly absPath: string;
  /** SHA-256 hex of the current content, or null when the file does not exist. */
  readonly beforeHash: string | null;
  readonly afterContent: string;
  /** Unified diff between the current and the new content. */
  readonly diff: string;
}

/** Effect of an `edit` call, computed against the current file content. */
export interface EditEffect {
  readonly absPath: string;
  /** SHA-256 hex of the content the edit was computed against. */
  readonly beforeHash: string;
  readonly afterContent: string;
  readonly diff: string;
  /** The exact text that was matched in the file (may differ from `oldString` with tolerant strategies). */
  readonly matchedOldString: string;
  readonly matchStrategy: MatchStrategy;
  readonly replacements: number;
}

/** Effect of a `grep` call. */
export interface GrepEffect {
  /** Absolute real file or directory searched. */
  readonly absRoot: string;
  readonly pattern: string;
  readonly glob: string | null;
  readonly ignoreCase: boolean;
  readonly maxResults: number;
}

/** Effect of a `glob` call. */
export interface GlobEffect {
  /** Absolute real directory searched from. */
  readonly absRoot: string;
  readonly pattern: string;
  readonly maxResults: number;
}

/** Maps each tool to its effect type. */
export interface ToolEffectMap {
  readonly bash: BashEffect;
  readonly read: ReadEffect;
  readonly write: WriteEffect;
  readonly edit: EditEffect;
  readonly grep: GrepEffect;
  readonly glob: GlobEffect;
}

/**
 * A call after `ToolRuntime.prepare`: validated, normalized args (paths are
 * absolute real paths inside the workspace) plus the exact effect. The
 * dispatcher deep-freezes it; nobody may mutate it.
 *
 * What a host adapter shows to the host's hooks (the native-shaped payload,
 * e.g. Claude `Write {file_path, content}` or Codex `apply_patch {command}`)
 * is NOT part of this type: each adapter derives it from the `PreparedCall`,
 * so the adapter owns that mapping. The payload shown must describe exactly
 * the effect here.
 */
export type PreparedCall = {
  [K in ToolName]: {
    readonly id: string;
    readonly tool: K;
    readonly args: ToolArgsMap[K];
    readonly effect: ToolEffectMap[K];
    /**
     * The `path` argument exactly as the script wrote it (before `~`
     * expansion, cwd resolution and symlink resolution), for host rules that
     * must also match the path as written. Absent for `bash` and when grep or
     * glob got no path. Set by the dispatcher from the very call it prepared
     * (any value the tool runtime returns is replaced), so it always names the
     * path that resolved to `effect.absPath` / `effect.absRoot`.
     */
    readonly requestedPath?: string;
  };
}[ToolName];

/** A `PreparedCall` narrowed to one tool. */
export type PreparedCallOf<K extends ToolName> = Extract<PreparedCall, { readonly tool: K }>;

// ---------------------------------------------------------------------------
// Session context and policy.
// ---------------------------------------------------------------------------

/** Which host started the server. */
export type HostKind = 'claude' | 'codex' | 'generic';

/** Where a `SessionContext` field came from. `default` means it was unknown and a conservative default was used. */
export type ContextSource = 'env' | 'meta' | 'roots' | 'ctx-file' | 'default';

/**
 * Who is calling and from where. Built only from host-controlled channels:
 * env, request `_meta`, MCP roots and the companion-hook context file. Fields
 * the model controls (tool arguments, including any `_ctx`) never reach it.
 */
export interface SessionContext {
  readonly host: HostKind;
  /** Absolute workspace directory; relative paths resolve against it. */
  readonly cwd: string;
  /** Absolute workspace roots announced by the client. */
  readonly roots: readonly string[];
  readonly sessionId?: string;
  readonly transcriptPath?: string;
  /** Host permission mode, e.g. Claude `default`, `acceptEdits`, `plan`. Unknown → `default`. */
  readonly permissionMode: string;
  /** Subagent id when called from a subagent (Claude). */
  readonly agentId?: string;
  /** Subagent type when called from a subagent (Claude). */
  readonly agentType?: string;
  /** Host tool-use id of the `run` call (Claude `claudecode/toolUseId`). */
  readonly toolUseId?: string;
  /** Host turn id (Codex). */
  readonly turnId?: string;
  readonly model?: string;
  /** Host sandbox mode (Codex `sandbox_mode`, e.g. `read-only`). */
  readonly sandboxMode?: string;
  /** Source of each field that was set, keyed by field name. */
  readonly sources: Readonly<Record<string, ContextSource>>;
}

/** Why a call was denied. */
export type DenySource =
  | 'rule'
  | 'hook'
  | 'hook-error'
  | 'hook-timeout'
  | 'unsupported-config'
  | 'ask-unavailable'
  | 'containment-unavailable';

/**
 * An authorization decision.
 * - `allow` with `updatedArgs`: a hook rewrote the call. `updatedArgs` is in
 *   this project's camelCase args shape for the same tool (the adapter maps
 *   from the host's native shape). It is untrusted: the dispatcher re-validates,
 *   re-prepares and re-checks it statically.
 * - `ask`: the host would prompt the user. Without an interactive channel the
 *   dispatcher turns it into `deny` with source `ask-unavailable`.
 */
export type Decision =
  | { readonly kind: 'allow'; readonly updatedArgs?: unknown; readonly reason?: string }
  | { readonly kind: 'deny'; readonly reason: string; readonly source: DenySource }
  | { readonly kind: 'ask'; readonly reason: string };

/**
 * The host policy loaded once per run. `payload` is adapter-specific and
 * opaque to the dispatcher.
 */
export interface PolicySnapshot<P = unknown> {
  readonly host: HostKind;
  /** Containment the tool runtime must enforce on every `bash` call. */
  readonly bashContainment: BashContainment;
  /**
   * Absolute path patterns the script must never write or edit: host policy
   * and hook files (e.g. `<cwd>/.claude/settings*.json`, `<cwd>/.claude/hooks/**`,
   * `<home>/.claude/**`, `<cwd>/.codex/**`, `<home>/.codex/**`, `<cwd>/.mcp.json`)
   * and the server state dir. `*` matches inside one path segment, `**` any
   * depth (see `matchesPathPattern`). The adapter returns its host's list; the
   * tool runtime refuses writes and edits there with `ToolError('protected-path')`.
   */
  readonly protectedPaths: readonly string[];
  /**
   * The host's additional working directories (e.g. Claude
   * `permissions.additionalDirectories`, `--add-dir`): absolute directories
   * the tools may touch besides the session cwd and roots.
   */
  readonly additionalRoots?: readonly string[];
  /**
   * Whether a real absolute path is readable under the host's Read rules.
   * The tool runtime applies it to every grep match and glob entry and drops
   * the ones it returns false for, counting them in `filtered`. Absent: every
   * path inside the workspace is readable.
   */
  readonly readFilter?: (realAbsPath: string) => boolean;
  readonly payload: P;
}

/** Returned by `HostAdapter.loadPolicy` when the host config cannot be understood. Every call is then denied with `unsupported-config`. */
export interface PolicyLoadError {
  readonly error: string;
}

/** Input of `ContextProvider.resolve`. `meta` is the raw, unvalidated request `_meta`. */
export interface ContextInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly meta: unknown;
  readonly roots: readonly string[];
  readonly serverCwd: string;
}

/** Builds the `SessionContext` of one `run` call from host channels. */
export interface ContextProvider {
  resolve(input: ContextInput): Promise<SessionContext>;
}

/**
 * A record written by the companion PreToolUse hook (Claude) for one `run`
 * call, keyed by the host's tool-use id. Fields mirror the hook input.
 */
export interface HookContextRecord {
  readonly sessionId: string;
  readonly toolUseId: string;
  readonly cwd?: string;
  readonly transcriptPath?: string;
  readonly permissionMode?: string;
  readonly agentId?: string;
  readonly agentType?: string;
}

/**
 * Reads companion-hook context records. The implementation (P2) validates the
 * file at the boundary and returns undefined when there is no valid record.
 */
export interface HookContextStore {
  lookup(toolUseId: string): Promise<HookContextRecord | undefined>;
}

/**
 * Host adapter: reproduces how the host authorizes a native tool call.
 * Implementations must be fail-closed: an error in a hook is a deny.
 */
export interface HostAdapter<P = unknown> {
  readonly host: HostKind;
  /** Loads the host's permission rules and hooks for this context. */
  loadPolicy(ctx: SessionContext): Promise<PolicySnapshot<P> | PolicyLoadError>;
  /**
   * The host's static permission rules (deny → ask → allow) applied to the
   * prepared call. `allow` means "no rule denies or asks". Must not do I/O.
   */
  checkStatic(prepared: PreparedCall, ctx: SessionContext, policy: PolicySnapshot<P>): Decision;
  /**
   * Runs the host's PreToolUse hooks on the prepared call. Must honor
   * `signal` (kill running hooks). Only called after `checkStatic` allowed.
   */
  authorize(
    prepared: PreparedCall,
    ctx: SessionContext,
    policy: PolicySnapshot<P>,
    signal: AbortSignal,
  ): Promise<Decision>;
  /**
   * Optional PostToolUse hooks. Errors are reported as warnings, never change
   * the result. Must honor `signal` (kill running hooks); the dispatcher stops
   * waiting when it aborts.
   */
  postToolUse?(
    prepared: PreparedCall,
    result: ToolResult,
    ctx: SessionContext,
    policy: PolicySnapshot<P>,
    signal: AbortSignal,
  ): Promise<void>;
}

/** Outcome of rolling back a transaction. */
export interface RollbackReport {
  /** Absolute paths restored to their content before the run (or deleted when they did not exist). */
  readonly restored: readonly string[];
  /** Files not restored, with the reason. `changed-externally`: the file no longer holds what this run wrote. */
  readonly skipped: readonly { readonly path: string; readonly reason: 'changed-externally' | 'error'; readonly detail?: string }[];
}

/** A per-run journal of file writes and edits. */
export interface Transaction {
  /** Restores every journaled file whose content is still what this run wrote. */
  rollback(): Promise<RollbackReport>;
  /** Releases the journal (keeps the changes). Idempotent. */
  dispose(): Promise<void>;
}

/** Executes tool calls. Implemented by src/tools (P4) and `MemoryToolRuntime` (tests). */
export interface ToolRuntime<P = unknown> {
  /**
   * Validates semantics, resolves paths to absolute real paths inside the
   * workspace, refuses protected paths, and computes the exact effect against
   * the current file content. No side effect. Throws `ToolError` on refusal.
   * The returned call keeps `call.id` and `call.tool`.
   */
  prepare(call: ToolCall, ctx: SessionContext, policy: PolicySnapshot<P>): Promise<PreparedCall>;
  /**
   * Executes exactly `prepared.effect`. For write/edit it first re-checks
   * `beforeHash` and throws `ToolError('stale')` if the file changed. When
   * `tx` is given, file changes are journaled in it. Must honor `signal`:
   * not start when already aborted, and stop a running `bash`.
   */
  commit(prepared: PreparedCall, signal: AbortSignal, tx?: Transaction): Promise<ToolResult>;
  /** Starts a journal for one transactional run. */
  beginTransaction(): Transaction;
}

// ---------------------------------------------------------------------------
// Sandbox.
// ---------------------------------------------------------------------------

/** Console level of a script log line. */
export type LogLevel = 'log' | 'info' | 'warn' | 'error';

/** Code of a `BindingError`. */
export type BindingErrorCode =
  | 'denied'
  | 'invalid-args'
  | 'outside-workspace'
  | 'protected-path'
  | 'not-found'
  | 'stale'
  | 'cancelled'
  | 'tool-error';

/**
 * Serialized error of a failed binding call. The sandbox (P1) rehydrates it as
 * a rejected Promise with an `Error` whose `name` is `PermissionDenied`
 * (carrying `source` and `reason` = `message`) or `ToolError` (carrying `code`).
 */
export type BindingError =
  | { readonly name: 'PermissionDenied'; readonly message: string; readonly code: 'denied'; readonly source: DenySource }
  | { readonly name: 'ToolError'; readonly message: string; readonly code: Exclude<BindingErrorCode, 'denied'> };

/** Reply to one binding call. Never thrown: the dispatcher always resolves. */
export type CallReply =
  | { readonly ok: true; readonly value: ToolResult }
  | { readonly ok: false; readonly error: BindingError };

/** Options of `Sandbox.run`. */
export interface SandboxRunOptions {
  /** Wall-clock limit; the sandbox kills the script when it is reached. */
  readonly timeoutMs: number;
  /** Memory limit of the script heap. */
  readonly memoryBytes: number;
  /** Aborting it kills the script (cancel, timeout, transaction abort). */
  readonly signal: AbortSignal;
  /**
   * Called for every binding call. `tool` and `args` come from the script and
   * are untrusted. Always resolves.
   */
  onCall(tool: string, args: unknown): Promise<CallReply>;
  /** Called for every console line of the script. */
  onLog(level: LogLevel, text: string): void;
}

/** Serialized script error. */
export interface ScriptError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
}

/**
 * What a script run ended with. `value` is the script's `return` value as
 * plain JSON data (the sandbox converts it).
 */
export type SandboxOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly kind: 'error' | 'timeout' | 'oom' | 'killed'; readonly error: ScriptError };

/** Runs a script body as an async function with the bindings as globals. */
export interface Sandbox {
  run(code: string, opts: SandboxRunOptions): Promise<SandboxOutcome>;
}

// ---------------------------------------------------------------------------
// Run request and result.
// ---------------------------------------------------------------------------

/** A validated `run` request with defaults applied. */
export interface RunRequest {
  /** Script body (JavaScript). */
  readonly code: string;
  /** Roll back file changes on error, timeout, cancel or any denied call. */
  readonly transaction: boolean;
  /** Effective timeout in milliseconds, already clamped. */
  readonly timeoutMs: number;
}

/** One entry of the call log returned to the model. */
export interface CallLogEntry {
  readonly id: string;
  /** The tool name as the script passed it (may be unknown). */
  readonly tool: string;
  /** Short human-readable description, e.g. `write src/a.ts`. */
  readonly summary: string;
  readonly decision: 'allowed' | 'denied' | 'error';
  readonly reason?: string;
  readonly durationMs: number;
}

/** Error part of a failed `RunResult`. */
export interface RunError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  /** What ended the run. */
  readonly kind: 'error' | 'timeout' | 'oom' | 'killed' | 'cancelled' | 'denied' | 'internal';
}

/** The result of one `run`. */
export interface RunResult {
  readonly ok: boolean;
  /** The script's return value when `ok`. */
  readonly result?: unknown;
  readonly error?: RunError;
  /** Console output, one entry per line, prefixed with the level when not `log`. */
  readonly logs: readonly string[];
  readonly calls: readonly CallLogEntry[];
  /** Files written or edited by committed calls (paths relative to the session cwd when inside it). */
  readonly changedFiles: readonly string[];
  /** Combined unified diff of committed writes and edits, in commit order. */
  readonly diff: string;
  /** Present when a transaction was rolled back. */
  readonly rolledBack?: RollbackReport;
  /** Notes the model must know, e.g. bash effects that were not rolled back. */
  readonly warnings: readonly string[];
  /** Set by output shaping when the full result was written to a file. */
  readonly overflowPath?: string;
}
