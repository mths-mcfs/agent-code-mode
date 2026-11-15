import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorMessage } from '../core/errors.js';
import type { Sandbox, SandboxOutcome, SandboxRunOptions } from '../core/types.js';
import type { ParentMessage, SandboxLimits } from './protocol.js';
import { ChildSession, killedOutcome } from './session.js';

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
  /** QuickJS stack limit. Default 256 KiB (deeper values overflow the host stack of the WASM build). */
  readonly stackBytes?: number;
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
  stackBytes: 256 * 1024,
  childHeapMb: 256,
} as const;

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

function packageRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

function nodeModulesDirOf(file: string): string {
  let dir = dirname(file);
  for (;;) {
    if (basename(dir) === 'node_modules') return dir;
    const parent = dirname(dir);
    if (parent === dir) return dirname(file);
    dir = parent;
  }
}

/** Directories the child may read under the Node permission model: this package and its runtime dependencies. */
function readableRoots(): string[] {
  const require = createRequire(import.meta.url);
  const roots = new Set<string>([packageRoot(here)]);
  for (const spec of ['quickjs-emscripten-core', '@jitl/quickjs-ng-wasmfile-release-sync', 'zod']) {
    try {
      roots.add(nodeModulesDirOf(require.resolve(spec)));
    } catch {
      // Not resolvable with CommonJS conditions: the child fails to start and the run ends `killed`.
    }
  }
  return [...roots];
}

function supportsFlag(flag: string): boolean {
  return process.allowedNodeEnvironmentFlags.has(flag);
}

/** Node flags of the child. */
export function childExecArgv(entry: string, heapMb: number): string[] {
  const args = [`--max-old-space-size=${heapMb}`, '--disallow-code-generation-from-strings'];
  if (entry.endsWith('.ts') && !('typescript' in process.features && process.features.typescript)) args.push('--experimental-strip-types');
  if (supportsFlag('--permission')) {
    args.push('--permission');
    for (const root of readableRoots()) args.push(`--allow-fs-read=${root}`);
  }
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
    const startedAt = Date.now();
    if (opts.signal.aborted) return Promise.resolve(killedOutcome('the run was stopped before the script started'));
    const o = this.#options;
    const limits: SandboxLimits = {
      memoryBytes: positive(opts.memoryBytes, DEFAULT_SANDBOX_MEMORY_BYTES),
      stackBytes: positive(o.stackBytes, DEFAULTS.stackBytes),
      maxCalls: positive(o.maxCalls, DEFAULTS.maxCalls),
      maxLogBytes: positive(o.maxLogBytes, DEFAULTS.maxLogBytes),
      maxLogLineChars: positive(o.maxLogLineChars, DEFAULTS.maxLogLineChars),
      maxResultChars: positive(o.maxResultChars, DEFAULTS.maxResultChars),
      maxArgsChars: positive(o.maxArgsChars, DEFAULTS.maxArgsChars),
    };
    const timeoutMs = positive(opts.timeoutMs, 1);
    // Each string field is bounded in characters; JSON escaping turns one character into at most 6 bytes.
    const maxFrameBytes = 6 * Math.max(limits.maxArgsChars, limits.maxResultChars, limits.maxLogLineChars + 200) + 64 * 1024;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, [...childExecArgv(this.#entry, positive(o.childHeapMb, DEFAULTS.childHeapMb)), this.#entry], {
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
    if (child.pid !== undefined) o.onSpawn?.(child.pid);

    const write = (message: ParentMessage): void => {
      if (!stdin.destroyed) stdin.write(`${JSON.stringify(message)}\n`);
    };
    const session = new ChildSession({
      limits,
      maxFrameBytes,
      hooks: {
        onCall: (tool, args) => opts.onCall(tool, args),
        onLog: (level, text) => opts.onLog(level, text),
        send: write,
        kill: () => {
          child.kill('SIGKILL');
          stdin.destroy();
        },
      },
    });

    stdout.on('data', (chunk: Buffer) => session.feed(chunk));
    stderr.on('data', (chunk: Buffer) => session.stderr(chunk));
    stdin.on('error', () => undefined);
    child.on('error', (err) => session.kill(`sandbox process error: ${errorMessage(err)}`));
    child.on('close', (exitCode, signal) => session.exited(exitCode, signal));

    const timer = setTimeout(
      () => session.finish({ ok: false, kind: 'timeout', error: { name: 'Timeout', message: `the script did not finish within ${timeoutMs} ms` } }),
      timeoutMs,
    );
    const onAbort = (): void => session.kill('the run was stopped');
    opts.signal.addEventListener('abort', onAbort, { once: true });

    write({ type: 'start', code, timeoutMs: Math.max(1, timeoutMs - (Date.now() - startedAt)), limits });

    return session.outcome.finally(() => {
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
    });
  }
}
