import { appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { errorMessage } from '../core/errors.js';
import { formatRunResult, type McpToolResponse } from '../core/output.js';
import { OverflowStore } from '../core/overflow.js';
import { runScript, toRunRequest } from '../core/run.js';
import { RUN_INPUT_JSON_SCHEMA, parseRunArgs } from '../core/schemas.js';
import { stateDirPath } from '../core/state-dir.js';
import { CODEX_SEARCH_NOTE } from '../hosts/codex/index.js';
import type { HostKind, PolicySnapshot, RunResult, SessionContext } from '../core/types.js';
import { McpUpstreams } from '../mcp/upstream.js';
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

export const RUN_DESCRIPTION = `Run a JavaScript script (the body of an async function; return a value) that calls these async globals. Each call goes through the host's permission rules and hooks; a denied call rejects with PermissionDenied, other failures with ToolError. Paths are relative to the working directory. QuickJS, no require/process/fs.
bash({command, cwd?, timeoutMs?}) -> {exitCode, signal, stdout, stderr, truncated, timedOut}
read({path, offset?, limit?}) -> {path, content (exact text), startLine, totalLines, truncated}
write({path, content}) -> {path, created, diff}
edit({path, oldString, newString, replaceAll?}) -> {path, replacements, matchStrategy, diff}
grep({pattern, path?, glob?, ignoreCase?, maxResults?}) -> {columns: [file, line, text], rows, count, truncated, filtered}
glob({pattern, path?, maxResults?}) -> {files, truncated, filtered}
readOverflow(id, offset?, limit?) -> {text, offset, totalChars, truncated}: a page of the result JSON a response cut (its overflow.id)
mcpCall(server, tool, args?, {timeoutMs?}?) -> {isError, structuredContent?, text?, truncated?, overflow?}: a tool of an MCP server the host configures, authorized as mcp__<server>__<tool>; never rolled back
The response counts calls per tool and lists the denied and failed ones (verbose: true lists all). A large diff comes as diffStat. transaction: true rolls back file changes if the script fails.
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
  /** What responses cut, for `readOverflow`; created here when absent. */
  readonly overflow?: OverflowStore;
  /** The upstream MCP server processes (keeping cut results in `overflow`); created here when absent, and closed with the session. */
  readonly upstreams?: McpUpstreams;
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

  const overflow = opts.overflow ?? new OverflowStore();
  const server = new Server({ name: SERVER_NAME, version: opts.version }, {
    capabilities: { tools: {} },
    instructions: SERVER_INSTRUCTIONS,
  });
  const upstreams = opts.upstreams ?? new McpUpstreams({ overflow, clientVersion: opts.version });
  // The host starts its MCP servers when the session starts, and so does this server, with the policy it has then.
  const sessionHost = detectHost({ flag: opts.host, env, meta: undefined });
  if (sessionHost !== 'generic') {
    upstreams.start(
      (async () => {
        const runtime = runtimeFor(sessionHost);
        const policy = await runtime.adapter.loadPolicy(await runtime.contextProvider.resolve({ env, meta: undefined, roots: [], serverCwd }));
        if ('error' in policy || policy.mcp === undefined || policy.mcp.unsupported !== undefined) return [];
        return policy.mcp.servers.filter((s) => s.autostart);
      })(),
    );
  }
  server.onclose = () => {
    overflow.clear();
    void upstreams.close();
  };

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
        mcp: upstreams,
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
