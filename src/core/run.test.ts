import { describe, expect, it, vi } from 'vitest';
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

  it('rolls back within the grace after cancel even if a PostToolUse hook never returns', async () => {
    const d = deps();
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    d.adapter.postToolUse = () => {
      entered();
      return new Promise<void>(() => undefined);
    };
    const controller = new AbortController();
    let settled = false;
    const pending = runScript(
      { code: script([{ tool: 'write', args: { path: 'a.txt', content: 'SAFE' } }]), transaction: true, timeoutMs: 5_000 },
      { ...d, signal: controller.signal, stopGraceMs: 20 },
    ).then((r) => ((settled = true), r));
    await inside;
    controller.abort();
    await new Promise((r) => setTimeout(r, 300));
    expect(settled).toBe(true);
    const result = await pending;
    expect(result.error?.kind).toBe('cancelled');
    expect(result.rolledBack?.restored).toEqual(['/ws/a.txt']);
    expect(d.tools.read('a.txt')).toBeUndefined();
  });

  it('settles on cancel and on timeout while loadPolicy never returns', async () => {
    const d = deps();
    d.adapter.loadPolicy = () => new Promise(() => undefined);
    const controller = new AbortController();
    let settled = false;
    const cancelled = runScript({ code: script([]), transaction: true, timeoutMs: 5_000 }, { ...d, signal: controller.signal, stopGraceMs: 5 }).then(
      (r) => ((settled = true), r),
    );
    controller.abort();
    await new Promise((r) => setTimeout(r, 150));
    expect(settled).toBe(true);
    expect((await cancelled).error?.kind).toBe('cancelled');

    const timedOut = await runScript({ code: script([]), transaction: false, timeoutMs: 20 }, { ...d, stopGraceMs: 5 });
    expect(timedOut.error?.kind).toBe('timeout');
  });

  it('reports a rollback that does not finish within its bound', async () => {
    const d = deps(denyForbidden);
    const tx = d.tools.beginTransaction();
    d.tools.beginTransaction = () => ({ rollback: () => new Promise(() => undefined), dispose: () => tx.dispose() });
    const result = await runScript(
      { code: script([{ tool: 'write', args: { path: 'forbidden.txt', content: 'x' } }]), transaction: true, timeoutMs: 5_000 },
      { ...d, rollbackTimeoutMs: 30 },
    );
    expect(result.error?.kind).toBe('denied');
    expect(result.rolledBack).toBeUndefined();
    expect(result.warnings.join('\n')).toContain('rollback did not finish within 30 ms');
  });

  it('rolls back a commit still running after the grace once it has landed', async () => {
    const tools = new MemoryToolRuntime({ root: '/ws', commitDelayMs: 60, honorAbortInCommit: false });
    const sandbox: Sandbox = {
      run: async (_code, opts) => {
        void opts.onCall('write', { path: 'late.txt', content: 'late' });
        await new Promise((r) => setTimeout(r, 5));
        return { ok: false, kind: 'error', error: { name: 'Error', message: 'boom' } };
      },
    };
    const result = await runScript({ code: 'x', transaction: true, timeoutMs: 5_000 }, { ...deps(), tools, sandbox, stopGraceMs: 10 });
    expect(result.error?.kind).toBe('error');
    expect(result.rolledBack).toBeUndefined();
    expect(result.warnings.join('\n')).toContain('the rollback is pending');
    await vi.waitFor(() => expect(tools.commits).toHaveLength(1));
    await vi.waitFor(() => expect(tools.read('late.txt')).toBeUndefined());
  });

  it.each(['read', 'bash'] as const)('rolls back a finished write without waiting for %s that ignores abort', async (stalled) => {
    const d = deps({}, { 'a.txt': 'a' });
    const commit = d.tools.commit.bind(d.tools);
    let started = (): void => undefined;
    const reached = new Promise<void>((resolve) => { started = resolve; });
    d.tools.commit = (p, signal, tx) => {
      if (p.tool !== stalled) return commit(p, signal, tx);
      started();
      return new Promise(() => undefined);
    };
    const sandbox: Sandbox = {
      run: async (_code, opts) => {
        await opts.onCall('write', { path: 'b.txt', content: 'b' });
        void opts.onCall(stalled, stalled === 'read' ? { path: 'a.txt' } : { command: 'echo hello' });
        await reached;
        void opts.onCall('write', { path: 'c.txt', content: 'c' });
        return { ok: false, kind: 'error', error: { name: 'Error', message: 'boom' } };
      },
    };
    const result = await runScript({ code: 'x', transaction: true, timeoutMs: 5_000 }, { ...d, sandbox, stopGraceMs: 10 });
    expect(result.rolledBack).toBeDefined();
    expect(result.warnings.join('\n')).not.toContain('the rollback is pending');
    expect(d.tools.read('b.txt')).toBeUndefined();
    expect(d.tools.read('c.txt')).toBeUndefined();
  });

  it('releases the journal only after a rollback that outlived its bound has ended', async () => {
    const d = deps(denyForbidden);
    const events: string[] = [];
    let finishRollback = (): void => undefined;
    const gate = new Promise<void>((r) => (finishRollback = r));
    d.tools.beginTransaction = () => ({
      rollback: async () => {
        await gate;
        events.push('rollback');
        return { restored: [], skipped: [] };
      },
      dispose: async () => {
        events.push('dispose');
      },
    });
    const result = await runScript(
      { code: script([{ tool: 'write', args: { path: 'forbidden.txt', content: 'x' } }]), transaction: true, timeoutMs: 5_000 },
      { ...d, rollbackTimeoutMs: 10 },
    );
    expect(result.warnings.join('\n')).toContain('rollback did not finish within 10 ms');
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual([]);
    finishRollback();
    await vi.waitFor(() => expect(events).toEqual(['rollback', 'dispose']));
  });

  it('counts policy loading against the deadline and gives the sandbox only the time left', async () => {
    let clock = 0;
    const budgets: number[] = [];
    const sandbox: Sandbox = {
      run: async (_code, opts) => {
        budgets.push(opts.timeoutMs);
        return { ok: true, value: 1 };
      },
    };
    const d = deps({}, {}, sandbox);
    const load = d.adapter.loadPolicy.bind(d.adapter);
    let loadMs = 300.5;
    d.adapter.loadPolicy = (ctx) => {
      clock += loadMs;
      return load(ctx);
    };
    expect(await runScript({ code: 'x', transaction: false, timeoutMs: 1_000 }, { ...d, now: () => clock })).toMatchObject({ ok: true });
    expect(budgets).toEqual([700]);

    clock = 0;
    loadMs = 1_000;
    const late = await runScript({ code: 'x', transaction: false, timeoutMs: 1_000 }, { ...d, now: () => clock });
    expect(late.error?.kind).toBe('timeout');
    expect(budgets).toEqual([700]);
  });

  it('refuses a commit when authorization completes after the deadline', async () => {
    let clock = 0;
    const sandbox: Sandbox = {
      run: async (_code, opts) => {
        await opts.onCall('write', { path: 'notes.txt', content: 'notes' });
        return { ok: true, value: null };
      },
    };
    const d = deps({}, {}, sandbox);
    d.adapter.authorize = async () => {
      clock = 1_001;
      return { kind: 'allow' };
    };
    const result = await runScript({ code: 'x', transaction: false, timeoutMs: 1_000 }, { ...d, now: () => clock });
    expect(result.error?.kind).toBe('timeout');
    expect(d.tools.read('notes.txt')).toBeUndefined();
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
