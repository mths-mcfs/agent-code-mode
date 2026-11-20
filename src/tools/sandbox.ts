import { ToolError, errorMessage } from '../core/errors.js';
import type { BashContainment } from '../core/types.js';
import { bootstrapEnv, spawnAndWait } from './bash.js';

/**
 * OS containment for `bash` through `@anthropic-ai/sandbox-runtime`
 * (bubblewrap on Linux, Seatbelt on macOS). The library keeps one global
 * configuration and one network proxy per process, so this module owns it:
 * it is initialized once, lazily, with no network allowed, and each command
 * passes its own filesystem rules.
 *
 * Network: the library routes all traffic through its proxy and refuses an
 * allow-everything domain list, so "network on" is implemented with the
 * library's ask callback, which allows a host only while a network-enabled
 * command holds the sandbox. Sandboxed commands are therefore serialized in
 * this process, so a network-off command never runs while the gate is open.
 * On Linux the command has no network namespace of its own either way: with
 * network on, only clients that honor the proxy variables the library sets
 * (curl, git, npm, ...) reach the network; raw sockets never do.
 */

type SandboxModule = typeof import('@anthropic-ai/sandbox-runtime');
type Manager = SandboxModule['SandboxManager'];

let loading: Promise<Manager> | undefined;
let networkOpen = false;
let tail: Promise<unknown> = Promise.resolve();
let probed = false;

/** Why containment is unavailable on this machine, or null when it is available. */
let availability: Promise<string | null> | undefined;

async function loadManager(): Promise<Manager> {
  const mod: SandboxModule = await import('@anthropic-ai/sandbox-runtime');
  return mod.SandboxManager;
}

/** Checks and caches the platform and dependencies before a sandboxed commit can run. */
export function containmentUnavailableReason(): Promise<string | null> {
  availability ??= (async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') {
      return `bash containment is not supported on ${process.platform}`;
    }
    try {
      const manager = await loadManager();
      if (!manager.isSupportedPlatform()) return 'the sandbox runtime does not support this platform';
      const check = manager.checkDependencies();
      if (check.errors.length > 0) return `sandbox dependencies missing: ${check.errors.join('; ')}`;
      return null;
    } catch (err) {
      return `sandbox runtime failed to load: ${errorMessage(err)}`;
    }
  })();
  return availability;
}

/** Most time the probe command may take. */
const PROBE_TIMEOUT_MS = 15_000;

/**
 * Runs `true` in the sandbox once: present dependencies do not prove the
 * sandbox can start here (user namespaces may be disabled), and a sandbox
 * that cannot start would otherwise look like the command's own exit.
 */
async function probe(m: Manager, shell: string, signal: AbortSignal): Promise<void> {
  try {
    const wrapped = await m.wrapWithSandboxArgv('true', shell, { filesystem: { denyRead: [], allowWrite: [], denyWrite: [] } });
    const env = bootstrapEnv({ ...process.env, ...wrapped.env });
    const r = await spawnAndWait(wrapped.argv, env, process.cwd(), PROBE_TIMEOUT_MS, signal, 4096);
    if (r.exitCode === 0) return;
    const how = r.timedOut ? `no exit within ${PROBE_TIMEOUT_MS} ms` : `exit ${r.exitCode ?? r.signal}`;
    const first = r.stderr.trim().split('\n')[0] ?? '';
    throw new Error(`the sandbox could not start a command (${how}${first ? `: ${first}` : ''})`);
  } finally {
    try {
      m.cleanupAfterCommand();
    } catch {
      // Cleanup is best effort.
    }
  }
}

async function manager(): Promise<Manager> {
  loading ??= (async () => {
    const m = await loadManager();
    await m.initialize(
      { network: { allowedDomains: [], deniedDomains: [] }, filesystem: { denyRead: [], allowWrite: [], denyWrite: [] } },
      async () => networkOpen,
    );
    return m;
  })();
  try {
    return await loading;
  } catch (err) {
    loading = undefined;
    throw err;
  }
}

/** A command wrapped for the sandbox. */
export interface WrappedCommand {
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

/**
 * Runs `fn` with `command` wrapped for `containment`. Sandboxed commands are
 * serialized in this process (see the module comment). `denyWrite` adds
 * paths the command may never write even inside a writable root.
 */
export function withSandbox<T>(
  command: string,
  shell: string,
  cwd: string,
  containment: Extract<BashContainment, { mode: 'sandbox' }>,
  denyWrite: readonly string[],
  signal: AbortSignal,
  fn: (wrapped: WrappedCommand) => Promise<T>,
): Promise<T> {
  const run = async (): Promise<T> => {
    const reason = await containmentUnavailableReason();
    if (reason !== null) throw new ToolError('containment-unavailable', reason);
    if (signal.aborted) throw new ToolError('cancelled', 'the run was stopped before bash started');
    let m: Manager;
    try {
      m = await manager();
      if (signal.aborted) throw new ToolError('cancelled', 'the run was stopped before bash started');
      if (!probed) {
        await probe(m, shell, signal);
        probed = true;
      }
    } catch (err) {
      if (err instanceof ToolError && err.code === 'cancelled') throw err;
      throw new ToolError('containment-unavailable', `sandbox runtime failed to start: ${errorMessage(err)}`);
    }
    let wrapped: WrappedCommand;
    try {
      wrapped = await m.wrapWithSandboxArgv(
        command,
        shell,
        {
          filesystem: {
            denyRead: [],
            allowWrite: containment.readOnly ? [] : [...containment.writableRoots],
            denyWrite: [...denyWrite],
          },
        },
        undefined,
        cwd,
      );
    } catch (err) {
      throw new ToolError('containment-unavailable', `sandbox runtime could not wrap the command: ${errorMessage(err)}`);
    }
    networkOpen = containment.network;
    try {
      return await fn(wrapped);
    } finally {
      networkOpen = false;
      try {
        m.cleanupAfterCommand();
      } catch {
        // Cleanup is best effort.
      }
    }
  };
  const next = tail.then(run, run);
  tail = next.catch(() => undefined);
  return next;
}
