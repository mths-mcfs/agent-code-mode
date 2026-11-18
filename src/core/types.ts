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
 *
 * `mcpCall` (binding `mcp`) takes the same path with `McpRuntime` in place of
 * the tool runtime: parsed against the catalog of upstream tools, prepared
 * into a `PreparedMcpCall`, authorized by the same adapter, then sent.
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
  /**
   * The command that ran, present only when it is not the one the script
   * passed: its globs were expanded to the literal list of files before it was
   * authorized (see `BashEffect.expansion`).
   */
  readonly command?: string;
  /** The last bytes of stdout, present only when stdout was cut: test summaries come at the end of the output. */
  readonly stdoutTail?: string;
  /** The last bytes of stderr, present only when stderr was cut. */
  readonly stderrTail?: string;
  /** Bytes of stdout between `stdout` and `stdoutTail` that were not kept; 0 means the two join exactly. */
  readonly stdoutOmitted?: number;
  /** Bytes of stderr between `stderr` and `stderrTail` that were not kept; 0 means the two join exactly. */
  readonly stderrOmitted?: number;
  /** The end of both streams in the order they arrived, present only when both produced output. */
  readonly outputTail?: string;
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

/** `grep` result as the script sees it: one row per match, paths relative to the session cwd when inside it. */
export interface ScriptGrepResult {
  readonly columns: readonly ['file', 'line', 'text'];
  readonly rows: readonly (readonly [file: string, line: number, text: string])[];
  /** Number of rows. */
  readonly count: number;
  readonly truncated: boolean;
  readonly filtered: number;
}

/** What `readOverflow(id, offset?, limit?)` resolves to: a slice of a result a response cut. */
export interface OverflowSlice {
  readonly text: string;
  /** Character offset of `text` in the kept result. */
  readonly offset: number;
  readonly totalChars: number;
  /** True when the kept result goes on after `text`. */
  readonly truncated: boolean;
}

/** A file `undo` left as it was, and why. */
export interface UndoSkip {
  readonly path: string;
  readonly reason: string;
}

/** What `undo(undoId)` resolves to. Paths are relative to the session cwd when inside it. */
export interface UndoResult {
  /** Files put back to their content before the run. */
  readonly restored: readonly string[];
  /** Files the run created, removed again. */
  readonly removed: readonly string[];
  /** Directories the run created, removed again (only empty ones). */
  readonly removedDirs: readonly string[];
  readonly skipped: readonly UndoSkip[];
  /** `bash` calls the run made: their effects are not undone. */
  readonly bashCalls: number;
  /** `mcpCall`s the run sent: their effects are not undone. */
  readonly mcpCalls: number;
}

/** A binding's resolved value as the script receives it. */
export type ScriptValue = Exclude<ToolResult, GrepResult> | ScriptGrepResult | OverflowSlice | McpResult | UndoResult;

// ---------------------------------------------------------------------------
// Upstream MCP tools: `mcpCall(server, tool, args)`.
// ---------------------------------------------------------------------------

declare const mcpNameBrand: unique symbol;

/**
 * A configured upstream server name that passed the name rules (see
 * src/mcp/names.ts). Only the catalog of servers discovered at start mints
 * one, so a value of this type always names a server in that catalog.
 */
export type McpServerName = string & { readonly [mcpNameBrand]: 'server' };

/** A tool name of an upstream server that passed the name rules and is in the catalog under its server. */
export type McpToolName = string & { readonly [mcpNameBrand]: 'tool' };

/** Validated `mcpCall` arguments: server and tool are in the catalog, `input` is a JSON object. */
export interface McpArgs {
  readonly server: McpServerName;
  readonly tool: McpToolName;
  /** The tool arguments, sent to the upstream server as given. */
  readonly input: Readonly<Record<string, unknown>>;
  /** Per-call timeout in milliseconds. The MCP runtime applies its default when absent. */
  readonly timeoutMs?: number;
}

/** A validated `mcpCall` (binding name `mcp`). */
export interface McpCall {
  readonly id: string;
  readonly tool: 'mcp';
  readonly args: McpArgs;
}

/** Effect of an `mcpCall`: exactly what is sent upstream. An external effect: never rolled back. */
export interface McpEffect {
  readonly server: McpServerName;
  readonly tool: McpToolName;
  /** The host's name of the tool, `mcp__<server>__<tool>`. */
  readonly qualifiedName: string;
  readonly input: Readonly<Record<string, unknown>>;
  /** Effective timeout in milliseconds. */
  readonly timeoutMs: number;
}

/** An `mcpCall` after `McpRuntime.prepare`. */
export interface PreparedMcpCall {
  readonly id: string;
  readonly tool: 'mcp';
  readonly args: McpArgs;
  readonly effect: McpEffect;
}

/**
 * Result of `mcpCall`, as the script receives it: the upstream
 * `structuredContent` when there is one, else the text of its content blocks
 * joined, plus `isError`. A result over the size cap is cut: `truncated` is
 * set, `text` holds the start of the whole result's text (the content text or
 * the `structuredContent` JSON), and `overflow` names where `readOverflow`
 * reads all of it, or `warning` says it could not be kept.
 */
export interface McpResult {
  readonly isError: boolean;
  readonly structuredContent?: unknown;
  readonly text?: string;
  readonly truncated?: true;
  readonly overflow?: { readonly id: string; readonly chars: number };
  readonly warning?: string;
}

/**
 * Serves `mcpCall` for one server process: the catalog of upstream tools
 * found at start and the connections to their servers.
 */
export interface McpRuntime {
  /**
   * Validates untrusted `mcpCall` arguments against the catalog. `server` and
   * `tool` must name a cataloged tool; `args` must be a JSON object.
   */
  parse(args: unknown, id: string): { readonly ok: true; readonly call: McpCall } | { readonly ok: false; readonly message: string };
  /** Computes the effect, with no side effect. */
  prepare(call: McpCall): PreparedMcpCall;
  /**
   * Sends the call upstream and shapes the result. Throws `ToolError` when
   * the call fails, times out (effect unknown: never retried) or is cancelled
   * through `signal`. `onSent` is called once, when the request is written
   * to the server (a call refused before that, e.g. on a closed connection,
   * never calls it).
   */
  commit(prepared: PreparedMcpCall, signal: AbortSignal, onSent?: () => void): Promise<McpResult>;
}

/** Any validated binding call that goes through the dispatcher. */
export type BindingCall = ToolCall | McpCall;

/** What a host adapter authorizes: a prepared built-in call or a prepared `mcpCall`. */
export type HostCall = PreparedCall | PreparedMcpCall;

/** A committed call's result, as a host adapter's PostToolUse sees it. */
export type HostResult = ToolResult | McpResult;

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
  /**
   * Present when the script passed a `cwd`: `command` starts with `prefix`,
   * the `cd` to the real directory `dir`, and relative paths of what follows
   * resolve against `dir`.
   */
  readonly startDir?: { readonly dir: string; readonly prefix: string };
  /** Effective timeout in milliseconds. */
  readonly timeoutMs: number;
  /** Containment the tool runtime will enforce; must equal the policy's `bashContainment`. */
  readonly containment: BashContainment;
  /**
   * Present when globs of the command were expanded at prepare (see
   * `PolicySnapshot.planBashExpansion`): `command` then names every file
   * literally, and commit refuses to run it unless each entry still has the
   * identity recorded here.
   */
  readonly expansion?: BashExpansion;
}

/** What a glob expansion of a `bash` command replaced and the entries it named. */
export interface BashExpansion {
  /** The command as it would have run without the expansion. */
  readonly original: string;
  /** Every file or directory the globs expanded to, in command order. */
  readonly entries: readonly BashExpandedEntry[];
}

/** One expanded entry and its identity at prepare. */
export interface BashExpandedEntry {
  /** Absolute path as named in the command (its last component not resolved). */
  readonly path: string;
  /** `dev:ino:type` of the entry itself (lstat, a symbolic link is not followed). */
  readonly identity: string;
  /** `dev:ino:type` of what the command opens (stat, symbolic links followed). */
  readonly targetIdentity: string;
}

/**
 * Where a host can expand the globs of a `bash` command (built by the host
 * adapter, which owns the shell parser; the tool runtime does the I/O).
 * `globs` lists each glob word to expand; `render` returns the command with
 * the i-th glob replaced by `matches[i]` (paths relative to the command's cwd,
 * in the order given).
 */
export interface BashGlobPlan {
  readonly globs: readonly BashGlob[];
  render(matches: readonly (readonly string[])[]): string;
}

/** One glob word of a `bash` command. */
export interface BashGlob {
  /** The word as written: literal text, quotes and glob characters only. */
  readonly raw: string;
  /** Whether a match may be a directory (`ls`); otherwise only regular files. */
  readonly directories: boolean;
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
  /**
   * Real path of this server process's scratch directory, set by the run for
   * adapters with `usesScratch`. Never comes from the model or the client.
   */
  readonly scratchDir?: string;
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
   * Absolute path patterns (same syntax as `protectedPaths`) the tool runtime
   * fingerprints around every `bash` call, to report changes there in
   * `warnings`: the host policy files the adapter reads and the server state
   * dir. Absent: `protectedPaths`. Each pattern must start with a literal
   * absolute directory, and the set must stay small (it is read before every
   * `bash` call); detection only, it never blocks a write.
   */
  readonly watchedPaths?: readonly string[];
  /**
   * Changes in the watched paths that are routine for this host and not worth
   * a warning (Claude: a new, well-formed companion-hook context record).
   * Called only for changes agent-code-mode's own writes do not explain.
   */
  readonly isRoutineWatchedChange?: (change: WatchedChange) => Promise<boolean>;
  /**
   * The host's additional working directories (e.g. Claude
   * `permissions.additionalDirectories`, `--add-dir`): absolute directories
   * the tools may touch besides the session cwd and roots.
   */
  readonly additionalRoots?: readonly string[];
  /**
   * Real path of the scratch directory this policy opens (`ctx.scratchDir`):
   * a root for the tools, and the only part of the protected state dir that
   * may be written. Files in it are never reported as changed, journaled or
   * undone. Absent: no scratch directory.
   */
  readonly scratchRoot?: string;
  /**
   * Whether a real absolute path is readable under the host's Read rules.
   * The tool runtime applies it to every grep match and glob entry and drops
   * the ones it returns false for, counting them in `filtered`. Absent: every
   * path inside the workspace is readable.
   */
  readonly readFilter?: (realAbsPath: string) => boolean;
  /**
   * Plans the expansion of globs in a `bash` command (relative patterns read
   * by a known pure reader such as `cat` or `wc`). Undefined, or a result of
   * undefined, leaves the command as written. The tool runtime expands the
   * plan at prepare against the command's cwd and validates every match.
   */
  readonly planBashExpansion?: (command: string) => BashGlobPlan | undefined;
  readonly payload: P;
}

/** One path that differs between two snapshots of the watched paths (undefined side: absent). */
export interface WatchedChange {
  readonly path: string;
  readonly before?: { readonly type: 'file' | 'dir' | 'symlink' | 'other'; readonly mode: number };
  readonly after?: { readonly type: 'file' | 'dir' | 'symlink' | 'other'; readonly mode: number };
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
 * Implementations must be fail-closed: an error in a hook is a deny. An
 * adapter that cannot authorize `mcpCall` (a `PreparedMcpCall`) must deny it.
 */
export interface HostAdapter<P = unknown> {
  readonly host: HostKind;
  /** True when the adapter applies `ctx.scratchDir` to its policy; without it a run gets no scratch directory. */
  readonly usesScratch?: boolean;
  /** Loads the host's permission rules and hooks for this context. */
  loadPolicy(ctx: SessionContext): Promise<PolicySnapshot<P> | PolicyLoadError>;
  /**
   * The host's static permission rules (deny → ask → allow) applied to the
   * prepared call. `allow` means "no rule denies or asks". Must not do I/O.
   */
  checkStatic(prepared: HostCall, ctx: SessionContext, policy: PolicySnapshot<P>): Decision;
  /**
   * Optional refusals that need I/O (symlinks resolved): runs before
   * `checkStatic`, so an ask rule cannot turn them into a question. Resolves
   * to a `deny` or to undefined; anything else is treated as a deny.
   */
  checkResolved?(prepared: HostCall, ctx: SessionContext, policy: PolicySnapshot<P>): Promise<Decision | undefined>;
  /**
   * Runs the host's PreToolUse hooks on the prepared call. Must honor
   * `signal` (kill running hooks). Only called after `checkStatic` allowed.
   */
  authorize(
    prepared: HostCall,
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
    prepared: HostCall,
    result: HostResult,
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
  commit(prepared: PreparedCall, signal: AbortSignal, tx?: Transaction, observer?: CommitObserver): Promise<ToolResult>;
  /** Starts a journal for one transactional run. */
  beginTransaction(): Transaction;
  /** This server process's scratch directory (real path), created on the first call. */
  scratchDir?(): Promise<string>;
  /** Starts recording what one run's writes and edits replace, for `undo`. */
  beginUndo?(): RunUndo;
  /**
   * Plans the undo of a finished run and reserves its files until
   * `UndoSession.close`. Changes nothing. Throws `ToolError` when `undoId` is
   * unknown, already used or being undone.
   */
  openUndo?(undoId: string, ctx: SessionContext, policy: PolicySnapshot<P>): Promise<UndoSession>;
  /** Removes this server process's scratch and undo directories. Idempotent. */
  closeSession?(): void;
  /**
   * Optional end-of-run check: compares the watched paths with what the last
   * `bash` call of the run (the one committed with `observer`) left, and
   * reports differences through `observer.warn`. Never throws.
   */
  finishRun?(observer: CommitObserver): Promise<void>;
}

/** What a commit may report besides its result (one per run). */
export interface CommitObserver {
  /** Adds a line to the run's `warnings`. */
  warn(message: string): void;
  /** Called when a `bash` process was started, whatever happens to it then. */
  bashStarted?(): void;
  /** Records what the run's writes and edits replace. */
  readonly undo?: RunUndo;
}

/** One file a write is about to change, as found under its path lock. */
export interface UndoCapture {
  readonly absPath: string;
  /** Workspace root that holds the file. */
  readonly root: string;
  /** What the file holds now; null when the write creates it. */
  readonly before: { readonly bytes: Buffer; readonly mode: number; readonly fingerprint: FileFingerprint } | null;
}

/** Which directory a path names. */
export interface DirIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

/** Which file a path names and the state it is in. */
export interface FileFingerprint extends DirIdentity {
  readonly size: bigint;
  /** Permission bits. */
  readonly mode: number;
}

/** What a write left at its path, recorded when it landed. */
export interface CommittedFile extends FileFingerprint {
  readonly sha256: string;
}

/** How one finished run can be undone. */
export interface UndoOutcome {
  /** Absent when the run changed no file or could not be recorded. */
  readonly undoId?: string;
  /** Why a run that changed files got no `undoId`. */
  readonly warning?: string;
}

/** The undo record of one run. A failure to record never fails the write: the run just gets no `undoId`. */
export interface RunUndo {
  /** Called under the file's path lock, before the write. Only the first capture of a file keeps its bytes. */
  capture(file: UndoCapture): Promise<void>;
  /** Called after a write landed, with what it left: the file `undo` expects to find. */
  committed(absPath: string, file: CommittedFile): void;
  /** Called when a write created a directory, whether or not the write then succeeds. */
  dirCreated(dir: string, identity: DirIdentity): void;
  /** Ends the recording and files it under a new `undoId`. */
  finish(stats: { readonly bashCalls: number; readonly mcpCalls: number }): Promise<UndoOutcome>;
  /** Ends the recording and drops it (the run rolled back). */
  discard(): Promise<void>;
}

/** One change an undo makes, shown to the host as the `write` or `bash` call that makes it. */
export interface UndoStep {
  readonly kind: 'restore' | 'remove' | 'rmdir';
  readonly path: string;
  /** The call the host authorizes. */
  readonly call: { readonly tool: 'write'; readonly args: WriteArgs } | { readonly tool: 'bash'; readonly args: BashArgs };
}

/** A planned undo: its files are reserved until `close`. */
export interface UndoSession {
  readonly steps: readonly UndoStep[];
  /** Files left out of the plan, with the reason. */
  readonly skipped: readonly UndoSkip[];
  readonly bashCalls: number;
  readonly mcpCalls: number;
  /** Makes one authorized step, checking again under the path lock that the file is the one planned. Throws `ToolError` if not. */
  apply(step: UndoStep, signal: AbortSignal): Promise<void>;
  /** Releases the reservations; `used` retires the `undoId` and its saved originals. */
  close(used: boolean): Promise<void>;
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
  | { readonly ok: true; readonly value: ScriptValue }
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
  /** Value of the script's `scratchDir` global; undefined when the run has no scratch directory. */
  readonly scratchDir?: string;
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
  /** Pass it to `undo` in a later run to put back what this run's writes and edits changed. */
  readonly undoId?: string;
  /** Notes the model must know, e.g. bash effects that were not rolled back. */
  readonly warnings: readonly string[];
}
