import { appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { errorMessage } from '../core/errors.js';
import { DIFF_INLINE_CHARS, TEXT_BLOCK_MIN_CHARS, formatRunResult, type McpToolResponse } from '../core/output.js';
import { OverflowStore } from '../core/overflow.js';
import { runScript, toRunRequest } from '../core/run.js';
import { RUN_INPUT_JSON_SCHEMA, parseRunArgs } from '../core/schemas.js';
import { stateDirPath } from '../core/state-dir.js';
import { CODEX_SEARCH_NOTE } from '../hosts/codex/index.js';
import type { HostKind, PolicySnapshot, RunResult, SessionContext } from '../core/types.js';
import { recoverStaleJournals, type RecoveredJournal } from '../tools/journal.js';
import { detectHost } from './context.js';
import { createRuntime, type Runtime, type RuntimeFactory } from './runtime.js';

export const SERVER_NAME = 'agent-code-mode';

/**
 * Only the Codex search note: Claude Code puts server instructions in each
 * session's own messages, so anything here is paid again per session, while
 * the tool description sits in the prefix sessions share.
 */
export const SERVER_INSTRUCTIONS = CODEX_SEARCH_NOTE;

export const RUN_DESCRIPTION = `Run a JavaScript script (the body of an async function; return a value to get it back) that batches calls to these globals. Each call is checked against the host's permission rules and hooks; a denied call rejects with an Error named PermissionDenied, other failures with ToolError. Paths in results are relative to the working directory.
declare function bash(a: {command: string; cwd?: string; timeoutMs?: number}): Promise<{exitCode: number | null; signal: string | null; stdout: string; stderr: string; truncated: boolean; timedOut: boolean}>;
declare function read(a: {path: string; offset?: number; limit?: number}): Promise<{path: string; content: string /* exact text */; startLine: number; totalLines: number; truncated: boolean}>;
declare function write(a: {path: string; content: string}): Promise<{path: string; created: boolean; diff: string}>;
declare function edit(a: {path: string; oldString: string; newString: string; replaceAll?: boolean}): Promise<{path: string; replacements: number; matchStrategy: string; diff: string}>;
declare function grep(a: {pattern: string; path?: string; glob?: string; ignoreCase?: boolean; maxResults?: number}): Promise<{columns: ['file', 'line', 'text']; rows: [string, number, string][]; count: number; truncated: boolean; filtered: number}>;
declare function glob(a: {pattern: string; path?: string; maxResults?: number}): Promise<{files: string[]; truncated: boolean; filtered: number}>;
declare function readOverflow(id: string, offset?: number, limit?: number): Promise<{text: string; offset: number; totalChars: number; truncated: boolean}>; // the whole result JSON of a response that left something out
Response: {ok, result | error, logs?, calls: {total, byTool, denied?, errors?}, changedFiles?, diff? | diffStat?, warnings?, overflow?: {id, chars}, truncated?}. Every denied and failed call is listed (grouped by tool and reason with a count when there are too many). A diff over ${DIFF_INLINE_CHARS} chars comes as diffStat; a multi-line string result over ${TEXT_BLOCK_MIN_CHARS} chars as a second text block; anything cut is in readOverflow(overflow.id). verbose: true returns every call and the whole diff (counts again above the cap, with the full log in readOverflow). transaction: true rolls back file changes if the script fails or a call is denied (never bash effects).
QuickJS ES2023; no require, process or fs.
${CODEX_SEARCH_NOTE}`;

export const HYBRID_GUIDANCE =
  'Native file and shell tools are also available: use them for a single read, edit or command; use run when a step needs 3+ file/shell calls, a loop over files, or filtering a large output.';

export const RUN_TOOL: Tool = {
  name: 'run',
  title: 'Run a code-mode script',
  description: RUN_DESCRIPTION,
  inputSchema: RUN_INPUT_JSON_SCHEMA,
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  _meta: { 'anthropic/alwaysLoad': true },
};

export interface McpServerOptions {
  readonly version: string;
  /** `--host` flag; skips detection. */
  readonly host?: HostKind;
  readonly hybrid?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly serverCwd?: string;
  readonly stateDir?: string;
  readonly createRuntime?: RuntimeFactory;
  /** How long to wait for `roots/list`. */
  readonly rootsTimeoutMs?: number;
  readonly recoverJournals?: boolean;
}

export const RUN_LOG_ENV = 'AGENT_CODE_MODE_LOG';

export function recoveryProtectedPaths(stateDir: string, env: Readonly<Record<string, string | undefined>>, home: string = os.homedir()): string[] {
  const configDirs = [env['CODEX_HOME'], env['CLAUDE_CONFIG_DIR']].filter((d): d is string => d !== undefined && path.isAbsolute(d));
  return [
    path.join(stateDir, '**'),
    ...configDirs.map((d) => path.join(d, '**')),
    path.join(home, '.claude', '**'),
    path.join(home, '.claude.json'),
    path.join(home, '.codex', '**'),
    '**/.claude/**',
    '**/.codex/**',
    '**/.mcp.json',
    '**/.git/**',
  ];
}

interface RecoveryLog {
  readonly trigger: 'startup' | 'first-run';
  readonly roots: readonly string[];
  readonly journals: readonly {
    readonly id: string;
    readonly restored: readonly string[];
    readonly conflicts: readonly { readonly path: string; readonly reason: string; readonly detail?: string }[];
    readonly leftoverTemps: readonly string[];
    readonly finalized?: true;
  }[];
}

function recoveryLog(trigger: RecoveryLog['trigger'], roots: readonly string[], recovered: readonly RecoveredJournal[]): RecoveryLog {
  return {
    trigger,
    roots,
    journals: recovered.map((r) => ({
      id: r.id,
      restored: r.report.restored,
      conflicts: r.report.skipped.map((s) => ({ path: s.path, reason: s.reason, ...(s.detail === undefined ? {} : { detail: s.detail }) })),
      leftoverTemps: (r.leftoverTemps ?? []).map((t) => t.path),
      ...(r.finalized ? { finalized: true as const } : {}),
    })),
  };
}

function recoveryWarnings(log: RecoveryLog): string[] {
  return log.journals.flatMap((j) => [
    ...(j.restored.length > 0 ? [`an earlier run (${j.id}) was cut off mid-transaction; restored: ${j.restored.join(', ')}`] : []),
    ...j.conflicts.map((c) => `an earlier run (${j.id}) was cut off mid-transaction; ${c.path} was not restored (${c.reason}${c.detail ? `: ${c.detail}` : ''})`),
    ...j.leftoverTemps.map((t) => `an earlier run (${j.id}) left the temporary file ${t}; it was not deleted`),
  ]);
}

async function appendRunLog(file: string | undefined, line: Record<string, unknown>): Promise<void> {
  if (file === undefined || !path.isAbsolute(file)) return;
  await appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`, { mode: 0o600 }).catch(() => undefined);
}

function runLogLine(ctx: SessionContext, result: RunResult, recovery: readonly RecoveryLog[]): Record<string, unknown> {
  return {
    event: 'run',
    host: ctx.host,
    cwd: ctx.cwd,
    permissionMode: ctx.permissionMode,
    sources: ctx.sources,
    ...(ctx.agentType === undefined ? {} : { agentType: ctx.agentType }),
    ok: result.ok,
    ...(result.error ? { error: { kind: result.error.kind, message: result.error.message } } : {}),
    calls: result.calls.map((c) => ({ id: c.id, summary: c.summary, decision: c.decision, ...(c.reason === undefined ? {} : { reason: c.reason }) })),
    ...(recovery.length > 0 ? { recovery } : {}),
  };
}

/** A failed `RunResult` for protocol and validation errors, so they go through the same capped formatter. */
function errorResult(message: string): RunResult {
  return { ok: false, error: { kind: 'internal', name: 'Error', message }, logs: [], calls: [], changedFiles: [], diff: '', warnings: [] };
}

function rootPaths(roots: readonly { uri: string }[]): string[] {
  const out: string[] = [];
  for (const root of roots) {
    if (!root.uri.startsWith('file:')) continue;
    try {
      out.push(fileURLToPath(root.uri));
    } catch {
      // Not a local file URL.
    }
  }
  return out;
}

/** Creates the MCP server exposing the `run` tool. Connect it to a transport to serve. */
export function createMcpServer(opts: McpServerOptions): Server {
  const env = opts.env ?? process.env;
  const serverCwd = opts.serverCwd ?? process.cwd();
  const stateDir = opts.stateDir ?? stateDirPath(env);
  const factory = opts.createRuntime ?? ((host: HostKind) => createRuntime(host, { env, serverCwd, stateDir }));
  const runLog = env[RUN_LOG_ENV];
  const recoverJournals = opts.recoverJournals ?? true;
  const runtimes = new Map<HostKind, Runtime>();
  const runtimeFor = (host: HostKind): Runtime => {
    let runtime = runtimes.get(host);
    if (!runtime) {
      runtime = factory(host);
      runtimes.set(host, runtime);
    }
    return runtime;
  };
  const policyOf = async (runtime: Runtime, ctx: SessionContext): Promise<PolicySnapshot | undefined> => {
    const policy = await runtime.adapter.loadPolicy(ctx).catch(() => undefined);
    return policy !== undefined && !('error' in policy) ? policy : undefined;
  };
  const recoveries = new Map<string, Promise<RecoveryLog | undefined>>();
  /** Every recovery pass started; a run waits for all of them, whatever roots its policy turns out to grant. */
  const passes: Promise<RecoveryLog | undefined>[] = [];
  const recover = (trigger: RecoveryLog['trigger'], known: readonly string[], policy: () => Promise<PolicySnapshot | undefined>): Promise<RecoveryLog | undefined> => {
    const pass: Promise<RecoveryLog | undefined> = Promise.resolve().then(async () => {
      const snapshot = await policy().catch(() => undefined);
      const extra = (snapshot?.additionalRoots ?? []).filter((r) => !recoveries.has(r));
      for (const root of extra) recoveries.set(root, pass);
      const roots = [...known, ...extra];
      const recovered = await recoverStaleJournals(stateDir, roots, [...(snapshot?.protectedPaths ?? []), ...recoveryProtectedPaths(stateDir, env)]);
      if (recovered.length === 0) return undefined;
      const log = recoveryLog(trigger, roots, recovered);
      await appendRunLog(runLog, { event: 'recovery', ...log });
      return log;
    });
    for (const root of known) recoveries.set(root, pass);
    passes.push(pass);
    return pass;
  };
  if (recoverJournals) {
    void recover('startup', [serverCwd], async () => {
      if (opts.host === undefined) return undefined;
      const runtime = runtimeFor(opts.host);
      return policyOf(runtime, await runtime.contextProvider.resolve({ env, meta: undefined, roots: [], serverCwd }));
    });
  }
  let startupReported = false;
  /** Session cwds whose host policy was read for additional roots to recover. */
  const policyRead = new Set<string>();
  const recoverFor = async (ctx: SessionContext, runtime: Runtime): Promise<RecoveryLog[]> => {
    if (!recoverJournals) return [];
    const fresh = [...new Set([ctx.cwd, ...ctx.roots])].filter((r) => !recoveries.has(r));
    const reported: Promise<RecoveryLog | undefined>[] = [];
    if (fresh.length > 0 || !policyRead.has(ctx.cwd)) {
      policyRead.add(ctx.cwd);
      reported.push(recover('first-run', fresh, () => policyOf(runtime, ctx)));
    }
    const startup = recoveries.get(serverCwd);
    if (!startupReported && startup !== undefined) reported.push(startup);
    startupReported = true;
    await Promise.all(passes);
    return [...new Set(await Promise.all(reported))].filter((l): l is RecoveryLog => l !== undefined);
  };

  const overflow = new OverflowStore();
  const server = new Server({ name: SERVER_NAME, version: opts.version }, {
    capabilities: { tools: {} },
    instructions: SERVER_INSTRUCTIONS,
  });
  server.onclose = () => overflow.clear();

  const listRoots = async (signal: AbortSignal): Promise<string[]> => {
    if (!server.getClientCapabilities()?.roots) return [];
    try {
      const result = await server.listRoots(undefined, { timeout: opts.rootsTimeoutMs ?? 5_000, signal });
      return rootPaths(result.roots);
    } catch {
      return [];
    }
  };

  const listed: Tool = opts.hybrid === true ? { ...RUN_TOOL, description: `${RUN_DESCRIPTION}\n${HYBRID_GUIDANCE}` } : RUN_TOOL;
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [listed] }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<McpToolResponse> => {
    let verbose = false;
    const respond = (result: RunResult): McpToolResponse => formatRunResult(result, { overflow, verbose });
    if (request.params.name !== RUN_TOOL.name) return respond(errorResult(`unknown tool ${JSON.stringify(request.params.name)}`));
    const args = parseRunArgs(request.params.arguments);
    if (!args.ok) return respond(errorResult(`invalid run arguments: ${args.message}`));
    verbose = args.value.verbose === true;
    try {
      const meta: unknown = request.params._meta;
      const host = detectHost({ flag: opts.host, env, meta });
      const runtime = runtimeFor(host);
      const roots = await listRoots(extra.signal);
      if (extra.signal.aborted) return respond(errorResult('the run was cancelled before context resolution'));
      const ctx = await runtime.contextProvider.resolve({ env, meta, roots, serverCwd });
      const recovered = await recoverFor(ctx, runtime);
      const ran = await runScript(toRunRequest(args.value, runtime.maxTimeoutMs), {
        sandbox: runtime.sandbox,
        adapter: runtime.adapter,
        tools: runtime.tools,
        ctx,
        signal: extra.signal,
        maxTimeoutMs: runtime.maxTimeoutMs,
        overflow,
      });
      const warnings = recovered.flatMap(recoveryWarnings);
      const result = warnings.length === 0 ? ran : { ...ran, warnings: [...warnings, ...ran.warnings] };
      await appendRunLog(runLog, runLogLine(ctx, result, recovered));
      return respond(result);
    } catch (err) {
      return respond(errorResult(`internal error: ${errorMessage(err)}`));
    }
  });

  return server;
}
