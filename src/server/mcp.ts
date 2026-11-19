import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { errorMessage } from '../core/errors.js';
import { formatRunResult, type McpToolResponse } from '../core/output.js';
import { runScript, toRunRequest } from '../core/run.js';
import { RUN_INPUT_JSON_SCHEMA, parseRunArgs } from '../core/schemas.js';
import { stateDirPath } from '../core/state-dir.js';
import type { HostKind, RunResult, SessionContext } from '../core/types.js';
import { recoverStaleJournals } from '../tools/journal.js';
import { detectHost } from './context.js';
import { createRuntime, type Runtime, type RuntimeFactory } from './runtime.js';

export const SERVER_NAME = 'agent-code-mode';

export const SERVER_INSTRUCTIONS = `Prefer the run tool when a step needs several tool calls: batch many reads, searches, edits and commands into one script instead of calling tools one by one.
The script is the body of an async JavaScript function; return a value to get it back. Globals (all async, all subject to your normal permission rules and hooks):
  bash({command, cwd?, timeoutMs?}) -> {exitCode, signal, stdout, stderr, truncated, timedOut}
  read({path, offset?, limit?}) -> {path, content, startLine, totalLines, truncated}
  write({path, content}) -> {path, created, diff}
  edit({path, oldString, newString, replaceAll?}) -> {path, replacements, matchStrategy, diff}
  grep({pattern, path?, glob?, ignoreCase?, maxResults?}) -> {matches: [{file, line, text}], truncated, filtered}
  glob({pattern, path?, maxResults?}) -> {files, truncated, filtered}
  console.log/info/warn/error
A denied call rejects with an Error named PermissionDenied; other failures reject with ToolError. Pass transaction: true to roll back file changes if the script fails or a call is denied (bash effects are never rolled back).`;

export const RUN_TOOL: Tool = {
  name: 'run',
  title: 'Run a code-mode script',
  description:
    'Run a JavaScript script that calls bash, read, write, edit, grep and glob. Every call goes through the host permission rules and hooks. Returns the script result, logs, a call log, changed files and the diff.',
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

  const server = new Server({ name: SERVER_NAME, version: opts.version }, { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS });

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
    const respond = (result: RunResult): Promise<McpToolResponse> => formatRunResult(result, { stateDir });
    if (request.params.name !== RUN_TOOL.name) return respond(errorResult(`unknown tool ${JSON.stringify(request.params.name)}`));
    const args = parseRunArgs(request.params.arguments);
    if (!args.ok) return respond(errorResult(`invalid run arguments: ${args.message}`));
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
      });
      const result = recoveryWarnings.length === 0 ? ran : { ...ran, warnings: [...recoveryWarnings, ...ran.warnings] };
      await appendRunLog(env[RUN_LOG_ENV], ctx, result);
      return await respond(result);
    } catch (err) {
      return respond(errorResult(`internal error: ${errorMessage(err)}`));
    }
  });

  return server;
}
