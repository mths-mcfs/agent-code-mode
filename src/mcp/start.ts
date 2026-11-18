import { errorMessage } from '../core/errors.js';
import type { HostKind } from '../core/types.js';
import { managedMcpKeys } from '../hosts/claude/adapter.js';
import { readManagedSettings } from '../hosts/claude/settings.js';
import { loadMcpConfig } from './config.js';
import { connectUpstreams, type ConnectOptions, type McpUpstream } from './upstream.js';

/**
 * What `serve --mcp-config` checks before it serves: the config is valid, the
 * host is Claude Code (the only host whose MCP permission rules this server
 * reproduces), and no managed setting restricts MCP servers in a way this
 * server does not evaluate. Only then are the upstream servers started.
 */

export interface StartMcpOptions extends ConnectOptions {
  /** Aborted when the session ends during the start (see `upstreamLifecycle`): spawned servers are closed. */
  readonly signal?: AbortSignal;
  readonly configFile: string;
  /** The host the server will serve: the `--host` flag, else what the environment shows. */
  readonly host: HostKind;
  /** Managed settings directory, undefined when the platform has none. */
  readonly managedDir: string | undefined;
  /** Server names an upstream may not take (this server's own registered name). */
  readonly reservedServerNames?: readonly string[];
}

/** Checks everything, then connects. Resolves to an error message when the server must not start. */
export async function startMcpUpstreams(opts: StartMcpOptions): Promise<{ ok: true; upstream: McpUpstream } | { ok: false; message: string }> {
  if (opts.host !== 'claude') {
    return {
      ok: false,
      message: `--mcp-config needs the Claude Code host (got ${opts.host}): start the server from Claude Code or with --host claude; Codex and other clients are not supported yet`,
    };
  }
  const config = await loadMcpConfig(opts.configFile, opts.reservedServerNames === undefined ? {} : { reservedServerNames: opts.reservedServerNames });
  if (!config.ok) return { ok: false, message: `--mcp-config: ${config.message}` };
  if (opts.managedDir !== undefined) {
    let keys: string[];
    try {
      keys = [...new Set((await readManagedSettings(opts.managedDir)).flatMap((doc) => managedMcpKeys(doc.data)))];
    } catch (err) {
      return { ok: false, message: `--mcp-config: managed settings cannot be read: ${errorMessage(err)}` };
    }
    if (keys.length > 0) {
      return { ok: false, message: `--mcp-config: managed settings set ${keys.join(' and ')}, which agent-code-mode does not evaluate; refusing to start upstream MCP servers` };
    }
  }
  return { ok: true, upstream: await connectUpstreams(config.servers, opts) };
}

/** `--mcp-config <file>` (or `--mcp-config=<file>`) among the `serve` arguments: undefined when absent. */
export function parseMcpConfigFlag(args: readonly string[]): string | undefined | Error {
  const i = args.findIndex((a) => a === '--mcp-config' || a.startsWith('--mcp-config='));
  if (i === -1) return undefined;
  if (args.slice(i + 1).some((a) => a === '--mcp-config' || a.startsWith('--mcp-config='))) return new Error('--mcp-config may be given once');
  const arg = args[i] ?? '';
  const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[i + 1];
  if (value === undefined || value === '' || value.startsWith('--')) return new Error('--mcp-config needs a file path');
  return value;
}

/** Where `closeUpstreamsOnExit` listens. */
export interface ExitHooks {
  /** The client side of the MCP session: its end means the session is over. */
  readonly stdin: { once(event: 'end', listener: () => void): unknown };
  readonly onSignal: (signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP', handler: () => void) => void;
  readonly exit: (code: number) => void;
}

/**
 * Ends the upstream servers with the session, from before the first one starts: a stop signal or stdin EOF
 * (the server transport does not report it, and live upstream pipes would keep the process up) that comes
 * while they are still starting aborts `signal`, which closes every process spawned so far, connected or
 * not; one that comes later closes the set given to `attach`. After a signal the process exits with the
 * signal's code once the upstreams are closed.
 */
export function upstreamLifecycle(hooks: ExitHooks): { readonly signal: AbortSignal; attach(upstream: McpUpstream): boolean } {
  const controller = new AbortController();
  let upstream: McpUpstream | undefined;
  let exitCode: number | undefined;
  const stop = (code: number | undefined): void => {
    if (code !== undefined) exitCode ??= code;
    controller.abort();
    if (upstream === undefined) return; // `attach` finishes the job once the start returns
    const set = upstream;
    void set.close().finally(() => {
      if (exitCode !== undefined) hooks.exit(exitCode);
    });
  };
  hooks.stdin.once('end', () => stop(undefined));
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const) hooks.onSignal(signal, () => stop(code));
  return {
    signal: controller.signal,
    /** Hands over the started set. Returns false when the session already ended (the set is then being closed). */
    attach(set) {
      upstream = set;
      if (!controller.signal.aborted) return true;
      void set.close().finally(() => {
        if (exitCode !== undefined) hooks.exit(exitCode);
      });
      return false;
    },
  };
}
