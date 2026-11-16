import { stateDirPath } from '../core/state-dir.js';
import type { ContextProvider, HostAdapter, HostKind, Sandbox, ToolRuntime } from '../core/types.js';
import { MAX_RUN_TIMEOUT_MS } from '../core/schemas.js';
import { ClaudeHostAdapter } from '../hosts/claude/adapter.js';
import { createClaudeContextProvider } from '../hosts/claude/context.js';
import { CodexHostAdapter, codexToolTimeoutSec } from '../hosts/codex/adapter.js';
import { CodexContextProvider } from '../hosts/codex/context.js';
import { QuickJsSandbox } from '../sandbox/quickjs-sandbox.js';
import { NodeToolRuntime } from '../tools/runtime.js';
import { GenericContextProvider } from './context.js';
import { GenericHostAdapter } from './generic-adapter.js';

/** Name the server is registered under in the host configs (`mcp__<name>__run`, `[mcp_servers.<name>]`). */
export const REGISTERED_SERVER_NAME = 'agent-code-mode';

/** The components that serve `run` for one host. */
export interface Runtime {
  readonly host: HostKind;
  readonly contextProvider: ContextProvider;
  readonly adapter: HostAdapter;
  readonly tools: ToolRuntime;
  readonly sandbox: Sandbox;
  /** Timeout cap for this host. */
  readonly maxTimeoutMs: number;
}

export type RuntimeFactory = (host: HostKind) => Runtime;

/** Codex `tool_timeout_sec` assumed when the config does not set it (the documented default). */
export const CODEX_ASSUMED_TOOL_TIMEOUT_SEC = 60;

/** Margin kept below Codex's tool timeout so the run returns its own result before Codex gives up on the call. */
export const CODEX_TIMEOUT_MARGIN_MS = 10_000;

/**
 * Run timeout cap under Codex: `tool_timeout_sec − 10 s` (progress
 * notifications do not extend Codex's tool timeout), never below 1 s nor
 * above the server-wide cap. With the 120 s default request this gives the
 * default `min(120 s, tool_timeout_sec − 10 s)`.
 */
export function codexMaxTimeoutMs(toolTimeoutSec: number | undefined): number {
  const seconds = toolTimeoutSec ?? CODEX_ASSUMED_TOOL_TIMEOUT_SEC;
  return Math.max(1_000, Math.min(MAX_RUN_TIMEOUT_MS, Math.floor(seconds * 1000) - CODEX_TIMEOUT_MARGIN_MS));
}

export interface RuntimeOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Server process cwd (Codex starts the server in the session cwd). */
  readonly serverCwd?: string;
  readonly stateDir?: string;
}

/**
 * Builds the real runtime for a host: the QuickJS-ng sandbox, the Node tool
 * runtime and the host's own adapter and context provider. A `generic` host
 * (neither detected nor given with `--host`) gets a strict built-in policy:
 * reads inside the workspace only.
 */
export function createRuntime(host: HostKind, opts: RuntimeOptions = {}): Runtime {
  const env = opts.env ?? process.env;
  const stateDir = opts.stateDir ?? stateDirPath(env);
  const tools = new NodeToolRuntime({ stateDir });
  const sandbox = new QuickJsSandbox();
  switch (host) {
    case 'claude':
      return {
        host,
        contextProvider: createClaudeContextProvider({ stateDir }),
        adapter: new ClaudeHostAdapter({ env, stateDir, serverName: REGISTERED_SERVER_NAME }),
        tools,
        sandbox,
        maxTimeoutMs: MAX_RUN_TIMEOUT_MS,
      };
    case 'codex':
      return {
        host,
        contextProvider: new CodexContextProvider(),
        adapter: new CodexHostAdapter({ stateDir }),
        tools,
        sandbox,
        maxTimeoutMs: codexMaxTimeoutMs(codexToolTimeoutSec(opts.serverCwd ?? process.cwd(), REGISTERED_SERVER_NAME)),
      };
    case 'generic':
      return {
        host,
        contextProvider: new GenericContextProvider(),
        adapter: new GenericHostAdapter({ stateDir }),
        tools,
        sandbox,
        maxTimeoutMs: MAX_RUN_TIMEOUT_MS,
      };
  }
}
