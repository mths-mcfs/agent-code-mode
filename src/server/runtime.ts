import type { ContextProvider, HostAdapter, HostKind, Sandbox, ToolRuntime } from '../core/types.js';
import { MAX_RUN_TIMEOUT_MS } from '../core/schemas.js';
import { FakeSandbox } from '../testing/fake-sandbox.js';
import { MemoryToolRuntime } from '../testing/memory-tool-runtime.js';
import { StaticHostAdapter } from '../testing/static-host-adapter.js';
import { ClaudeContextProvider, CodexContextProvider, GenericContextProvider } from './context.js';

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

/**
 * Codex's documented MCP tool timeout is 60 s and progress notifications do
 * not extend it, so runs are capped below it.
 */
export const CODEX_MAX_TIMEOUT_MS = 55_000;

/**
 * Builds the runtime for a host. Today it returns the test fakes (the
 * sandbox, host adapters and tool runtime are built in separate parts);
 * the integration part switches each piece to the real implementation.
 */
export function createRuntime(host: HostKind): Runtime {
  const contextProvider = host === 'claude' ? new ClaudeContextProvider() : host === 'codex' ? new CodexContextProvider() : new GenericContextProvider();
  return {
    host,
    contextProvider,
    adapter: new StaticHostAdapter({
      host,
      rules: [(p) => (p.tool === 'bash' && /^\s*rm\s/.test(p.effect.command) ? { kind: 'deny', reason: 'rm is denied by the placeholder policy' } : undefined)],
    }),
    tools: new MemoryToolRuntime({ root: '/workspace' }),
    sandbox: new FakeSandbox(),
    maxTimeoutMs: host === 'codex' ? CODEX_MAX_TIMEOUT_MS : MAX_RUN_TIMEOUT_MS,
  };
}
