import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { errorMessage } from '../core/errors.js';
import { DIFF_INLINE_CHARS, TEXT_BLOCK_MIN_CHARS, formatRunResult, type McpToolResponse } from '../core/output.js';
import { OverflowStore, removeLegacyOverflowFiles } from '../core/overflow.js';
import { runScript, toRunRequest } from '../core/run.js';
import { RUN_INPUT_JSON_SCHEMA, parseRunArgs } from '../core/schemas.js';
import { stateDirPath } from '../core/state-dir.js';
import type { HostKind, RunResult, SessionContext } from '../core/types.js';
import { recoverStaleJournals } from '../tools/journal.js';
import { detectHost } from './context.js';
import { createRuntime, type Runtime, type RuntimeFactory } from './runtime.js';

export const SERVER_NAME = 'agent-code-mode';

/**
 * Everything the model needs to write a script: the binding signatures and
 * one line of rules. It lives in the tool description, not in the server
 * `instructions`: Claude Code puts server instructions in the per-session
 * environment message, where they are written to the prompt cache again in
 * every session, while tool definitions sit in the prefix sessions share.
 * Kept short on purpose: a worked example script made the model copy its
 * shape into unrelated tasks.
 */
export const RUN_DESCRIPTION = `Run a JavaScript script (the body of an async function; return a value to get it back) that batches calls to these globals. Each call is checked against the host's permission rules and hooks; a denied call rejects with an Error named PermissionDenied, other failures with ToolError. Paths in results are relative to the working directory.
declare function bash(a: {command: string; cwd?: string; timeoutMs?: number}): Promise<{exitCode: number | null; signal: string | null; stdout: string; stderr: string; truncated: boolean; timedOut: boolean}>;
declare function read(a: {path: string; offset?: number; limit?: number}): Promise<{path: string; content: string /* exact text */; startLine: number; totalLines: number; truncated: boolean}>;
declare function write(a: {path: string; content: string}): Promise<{path: string; created: boolean; diff: string}>;
declare function edit(a: {path: string; oldString: string; newString: string; replaceAll?: boolean}): Promise<{path: string; replacements: number; matchStrategy: string; diff: string}>;
declare function grep(a: {pattern: string; path?: string; glob?: string; ignoreCase?: boolean; maxResults?: number}): Promise<{columns: ['file', 'line', 'text']; rows: [string, number, string][]; count: number; truncated: boolean; filtered: number}>;
declare function glob(a: {pattern: string; path?: string; maxResults?: number}): Promise<{files: string[]; truncated: boolean; filtered: number}>;
declare function readOverflow(id: string, offset?: number, limit?: number): Promise<{text: string; offset: number; totalChars: number; truncated: boolean}>; // the whole result JSON a response cut
type Response = {ok: boolean; result?: unknown; error?: {name: string; message: string}; logs?: string[]; calls: {total: number; byTool: Record<string, number>; denied?: object[]; errors?: object[]}; changedFiles?: string[]; diff?: string; diffStat?: {files: Record<string, string>; moreFiles?: number; total: string}; warnings?: string[]; truncated?: true; overflow?: {id: string; chars: number}}; // a multi-line string result over ${TEXT_BLOCK_MIN_CHARS} chars comes as plain text in a second block; a diff over ${DIFF_INLINE_CHARS} chars comes as diffStat
QuickJS ES2023; no require/process/fs; inspect one sample file before batching edits`;

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
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly serverCwd?: string;
  readonly stateDir?: string;
  readonly createRuntime?: RuntimeFactory;
  /** How long to wait for `roots/list`. */
  readonly rootsTimeoutMs?: number;
  /** Restore journals left by dead server processes for each workspace first seen. Default true. */
  readonly recoverJournals?: boolean;
  /** Keeps what responses cut, for `readOverflow`. Default: a new store for this server. */
  readonly overflow?: OverflowStore;
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

/** Env var naming a file where the server appends one JSON line per run (context sources and call log), for debugging host setups. */
export const RUN_LOG_ENV = 'AGENT_CODE_MODE_LOG';

async function appendRunLog(file: string | undefined, ctx: SessionContext, result: RunResult): Promise<void> {
  if (file === undefined || file === '' || !path.isAbsolute(file)) return;
  const line = {
    at: new Date().toISOString(),
    host: ctx.host,
    cwd: ctx.cwd,
    permissionMode: ctx.permissionMode,
    sources: ctx.sources,
    ...(ctx.agentType === undefined ? {} : { agentType: ctx.agentType }),
    ok: result.ok,
    calls: result.calls.map((c) => ({ id: c.id, summary: c.summary, decision: c.decision, ...(c.reason === undefined ? {} : { reason: c.reason }) })),
  };
  await appendFile(file, `${JSON.stringify(line)}\n`, { mode: 0o600 }).catch(() => undefined);
}

/** Creates the MCP server exposing the `run` tool. Connect it to a transport to serve. */
export function createMcpServer(opts: McpServerOptions): Server {
  const env = opts.env ?? process.env;
  const serverCwd = opts.serverCwd ?? process.cwd();
  const stateDir = opts.stateDir ?? stateDirPath(env);
  const factory = opts.createRuntime ?? ((host: HostKind) => createRuntime(host, { env, serverCwd, stateDir }));
  const recoverJournals = opts.recoverJournals ?? opts.createRuntime === undefined;
  const recoveredRoots = new Set<string>();
  // Cut results live in this process only; older versions wrote them to the state directory and never removed them.
  const overflow = opts.overflow ?? new OverflowStore();
  if (opts.overflow === undefined) void removeLegacyOverflowFiles(stateDir);
  /** Rolls back what runs of crashed server processes left in this workspace, once per root; returns warnings for the model. */
  const recoverFor = async (ctx: SessionContext): Promise<string[]> => {
    if (!recoverJournals) return [];
    const roots = [...new Set([ctx.cwd, ...ctx.roots])].filter((r) => !recoveredRoots.has(r));
    if (roots.length === 0) return [];
    roots.forEach((r) => recoveredRoots.add(r));
    const recovered = await recoverStaleJournals(stateDir, roots);
    return recovered.flatMap(({ id, report, kept }) => [
      ...(report.restored.length > 0 ? [`an earlier run (${id}) was cut off mid-transaction; restored: ${report.restored.join(', ')}`] : []),
      ...report.skipped.map((s) => `an earlier run (${id}) was cut off mid-transaction; ${s.path} was not restored (${s.reason}${s.detail ? `: ${s.detail}` : ''})`),
      ...(kept ? [`the journal of ${id} is kept so a later start can retry the files that could not be restored`] : []),
    ]);
  };
  const runtimes = new Map<HostKind, Runtime>();
  const runtimeFor = (host: HostKind): Runtime => {
    let runtime = runtimes.get(host);
    if (!runtime) {
      runtime = factory(host);
      runtimes.set(host, runtime);
    }
    return runtime;
  };

  const server = new Server({ name: SERVER_NAME, version: opts.version }, { capabilities: { tools: {} } });
  server.onclose = () => overflow.clear();

  const listRoots = async (): Promise<string[]> => {
    if (!server.getClientCapabilities()?.roots) return [];
    try {
      const result = await server.listRoots(undefined, { timeout: opts.rootsTimeoutMs ?? 5_000 });
      return rootPaths(result.roots);
    } catch {
      return [];
    }
  };

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [RUN_TOOL] }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<McpToolResponse> => {
    let verbose = false;
    const respond = (result: RunResult): McpToolResponse => formatRunResult(result, { overflow, verbose });
    if (request.params.name !== RUN_TOOL.name) return respond(errorResult(`unknown tool ${JSON.stringify(request.params.name)}`));
    const args = parseRunArgs(request.params.arguments);
    if (!args.ok) return respond(errorResult(`invalid run arguments: ${args.message}`));
    verbose = args.value.verbose ?? false;
    try {
      const meta: unknown = request.params._meta;
      const host = detectHost({ flag: opts.host, env, meta });
      const runtime = runtimeFor(host);
      const roots = await listRoots();
      const ctx = await runtime.contextProvider.resolve({ env, meta, roots, serverCwd });
      const recoveryWarnings = await recoverFor(ctx);
      const ran = await runScript(toRunRequest(args.value, runtime.maxTimeoutMs), {
        sandbox: runtime.sandbox,
        adapter: runtime.adapter,
        tools: runtime.tools,
        ctx,
        signal: extra.signal,
        maxTimeoutMs: runtime.maxTimeoutMs,
        overflow,
      });
      const result = recoveryWarnings.length === 0 ? ran : { ...ran, warnings: [...recoveryWarnings, ...ran.warnings] };
      await appendRunLog(env[RUN_LOG_ENV], ctx, result);
      return respond(result);
    } catch (err) {
      return respond(errorResult(`internal error: ${errorMessage(err)}`));
    }
  });

  return server;
}
