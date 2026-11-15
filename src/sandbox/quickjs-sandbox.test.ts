import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CallReply, LogLevel, SandboxOutcome, ToolResult } from '../core/types.js';
import { childEntryPath, childEnv, childExecArgv, QuickJsSandbox, type QuickJsSandboxOptions } from './quickjs-sandbox.js';

interface Recorded {
  readonly outcome: SandboxOutcome;
  readonly calls: { tool: string; args: unknown }[];
  readonly logs: { level: LogLevel; text: string }[];
  readonly elapsedMs: number;
}

type OnCall = (tool: string, args: unknown, index: number) => Promise<CallReply>;

/** Every binding call succeeds with `{tool, args}` after a host turn. */
const echo: OnCall = async (tool, args) => {
  await new Promise((resolve) => setImmediate(resolve));
  return ok({ tool, args });
};

/** Test replies carry arbitrary data; the sandbox forwards any JSON value. */
function ok(value: unknown): CallReply {
  return { ok: true, value: value as ToolResult };
}

async function run(
  code: string,
  options: { onCall?: OnCall; timeoutMs?: number; memoryBytes?: number; signal?: AbortSignal; sandbox?: QuickJsSandboxOptions } = {},
): Promise<Recorded> {
  const sandbox = new QuickJsSandbox(options.sandbox);
  const calls: Recorded['calls'] = [];
  const logs: Recorded['logs'] = [];
  const onCall = options.onCall ?? echo;
  const started = Date.now();
  const outcome = await sandbox.run(code, {
    timeoutMs: options.timeoutMs ?? 10_000,
    memoryBytes: options.memoryBytes ?? 64 * 1024 * 1024,
    signal: options.signal ?? new AbortController().signal,
    onCall: (tool, args) => {
      calls.push({ tool, args });
      return onCall(tool, args, calls.length - 1);
    },
    onLog: (level, text) => logs.push({ level, text }),
  });
  return { outcome, calls, logs, elapsedMs: Date.now() - started };
}

function value(outcome: SandboxOutcome): unknown {
  if (!outcome.ok) throw new Error(`expected ok, got ${outcome.kind}: ${outcome.error.name}: ${outcome.error.message}`);
  return outcome.value;
}

function failure(outcome: SandboxOutcome): Extract<SandboxOutcome, { ok: false }> {
  if (outcome.ok) throw new Error(`expected a failure, got ${JSON.stringify(outcome.value)}`);
  return outcome;
}

function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

describe('QuickJsSandbox: script semantics', () => {
  it('runs the code as an async function body and returns JSON', async () => {
    const { outcome } = await run('const a = [1, 2, 3]; return { sum: a.reduce((x, y) => x + y, 0), s: "ok", n: null, b: true };');
    expect(value(outcome)).toEqual({ sum: 6, s: 'ok', n: null, b: true });
  });

  it('returns null when the script returns nothing', async () => {
    expect(value((await run('const x = 1;')).outcome)).toBeNull();
  });

  it('normalizes binding arguments to the contract shapes', async () => {
    const { outcome, calls } = await run(`
      await bash('ls -la');
      await bash({ command: 'pwd', cwd: 'src', timeoutMs: 5 });
      await read({ path: 'a.txt', offset: 2, limit: 3 });
      await write({ path: 'b.txt', content: 'x' });
      await edit({ path: 'b.txt', oldString: 'x', newString: 'y', replaceAll: true });
      await grep({ pattern: 'TODO', glob: '*.ts', ignoreCase: true });
      await glob({ pattern: '**/*.ts', maxResults: 10 });
      return 'done';
    `);
    expect(value(outcome)).toBe('done');
    expect(calls).toEqual([
      { tool: 'bash', args: { command: 'ls -la' } },
      { tool: 'bash', args: { command: 'pwd', cwd: 'src', timeoutMs: 5 } },
      { tool: 'read', args: { path: 'a.txt', offset: 2, limit: 3 } },
      { tool: 'write', args: { path: 'b.txt', content: 'x' } },
      { tool: 'edit', args: { path: 'b.txt', oldString: 'x', newString: 'y', replaceAll: true } },
      { tool: 'grep', args: { pattern: 'TODO', glob: '*.ts', ignoreCase: true } },
      { tool: 'glob', args: { pattern: '**/*.ts', maxResults: 10 } },
    ]);
  });

  it('passes the binding result into the script', async () => {
    const { outcome } = await run('const r = await read({ path: "x" }); return r.args.path + ":" + r.tool;');
    expect(value(outcome)).toBe('x:read');
  });

  it('rehydrates binding errors as Error objects the script can catch', async () => {
    const { outcome } = await run(
      `
      const out = [];
      for (const path of ['denied', 'missing']) {
        try { await read({ path }); } catch (e) {
          out.push({ isError: e instanceof Error, name: e.name, message: e.message, code: e.code, source: e.source ?? null, reason: e.reason ?? null });
        }
      }
      return out;
    `,
      {
        onCall: async (_tool, args, index) =>
          index === 0
            ? { ok: false, error: { name: 'PermissionDenied', code: 'denied', source: 'hook', message: `blocked ${JSON.stringify(args)}` } }
            : { ok: false, error: { name: 'ToolError', code: 'not-found', message: 'no such file' } },
      },
    );
    expect(value(outcome)).toEqual([
      { isError: true, name: 'PermissionDenied', message: 'blocked {"path":"denied"}', code: 'denied', source: 'hook', reason: 'blocked {"path":"denied"}' },
      { isError: true, name: 'ToolError', message: 'no such file', code: 'not-found', source: null, reason: null },
    ]);
  });

  it('reports an uncaught throw with the script frames only', async () => {
    const { outcome } = await run('function inner() { throw new TypeError("bad thing"); }\ninner();');
    const f = failure(outcome);
    expect(f.kind).toBe('error');
    expect(f.error.name).toBe('TypeError');
    expect(f.error.message).toBe('bad thing');
    expect(f.error.stack).toContain('script.js:1');
    expect(f.error.stack).not.toContain('shim.js');
  });

  it('reports a syntax error', async () => {
    const f = failure((await run('return (;')).outcome);
    expect(f.kind).toBe('error');
    expect(f.error.name).toBe('SyntaxError');
  });

  it('reports thrown non-Error values', async () => {
    expect(failure((await run('throw "plain";')).outcome).error).toEqual({ name: 'Error', message: 'plain' });
    expect(failure((await run('throw { a: 1 };')).outcome).error.message).toBe('Uncaught { a: 1 }');
  });

  it('converts non-JSON return values to descriptive strings', async () => {
    const { outcome } = await run(`
      const cyclic = { name: 'c' }; cyclic.self = cyclic;
      return { fn: function named() {}, arrow: () => 1, sym: Symbol('s'), big: 12n, nan: NaN, inf: -Infinity,
        cyclic, date: new Date(0), err: new RangeError('r'), undef: undefined, arr: [undefined, 1], map: new Map([[1, 2]]) };
    `);
    expect(value(outcome)).toEqual({
      fn: '[Function: named]',
      arrow: '[Function: arrow]',
      sym: 'Symbol(s)',
      big: '12n',
      nan: 'NaN',
      inf: '-Infinity',
      cyclic: { name: 'c', self: '[Circular]' },
      date: '1970-01-01T00:00:00.000Z',
      err: 'RangeError: r',
      arr: [null, 1],
      map: {},
    });
  });

  it('turns a throwing getter into a description instead of crashing', async () => {
    const { outcome } = await run('return { get bad() { throw new Error("no"); }, ok: 1 };');
    expect(value(outcome)).toEqual({ bad: '[threw: no]', ok: 1 });
  });

  it('formats console output like Node and keeps the level', async () => {
    const { logs } = await run(`
      console.log('a', 1, { k: 'v', n: [1, 2] }, null, undefined);
      console.info('i'); console.warn('w'); console.error(new Error('boom'));
    `);
    expect(logs).toEqual([
      { level: 'log', text: "a 1 { k: 'v', n: [ 1, 2 ] } null undefined" },
      { level: 'info', text: 'i' },
      { level: 'warn', text: 'w' },
      { level: 'error', text: 'Error: boom' },
    ]);
  });

  it('fails fast when the script waits on a promise nothing can settle', async () => {
    const { outcome, elapsedMs } = await run('await new Promise(() => {});', { timeoutMs: 10_000 });
    expect(failure(outcome).error.name).toBe('Deadlock');
    expect(elapsedMs).toBeLessThan(5_000);
  });

  it('rejects a binding argument that is not JSON-serializable without calling the host', async () => {
    const { outcome, calls } = await run('const a = {}; a.a = a; try { await read(a); } catch (e) { return e.name + ": " + (e.message.includes("JSON") ? "json" : e.message); }');
    expect(value(outcome)).toBe('TypeError: json');
    expect(calls).toEqual([]);
  });
});

/**
 * Variables the OS layer adds to every child env even when the parent passes
 * an empty one: libuv on Windows copies these required ones, macOS adds its
 * text-encoding hint. None of them is a server secret.
 */
const PLATFORM_ENV = new Set(
  process.platform === 'win32'
    ? ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'PATH', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR']
    : process.platform === 'darwin'
      ? ['__CF_USER_TEXT_ENCODING']
      : [],
);

describe('QuickJsSandbox: no ambient authority', () => {
  it('exposes no host objects, module loading or timers', async () => {
    const { outcome, calls } = await run(`
      const names = ['require', 'process', 'fetch', 'Deno', 'Bun', 'std', 'os', 'module', 'exports', 'Buffer',
        'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask', 'performance', 'XMLHttpRequest', 'WebSocket',
        'importScripts', 'print', 'scriptArgs', '__acm_call', 'hostCall'];
      const types = {};
      for (const n of names) types[n] = typeof globalThis[n];
      const viaFunction = new Function('return this')();
      const viaEval = (0, eval)('this');
      const extra = (g) => Object.getOwnPropertyNames(g).filter((k) => !STANDARD.includes(k));
      let dynamicImport;
      try { await import('fs'); dynamicImport = 'loaded'; } catch (e) { dynamicImport = 'rejected'; }
      let nodeImport;
      try { await import('node:child_process'); nodeImport = 'loaded'; } catch (e) { nodeImport = 'rejected'; }
      return { types, same: viaFunction === globalThis && viaEval === globalThis, extraFn: extra(viaFunction), extraEval: extra(viaEval), dynamicImport, nodeImport };
    `.replace(
      'STANDARD',
      JSON.stringify([
        'Object', 'Function', 'Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError', 'InternalError',
        'AggregateError', 'Iterator', 'Array', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'decodeURI', 'decodeURIComponent', 'encodeURI',
        'encodeURIComponent', 'escape', 'unescape', 'Infinity', 'NaN', 'undefined', 'Number', 'Boolean', 'String', 'Math', 'Reflect', 'Symbol',
        'eval', 'globalThis', 'Date', 'RegExp', 'JSON', 'Proxy', 'Map', 'Set', 'WeakMap', 'WeakSet', 'ArrayBuffer', 'SharedArrayBuffer',
        'Uint8ClampedArray', 'Int8Array', 'Uint8Array', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'BigInt64Array',
        'BigUint64Array', 'Float16Array', 'Float32Array', 'Float64Array', 'DataView', 'Promise', 'BigInt', 'WeakRef', 'FinalizationRegistry',
        'console', 'bash', 'read', 'write', 'edit', 'grep', 'glob',
      ]),
    ));
    const result = value(outcome);
    expect(result).toEqual({
      types: Object.fromEntries(
        ['require', 'process', 'fetch', 'Deno', 'Bun', 'std', 'os', 'module', 'exports', 'Buffer', 'setTimeout', 'setInterval', 'setImmediate',
          'queueMicrotask', 'performance', 'XMLHttpRequest', 'WebSocket', 'importScripts', 'print', 'scriptArgs', '__acm_call', 'hostCall'].map((n) => [n, 'undefined']),
      ),
      same: true,
      extraFn: [],
      extraEval: [],
      dynamicImport: 'rejected',
      nodeImport: 'rejected',
    });
    expect(calls).toEqual([]);
  });

  it('starts the child with an env that has none of the server secrets', () => {
    const env = childEnv({ ACM_TEST_CANARY: 'secret', PATH: '/bin', HOME: '/home/x', GITHUB_TOKEN: 't' }, 'linux');
    expect(env).toEqual({});
    expect(childEnv({ ACM_TEST_CANARY: 'secret', SystemRoot: 'C:\\Windows' }, 'win32')).toEqual({ SystemRoot: 'C:\\Windows' });
  });

  it.runIf(process.allowedNodeEnvironmentFlags.has('--permission'))('runs the child process under the Node permission model', () => {
    const target = join(tmpdir(), `acm-permission-probe-${process.pid}`);
    const probe = `const r = {}; const fs = require('fs');
      try { fs.writeFileSync(${JSON.stringify(target)}, 'x'); r.write = 'allowed'; } catch (e) { r.write = e.code; }
      try { require('child_process').execFileSync(process.execPath, ['-e', '0']); r.spawn = 'allowed'; } catch (e) { r.spawn = e.code; }
      try { new Function('return 1')(); r.codegen = 'allowed'; } catch (e) { r.codegen = e.name; }
      r.env = Object.keys(process.env).filter((k) => !PLATFORM_ENV.has(k.toUpperCase()));
      console.log(JSON.stringify(r));`;
    const flags = childExecArgv(childEntryPath(), 256).filter((flag) => flag !== '--experimental-strip-types');
    const out = spawnSync(process.execPath, [...flags, '-e', probe.replace('PLATFORM_ENV', `new Set(${JSON.stringify([...PLATFORM_ENV])})`)], { env: childEnv(), encoding: 'utf8' });
    expect(JSON.parse(out.stdout)).toEqual({ write: 'ERR_ACCESS_DENIED', spawn: 'ERR_ACCESS_DENIED', codegen: 'EvalError', env: [] });
    expect(existsSync(target)).toBe(false);
  });

  it('never lets the script observe a canary secret from the server env', async () => {
    const canary = `canary-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    process.env.ACM_TEST_CANARY = canary;
    let childEnviron = '';
    try {
      let pid = 0;
      const recorded = await run(
        `
        const seen = [];
        const scan = (o, depth) => { if (depth > 3 || o === null || (typeof o !== 'object' && typeof o !== 'function')) return;
          for (const k of Object.getOwnPropertyNames(o)) { seen.push(k); try { scan(o[k], depth + 1); } catch {} } };
        scan(globalThis, 0);
        try { await bash({ command: 'echo $ACM_TEST_CANARY' }); } catch (e) { seen.push(e.message, String(e.stack)); }
        try { await read({ path: '/proc/self/environ' }); } catch (e) { seen.push(e.message); }
        try { null.x; } catch (e) { seen.push(String(e.stack)); }
        console.log(seen.join(' '));
        return seen.join(' ');
      `,
        {
          sandbox: { onSpawn: (p) => (pid = p) },
          onCall: async (tool) => {
            if (process.platform === 'linux' && pid > 0 && childEnviron === '') childEnviron = readFileSync(`/proc/${pid}/environ`, 'utf8');
            return { ok: false, error: { name: 'ToolError', code: 'tool-error', message: `${tool} failed` } };
          },
        },
      );
      const everything = JSON.stringify(recorded);
      expect(recorded.outcome.ok).toBe(true);
      expect(everything).not.toContain(canary);
      if (process.platform === 'linux') {
        expect(childEnviron).not.toContain(canary);
        expect(childEnviron).not.toContain('PATH=');
      }
    } finally {
      delete process.env.ACM_TEST_CANARY;
    }
  });
});

describe('QuickJsSandbox: prototype pollution', () => {
  it('keeps host prototypes intact and parses hostile keys as own data', async () => {
    const { outcome } = await run(`
      Object.prototype.polluted = 1;
      Array.prototype.map = function () { return 'hijacked'; };
      JSON.stringify = () => '"hijacked"';
      Promise.prototype.then = function () { throw new Error('hijacked then'); };
      const viaParse = JSON.parse('{"__proto__": {"injected": true}, "constructor": {"prototype": {"injected": true}}}');
      const literal = { ['__proto__']: { injected: true }, constructor: { prototype: { injected: true } }, list: [1, 2] };
      return { viaParse, literal };
    `);
    const result = value(outcome);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect([1].map((x) => x + 1)).toEqual([2]);
    expect(Object.prototype).not.toHaveProperty('injected');
    const top = result as Record<string, Record<string, unknown>>;
    for (const key of ['viaParse', 'literal'] as const) {
      const obj = top[key];
      expect(obj).toBeDefined();
      if (!obj) continue;
      expect(Object.getPrototypeOf(obj)).toBe(Object.prototype);
      expect(Object.keys(obj)).toContain('__proto__');
      expect((obj as { injected?: unknown }).injected).toBeUndefined();
      expect(({} as { injected?: unknown }).injected).toBeUndefined();
      expect(Object.hasOwn(obj, 'polluted')).toBe(false);
    }
  });

  it('keeps bindings working after the script overrides intrinsics', async () => {
    const { outcome } = await run(`
      JSON.parse = () => 'hijacked';
      JSON.stringify = () => 'hijacked';
      Promise.prototype.then = function () { throw new Error('hijacked then'); };
      const r = read({ path: 'p' });
      return 'called';
    `);
    expect(value(outcome)).toBe('called');
  });
});

describe('QuickJsSandbox: resource abuse', () => {
  it('stops an infinite loop with outcome timeout within the deadline plus a small margin', async () => {
    const { outcome, elapsedMs } = await run('for (;;) {}', { timeoutMs: 1_000 });
    expect(failure(outcome).kind).toBe('timeout');
    expect(elapsedMs).toBeLessThan(1_000 + 1_000);
  });

  it('stops a loop that catches every error', async () => {
    const { outcome, elapsedMs } = await run('for (;;) { try { for (;;) {} } catch (e) {} }', { timeoutMs: 800 });
    expect(failure(outcome).kind).toBe('timeout');
    expect(elapsedMs).toBeLessThan(800 + 1_000);
  });

  it('times out while a binding never replies', async () => {
    const { outcome, elapsedMs } = await run('await read({ path: "slow" });', { timeoutMs: 600, onCall: () => new Promise<CallReply>(() => undefined) });
    expect(failure(outcome).kind).toBe('timeout');
    expect(elapsedMs).toBeLessThan(600 + 1_000);
  });

  it('reports an allocation bomb as oom', async () => {
    const arrays = await run('const a = []; for (let i = 0; ; i++) a.push("x".repeat(100000) + i);', { memoryBytes: 32 * 1024 * 1024 });
    expect(failure(arrays.outcome).kind).toBe('oom');
    const objects = await run('const a = []; for (;;) a.push({ a: 1, b: [1, 2, 3] });', { memoryBytes: 32 * 1024 * 1024 });
    expect(failure(objects.outcome).kind).toBe('oom');
    const single = await run('return "x".repeat(1e9).length;', { memoryBytes: 32 * 1024 * 1024 });
    expect(failure(single.outcome).kind).toBe('oom');
  });

  it('enforces memoryBytes as the real heap limit', async () => {
    const fill = (mib: number): string => `const a = []; for (let i = 0; i < ${mib * 10}; i++) a.push("x".repeat(100000) + i); return a.length;`;
    expect(value((await run(fill(16), { memoryBytes: 48 * 1024 * 1024 })).outcome)).toBe(160);
    expect(failure((await run(fill(96), { memoryBytes: 48 * 1024 * 1024 })).outcome).kind).toBe('oom');
  });

  it('turns deep recursion into a script error, not a crash', async () => {
    const f = failure((await run('function f(n) { return f(n + 1) + 1; } return f(0);')).outcome);
    expect(f.kind).toBe('error');
    expect(f.error.name).toBe('RangeError');
    const caught = await run('function f() { f(); } try { f(); } catch (e) { return e.name; }');
    expect(value(caught.outcome)).toBe('RangeError');
  });

  it('refuses binding calls after the cap and never forwards them', async () => {
    const { outcome, calls } = await run(
      `
      const settled = await Promise.allSettled(Array.from({ length: 10000 }, (_, i) => glob({ pattern: String(i) })));
      const rejected = settled.filter((s) => s.status === 'rejected');
      return { fulfilled: settled.length - rejected.length, rejected: rejected.length, sample: rejected[0].reason.message, code: rejected[0].reason.code };
    `,
      { onCall: async () => ok({ files: [], truncated: false }) },
    );
    expect(value(outcome)).toEqual({ fulfilled: 2000, rejected: 8000, sample: expect.stringContaining('at most 2000 calls'), code: 'tool-error' });
    expect(calls).toHaveLength(2000);
  });

  it('caps console spam', async () => {
    const { logs, outcome } = await run('for (let i = 0; i < 200000; i++) console.log("spam line " + i + " " + "y".repeat(80));', {
      sandbox: { maxLogBytes: 256 * 1024 },
    });
    expect(outcome.ok).toBe(true);
    const bytes = logs.reduce((n, l) => n + Buffer.byteLength(l.text) + 1, 0);
    expect(bytes).toBeLessThanOrEqual(256 * 1024 + 1024);
    expect(logs.at(-1)?.text).toContain('console output truncated');
  });

  it('cuts a single huge console line', async () => {
    const { logs } = await run('console.log("z".repeat(500000));');
    expect(logs).toHaveLength(1);
    expect(logs[0]?.text.length).toBeLessThan(10_100);
    expect(logs[0]?.text).toContain('[truncated]');
  });

  it('bounds a gigantic return value', async () => {
    const str = failure((await run('return "x".repeat(5 * 1024 * 1024);')).outcome);
    expect(str.error.name).toBe('ResultTooLarge');
    const arr = await run('return new Array(1e8);');
    expect(failure(arr.outcome).error.name).toBe('ResultTooLarge');
    expect(arr.elapsedMs).toBeLessThan(5_000);
  });
});

describe('QuickJsSandbox: concurrency', () => {
  it('resolves Promise.all of 200 bindings answered in reverse order', async () => {
    const waiting: (() => void)[] = [];
    const { outcome } = await run('return await Promise.all(Array.from({ length: 200 }, (_, i) => read({ path: "f" + i })));', {
      onCall: (_tool, args, index) =>
        new Promise<CallReply>((resolve) => {
          waiting.push(() => resolve(ok({ echo: args, index })));
          if (waiting.length === 200) {
            for (const answer of [...waiting].reverse()) setImmediate(answer);
          }
        }),
    });
    const result = value(outcome) as { echo: { path: string }; index: number }[];
    expect(result).toHaveLength(200);
    result.forEach((r, i) => {
      expect(r.echo.path).toBe(`f${i}`);
      expect(r.index).toBe(i);
    });
  });

  it('keeps running when one binding inside Promise.allSettled rejects', async () => {
    const { outcome } = await run(
      'const s = await Promise.allSettled([read({ path: "a" }), read({ path: "b" }), read({ path: "c" })]); return s.map((x) => x.status + ":" + (x.status === "fulfilled" ? x.value.path : x.reason.code));',
      {
        onCall: async (_tool, args) => {
          const path = (args as { path: string }).path;
          await new Promise((resolve) => setTimeout(resolve, path === 'a' ? 20 : 1));
          return path === 'b' ? { ok: false, error: { name: 'ToolError', code: 'not-found', message: 'missing' } } : ok({ path });
        },
      },
    );
    expect(value(outcome)).toEqual(['fulfilled:a', 'rejected:not-found', 'fulfilled:c']);
  });
});

describe('QuickJsSandbox: cancellation', () => {
  it('kills the child during a pending binding and forwards no later call', async () => {
    const controller = new AbortController();
    let pid = 0;
    const started = Date.now();
    const { outcome, calls } = await run('await read({ path: "first" }); await read({ path: "second" }); return "finished";', {
      signal: controller.signal,
      sandbox: { onSpawn: (p) => (pid = p) },
      onCall: async () => {
        setTimeout(() => controller.abort(), 10);
        await new Promise((resolve) => setTimeout(resolve, 100));
        return ok({ late: true });
      },
    });
    expect(failure(outcome).kind).toBe('killed');
    expect(pid).toBeGreaterThan(0);
    while (!processGone(pid) && Date.now() - started < 1_000) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(processGone(pid)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(calls).toEqual([{ tool: 'read', args: { path: 'first' } }]);
  });

  it('does not start a child when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let spawned = false;
    const { outcome } = await run('return 1;', { signal: controller.signal, sandbox: { onSpawn: () => (spawned = true) } });
    expect(failure(outcome).kind).toBe('killed');
    expect(spawned).toBe(false);
  });

  it('never reuses a child across runs', async () => {
    const pids: number[] = [];
    const sandbox = { onSpawn: (p: number) => pids.push(p) };
    await run('globalThis.leak = 42; return 1;', { sandbox });
    const second = await run('return typeof globalThis.leak;', { sandbox });
    expect(value(second.outcome)).toBe('undefined');
    expect(pids).toHaveLength(2);
    expect(pids[0]).not.toBe(pids[1]);
  });
});
