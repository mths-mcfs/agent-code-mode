import { describe, expect, it } from 'vitest';
import { makeContext } from '../testing/context.js';
import { FakeSandbox, type FakeStep } from '../testing/fake-sandbox.js';
import { MemoryToolRuntime } from '../testing/memory-tool-runtime.js';
import { StaticHostAdapter, type StaticHostAdapterOptions } from '../testing/static-host-adapter.js';
import { resolveTimeoutMs, runScript, toRunRequest } from './run.js';
import type { Sandbox } from './types.js';

function deps(adapterOpts: StaticHostAdapterOptions = {}, files: Record<string, string> = {}, sandbox: Sandbox = new FakeSandbox()) {
  return {
    sandbox,
    adapter: new StaticHostAdapter(adapterOpts),
    tools: new MemoryToolRuntime({ root: '/ws', files }),
    ctx: makeContext('/ws'),
    stopGraceMs: 100,
  };
}

const script = (steps: FakeStep[]): string => JSON.stringify(steps);
const denyForbidden: StaticHostAdapterOptions = {
  rules: [(p) => (p.tool === 'write' && p.effect.absPath.endsWith('forbidden.txt') ? { kind: 'deny', reason: 'nope' } : undefined)],
};

describe('resolveTimeoutMs', () => {
  it('defaults to 120 s and clamps to the server cap and to 600 s', () => {
    expect(resolveTimeoutMs(undefined)).toBe(120_000);
    expect(resolveTimeoutMs(10_000_000)).toBe(600_000);
    expect(resolveTimeoutMs(90_000, 55_000)).toBe(55_000);
    expect(resolveTimeoutMs(undefined, 55_000)).toBe(55_000);
    expect(resolveTimeoutMs(0)).toBe(1);
    expect(toRunRequest({ code: 'x' })).toEqual({ code: 'x', transaction: false, timeoutMs: 120_000 });
  });
});

describe('runScript', () => {
  it('returns the script value, logs, calls, changed files and diff', async () => {
    const d = deps({}, { 'a.txt': 'hi\n' });
    const result = await runScript(
      { code: script([{ log: 'start' }, { log: 'careful', level: 'warn' }, { tool: 'read', args: { path: 'a.txt' } }, { tool: 'write', args: { path: 'b.txt', content: 'b\n' } }]), transaction: false, timeoutMs: 5_000 },
      d,
    );
    expect(result.ok).toBe(true);
    expect(result.logs).toEqual(['start', 'warn: careful']);
    expect(result.calls.map((c) => c.decision)).toEqual(['allowed', 'allowed']);
    expect(result.changedFiles).toEqual(['b.txt']);
    expect(result.diff).toContain('+b');
    expect(Array.isArray(result.result)).toBe(true);
  });

  it('keeps going after a denied call outside a transaction', async () => {
    const d = deps(denyForbidden);
    const result = await runScript(
      { code: script([{ tool: 'write', args: { path: 'forbidden.txt', content: 'x' } }, { tool: 'write', args: { path: 'ok.txt', content: 'y' } }]), transaction: false, timeoutMs: 5_000 },
      d,
    );
    expect(result.ok).toBe(true);
    expect(result.calls.map((c) => c.decision)).toEqual(['denied', 'allowed']);
    expect(d.tools.read('ok.txt')).toBe('y');
  });

  it('aborts and rolls back a transaction on the first denied call', async () => {
    const d = deps(denyForbidden, { 'a.txt': 'original' });
    const result = await runScript(
      {
        code: script([
          { tool: 'write', args: { path: 'a.txt', content: 'changed' } },
          { tool: 'bash', args: { command: 'echo hi' } },
          { tool: 'write', args: { path: 'forbidden.txt', content: 'x' } },
          { tool: 'write', args: { path: 'after.txt', content: 'never' } },
        ]),
        transaction: true,
        timeoutMs: 5_000,
      },
      d,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ kind: 'denied', name: 'PermissionDenied' });
    expect(result.error?.message).toContain('c3');
    expect(result.rolledBack?.restored).toEqual(['/ws/a.txt']);
    expect(d.tools.read('a.txt')).toBe('original');
    expect(d.tools.read('after.txt')).toBeUndefined();
    expect(result.warnings.join('\n')).toContain('bash effects are never rolled back');
  });

  it('rolls back on script error and reports files changed externally', async () => {
    const d = deps({}, { 'a.txt': 'original', 'b.txt': 'original b' });
    const sandbox: Sandbox = {
      run: async (code, opts) => {
        await opts.onCall('write', { path: 'a.txt', content: 'mine' });
        await opts.onCall('write', { path: 'b.txt', content: 'mine b' });
        d.tools.externalWrite('b.txt', 'theirs');
        return { ok: false, kind: 'error', error: { name: 'TypeError', message: 'x is undefined', stack: 'at line 3' } };
      },
    };
    const result = await runScript({ code: 'ignored', transaction: true, timeoutMs: 5_000 }, { ...d, sandbox });
    expect(result.error).toMatchObject({ kind: 'error', name: 'TypeError', stack: 'at line 3' });
    expect(result.rolledBack).toEqual({ restored: ['/ws/a.txt'], skipped: [{ path: '/ws/b.txt', reason: 'changed-externally' }] });
    expect(d.tools.read('a.txt')).toBe('original');
    expect(d.tools.read('b.txt')).toBe('theirs');
  });

  it('times out, refuses later calls and rolls back', async () => {
    const d = deps({}, {});
    const result = await runScript(
      { code: script([{ tool: 'write', args: { path: 'a.txt', content: 'x' } }, { sleep: 2_000 }, { tool: 'write', args: { path: 'b.txt', content: 'y' } }]), transaction: true, timeoutMs: 50 },
      d,
    );
    expect(result.error?.kind).toBe('timeout');
    expect(d.tools.files.size).toBe(0);
    expect(result.rolledBack?.restored).toEqual(['/ws/a.txt']);
  });

  it('treats a sandbox that ignores stop as killed after the grace period', async () => {
    const hanging: Sandbox = { run: () => new Promise(() => undefined) };
    const controller = new AbortController();
    const pending = runScript({ code: 'x', transaction: false, timeoutMs: 5_000 }, { ...deps(), sandbox: hanging, signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    const result = await pending;
    expect(result.error?.kind).toBe('cancelled');
  });

  it('cancels when the client aborts and refuses calls made afterwards', async () => {
    const d = deps();
    const controller = new AbortController();
    let late: unknown;
    const sandbox: Sandbox = {
      run: async (_code, opts) => {
        controller.abort();
        late = await opts.onCall('write', { path: 'a.txt', content: 'x' });
        return { ok: false, kind: 'killed', error: { name: 'Killed', message: 'stopped' } };
      },
    };
    const result = await runScript({ code: 'x', transaction: false, timeoutMs: 5_000 }, { ...d, sandbox, signal: controller.signal });
    expect(result.error?.kind).toBe('cancelled');
    expect(late).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    expect(d.tools.files.size).toBe(0);
  });

  it('refuses calls that arrive after the script returned', async () => {
    const d = deps();
    let call: ((tool: string, args: unknown) => Promise<unknown>) | undefined;
    const sandbox: Sandbox = {
      run: async (_code, opts) => {
        call = opts.onCall;
        return { ok: true, value: 1 };
      },
    };
    const result = await runScript({ code: 'x', transaction: false, timeoutMs: 5_000 }, { ...d, sandbox });
    expect(result).toMatchObject({ ok: true, result: 1 });
    expect(await call?.('write', { path: 'a.txt', content: 'x' })).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    expect(d.tools.files.size).toBe(0);
  });

  it('denies every call when the policy fails to load', async () => {
    const d = deps({ policyError: 'bad settings' }, { 'a.txt': 'x' });
    const result = await runScript({ code: script([{ tool: 'read', args: { path: 'a.txt' } }]), transaction: false, timeoutMs: 5_000 }, d);
    expect(result.calls[0]).toMatchObject({ decision: 'denied' });
    expect(result.calls[0]?.reason).toContain('unsupported-config');
  });

  it('never rejects when the sandbox throws', async () => {
    const sandbox: Sandbox = {
      run: () => {
        throw new Error('spawn failed');
      },
    };
    const result = await runScript({ code: 'x', transaction: false, timeoutMs: 5_000 }, { ...deps(), sandbox });
    expect(result.error).toMatchObject({ kind: 'error', message: 'spawn failed' });
  });
});
