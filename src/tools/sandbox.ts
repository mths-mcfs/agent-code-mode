import { ToolError, errorMessage } from '../core/errors.js';
import type { BashContainment } from '../core/types.js';
import { SANDBOX_NEEDS_SENTINEL, bootstrapEnv, spawnAndWait } from './bash.js';

/**
 * OS containment for `bash` through `@anthropic-ai/sandbox-runtime`
 * (bubblewrap on Linux, Seatbelt on macOS). The library keeps one global
 * configuration and one network proxy per process, so this module owns it
 * and serializes sandboxed commands in this process.
 *
 * Network: the library routes all traffic through its proxy and refuses an
 * allow-everything domain list, so "network on" is the library's ask
 * callback answering yes for every host. On Linux the command runs in its
 * own network namespace (`--unshare-net`) either way, and reaches the proxy
 * only through the library's Unix-socket bridge: with network on, only
 * clients that honor the proxy variables the library sets (curl, git, npm,
 * ...) reach the network; raw sockets never do.
 */

type SandboxModule = typeof import('@anthropic-ai/sandbox-runtime');
type Manager = SandboxModule['SandboxManager'];

let tail: Promise<unknown> = Promise.resolve();
let probed = false;

function serialized<T>(run: () => Promise<T>): Promise<T> {
  const next = tail.then(run, run);
  tail = next.catch(() => undefined);
  return next;
}

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
    const wrapped = asShellScript(await m.wrapWithSandboxArgv('true', shell, { filesystem: { denyRead: [], allowWrite: [], denyWrite: [] } }));
    const env = bootstrapEnv({ ...process.env, ...wrapped.env });
    const r = await spawnAndWait(wrapped.shell, wrapped.script, env, process.cwd(), PROBE_TIMEOUT_MS, signal, 4096, { sentinel: SANDBOX_NEEDS_SENTINEL });
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

/** A command wrapped for the sandbox: `<shell> -c <script>` with `env`. */
export interface WrappedCommand {
  readonly shell: string;
  readonly script: string;
  readonly env: NodeJS.ProcessEnv;
}

/** The library wraps a command as `[shell, '-c', script]` on Linux and macOS. */
function asShellScript(raw: { argv: readonly string[]; env: NodeJS.ProcessEnv }): WrappedCommand {
  const [shell, flag, script, ...extra] = raw.argv;
  if (shell === undefined || flag !== '-c' || script === undefined || extra.length > 0) {
    throw new Error(`unexpected sandbox command line shape: ${raw.argv.length} arguments`);
  }
  return { shell, script, env: raw.env };
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
  return serialized(async () => {
    const reason = await containmentUnavailableReason();
    if (reason !== null) throw new ToolError('containment-unavailable', reason);
    if (signal.aborted) throw new ToolError('cancelled', 'the run was stopped before bash started');
    const m = await loadManager();
    try {
      try {
        await m.initialize(
          { network: { allowedDomains: [], deniedDomains: [] }, filesystem: { denyRead: [], allowWrite: [], denyWrite: [] } },
          async () => containment.network,
        );
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
        wrapped = asShellScript(await m.wrapWithSandboxArgv(
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
        ));
      } catch (err) {
        throw new ToolError('containment-unavailable', `sandbox runtime could not wrap the command: ${errorMessage(err)}`);
      }
      return await fn(wrapped);
    } finally {
      try {
        m.cleanupAfterCommand();
      } catch {
        // Cleanup is best effort.
      }
      // Closes this command's proxy and stops its network bridges.
      await m.reset().catch(() => undefined);
    }
  });
}
