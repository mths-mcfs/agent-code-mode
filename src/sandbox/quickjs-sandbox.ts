import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { errorMessage } from '../core/errors.js';
import { MAX_CODE_CHARS } from '../core/schemas.js';
import type { Sandbox, SandboxOutcome, SandboxRunOptions } from '../core/types.js';
import type { ParentMessage, SandboxLimits } from './protocol.js';
import { ChildSession, killedOutcome } from './session.js';
import { BoundedWriter } from './writer.js';

/** Default QuickJS heap limit when `memoryBytes` is not usable. */
export const DEFAULT_SANDBOX_MEMORY_BYTES = 128 * 1024 * 1024;

/** Limits and process settings of `QuickJsSandbox`. Every field has a default. */
export interface QuickJsSandboxOptions {
  /** Maximum binding calls per run. Default 2,000. */
  readonly maxCalls?: number;
  /** Maximum console bytes per run. Default 1 MiB. */
  readonly maxLogBytes?: number;
  /** Maximum characters of one console line. Default 10,000. */
  readonly maxLogLineChars?: number;
  /** Maximum characters of the JSON return value. Default 1 MiB. */
  readonly maxResultChars?: number;
  /** Maximum characters of the JSON arguments of one call. Default 4 MiB. */
  readonly maxArgsChars?: number;
  /** QuickJS stack limit. Default 128 KiB: the WASM build runs on the Node stack, and 256 KiB already overflows it on macOS with Node 22. */
  readonly stackBytes?: number;
  /**
   * Most bytes of binding results that may wait for the child to read them.
   * A script that starts calls and then never yields (a busy loop) stops
   * reading; past this cap the run ends with outcome `oom`. Default 16 MiB.
   */
  readonly maxPendingReplyBytes?: number;
  /** Most bytes of binding results sent to the child in one run; past it the run ends with outcome `oom`. Default 512 MiB. */
  readonly maxReplyBytes?: number;
  /** `--max-old-space-size` of the child process, in MiB. Default 256. */
  readonly childHeapMb?: number;
  /** Called with the pid of each child process (tests use it to check the child is gone). */
  readonly onSpawn?: (pid: number) => void;
}

const DEFAULTS = {
  maxCalls: 2_000,
  maxLogBytes: 1024 * 1024,
  maxLogLineChars: 10_000,
  maxResultChars: 1024 * 1024,
  maxArgsChars: 4 * 1024 * 1024,
  stackBytes: 128 * 1024,
  childHeapMb: 256,
  maxPendingReplyBytes: 16 * 1024 * 1024,
  maxReplyBytes: 512 * 1024 * 1024,
} as const;

/** Most bytes the child may send in one run (calls, logs and the outcome), unless one frame needs more; past it the run ends with outcome `oom`. */
const MAX_CHILD_OUTPUT_BYTES = 64 * 1024 * 1024;
/** Most bytes of messages the child may queue on its stdout while the parent has not read them. */
const CHILD_PENDING_OUTPUT_BYTES = 64 * 1024 * 1024;
/** Largest `start` message: the longest accepted script, JSON-escaped, plus the limits. */
const MAX_START_BYTES = 6 * MAX_CODE_CHARS + 64 * 1024;

const here = dirname(fileURLToPath(import.meta.url));

/** The child entry: compiled `child.js` next to this file, or `child.ts` when running from source. */
export function childEntryPath(): string {
  const compiled = join(here, 'child.js');
  return existsSync(compiled) ? compiled : join(here, 'child.ts');
}

/**
 * Environment of the child: nothing from the server env except what Node
 * itself needs to start on Windows. No tokens, no PATH, no HOME.
 */
export function childEnv(parentEnv: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const env: Record<string, string> = {};
  if (platform === 'win32') {
    for (const key of ['SystemRoot', 'SYSTEMROOT']) {
      const value = parentEnv[key];
      if (value !== undefined) env[key] = value;
    }
  }
  return env;
}

/** Packages the child imports; their runtime dependencies come from their package.json files. */
const CHILD_PACKAGES = ['quickjs-emscripten-core', '@jitl/quickjs-ng-wasmfile-release-sync', 'zod'];
const ManifestSchema = z.object({ dependencies: z.record(z.string(), z.string()).optional() });

/**
 * What the child may read, with symlinks preserved: its entry directory, the directories of the packages it loads
 * and, as exact paths, each package.json and `node_modules/<name>` candidate Node looks up on the way.
 */
export function readGrants(): { readonly dirs: string[]; readonly files: string[] } {
  const dirs = new Set([here]);
  const files = new Set<string>();
  for (let dir = here; ; dir = dirname(dir)) {
    files.add(join(dir, 'package.json'));
    if (existsSync(join(dir, 'package.json')) || dirname(dir) === dir) break;
  }
  const visit = (from: string, name: string): void => {
    for (let dir = from; ; dir = dirname(dir)) {
      const candidate = join(dir, 'node_modules', name);
      if (existsSync(join(candidate, 'package.json'))) {
        if (dirs.has(candidate)) return;
        dirs.add(candidate);
        const manifest = ManifestSchema.parse(JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8')));
        for (const dependency of Object.keys(manifest.dependencies ?? {})) visit(candidate, dependency);
        return;
      }
      files.add(candidate);
      if (dirname(dir) === dir) return;
    }
  };
  for (const name of CHILD_PACKAGES) visit(here, name);
  // A grant inside a granted directory is redundant, and Node's permission tree can lose a shorter grant added after a longer one.
  const outside = (path: string): boolean => ![...dirs].some((dir) => path.startsWith(dir + sep));
  return { dirs: [...dirs].filter(outside), files: [...files].filter(outside) };
}

/** Thrown when this Node cannot start the child under its permission model. */
export class SandboxUnavailableError extends Error {
  override readonly name = 'SandboxUnavailableError';
}

/**
 * The flag that turns on Node's permission model: `--permission` (Node
 * 22.13+, 23.5+) or `--experimental-permission` (Node 22.0 to 22.12).
 */
export function permissionFlag(flags: ReadonlySet<string> = process.allowedNodeEnvironmentFlags): '--permission' | '--experimental-permission' | undefined {
  if (flags.has('--permission')) return '--permission';
  if (flags.has('--experimental-permission')) return '--experimental-permission';
  return undefined;
}

/**
 * Node flags of the child. Fails closed: without a permission model the
 * child would have the server's full file, process and worker access, so
 * this throws `SandboxUnavailableError` instead of returning flags without it.
 */
export function childExecArgv(entry: string, heapMb: number, flags: ReadonlySet<string> = process.allowedNodeEnvironmentFlags): string[] {
  const permission = permissionFlag(flags);
  if (permission === undefined) {
    throw new SandboxUnavailableError(`Node ${process.version} has no permission model (--permission or --experimental-permission); the sandbox refuses to start without it`);
  }
  const args = [`--max-old-space-size=${heapMb}`, '--disallow-code-generation-from-strings'];
  if (entry.endsWith('.ts') && !('typescript' in process.features && process.features.typescript)) args.push('--experimental-strip-types');
  args.push(permission, '--preserve-symlinks', '--preserve-symlinks-main');
  const { dirs, files } = readGrants();
  // Node 22.0 to 22.12 grants a directory itself only, unless it ends with the `*` wildcard; one flag per path adds up on every version.
  const paths = [...files, ...(permission === '--permission' ? dirs : dirs.map((dir) => join(dir, '*')))];
  if (permission === '--experimental-permission' && paths.some((path) => path.includes(','))) {
    throw new SandboxUnavailableError(`Node ${process.version} cannot grant read access to a path that contains a comma; upgrade to Node 22.13 or later`);
  }
  for (const path of paths) args.push(`--allow-fs-read=${path}`);
  return args;
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

/**
 * The real sandbox: each run starts a fresh Node child process (minimal env,
 * bounded heap, Node permission model when available) that runs the script
 * in a QuickJS-ng WASM VM. The parent enforces the deadline and cancellation
 * with SIGKILL and validates every message from the child. A child is never
 * reused.
 */
export class QuickJsSandbox implements Sandbox {
  readonly #options: QuickJsSandboxOptions;
  readonly #entry: string;

  constructor(options: QuickJsSandboxOptions = {}) {
    this.#options = options;
    this.#entry = childEntryPath();
  }

  run(code: string, opts: SandboxRunOptions): Promise<SandboxOutcome> {
    const startedAt = performance.now();
    if (opts.signal.aborted) return Promise.resolve(killedOutcome('the run was stopped before the script started'));
    const o = this.#options;
    const sized = {
      memoryBytes: positive(opts.memoryBytes, DEFAULT_SANDBOX_MEMORY_BYTES),
      stackBytes: positive(o.stackBytes, DEFAULTS.stackBytes),
      maxCalls: positive(o.maxCalls, DEFAULTS.maxCalls),
      maxLogBytes: positive(o.maxLogBytes, DEFAULTS.maxLogBytes),
      maxLogLineChars: positive(o.maxLogLineChars, DEFAULTS.maxLogLineChars),
      maxResultChars: positive(o.maxResultChars, DEFAULTS.maxResultChars),
      maxArgsChars: positive(o.maxArgsChars, DEFAULTS.maxArgsChars),
    };
    const timeoutMs = positive(opts.timeoutMs, 1);
    const deadline = startedAt + timeoutMs;
    // Each string field is bounded in characters; JSON escaping turns one character into at most 6 bytes.
    const maxFrameBytes = 6 * Math.max(sized.maxArgsChars, sized.maxResultChars, sized.maxLogLineChars + 200) + 64 * 1024;
    const limits: SandboxLimits = { ...sized, maxPendingOutputBytes: Math.max(CHILD_PENDING_OUTPUT_BYTES, maxFrameBytes) };

    let execArgv: string[];
    try {
      execArgv = childExecArgv(this.#entry, positive(o.childHeapMb, DEFAULTS.childHeapMb));
    } catch (err) {
      return Promise.resolve({ ok: false, kind: 'killed', error: { name: 'SandboxUnavailable', message: errorMessage(err) } });
    }

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, [...execArgv, this.#entry], {
        env: childEnv(),
        cwd: here,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      return Promise.resolve(killedOutcome(`could not start the sandbox process: ${errorMessage(err)}`));
    }
    const { stdin, stdout, stderr } = child;
    if (!stdin || !stdout || !stderr) {
      child.kill('SIGKILL');
      return Promise.resolve(killedOutcome('the sandbox process has no stdio pipes'));
    }

    let session: ChildSession | undefined;
    const writer = new BoundedWriter(stdin, {
      maxPendingBytes: positive(o.maxPendingReplyBytes, DEFAULTS.maxPendingReplyBytes),
      maxTotalBytes: positive(o.maxReplyBytes, DEFAULTS.maxReplyBytes),
      onOverflow: (message) => session?.finish({ ok: false, kind: 'oom', error: { name: 'ReplyBufferFull', message } }),
    });
    const active = new ChildSession({
      limits,
      maxFrameBytes,
      maxTotalBytes: Math.max(MAX_CHILD_OUTPUT_BYTES, 2 * maxFrameBytes),
      deadline,
      timeoutMs,
      hooks: {
        onCall: (tool, args) => {
          // Never forward a call once the run is stopped, even if the abort event has not been seen yet.
          if (opts.signal.aborted) {
            active.kill('the run was stopped');
            return Promise.resolve({ ok: false, error: { name: 'ToolError', code: 'cancelled', message: 'the run was stopped' } });
          }
          return opts.onCall(tool, args);
        },
        onLog: (level, text) => opts.onLog(level, text),
        send: (message) => void writer.writeJson(message),
        kill: () => {
          writer.close();
          child.kill('SIGKILL');
          stdin.destroy();
        },
      },
    });
    session = active;

    // Listen for abort before any callback runs, then re-check: an abort during `onSpawn` must stop the run.
    const onAbort = (): void => active.kill('the run was stopped');
    opts.signal.addEventListener('abort', onAbort, { once: true });
    if (child.pid !== undefined) {
      try {
        o.onSpawn?.(child.pid);
      } catch (err) {
        active.kill(`onSpawn failed: ${errorMessage(err)}`);
      }
    }
    if (opts.signal.aborted) active.kill('the run was stopped before the script started');

    stdout.on('data', (chunk: Buffer) => active.feed(chunk));
    stderr.on('data', (chunk: Buffer) => active.stderr(chunk));
    stdin.on('error', () => undefined);
    child.on('error', (err) => active.kill(`sandbox process error: ${errorMessage(err)}`));
    child.on('close', (exitCode, signal) => active.exited(exitCode, signal));

    const timer = setTimeout(() => active.timeOut(), Math.max(0, deadline - performance.now()));
    if (!active.finished && performance.now() >= deadline) active.timeOut();
    if (!active.finished) {
      // `start` has its own size limit; the reply quotas count only binding results.
      const start = Buffer.from(`${JSON.stringify({ type: 'start', code, timeoutMs: Math.max(1, Math.floor(deadline - performance.now())), limits } satisfies ParentMessage)}\n`, 'utf8');
      if (start.length > MAX_START_BYTES) active.kill(`the script is larger than ${MAX_START_BYTES} bytes`);
      else stdin.write(start);
    }

    return active.outcome.finally(() => {
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
    });
  }
}
