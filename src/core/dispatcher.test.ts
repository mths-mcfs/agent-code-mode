import { describe, expect, it } from 'vitest';
import { makeContext } from '../testing/context.js';
import { MemoryToolRuntime } from '../testing/memory-tool-runtime.js';
import { StaticHostAdapter, type StaticHostAdapterOptions } from '../testing/static-host-adapter.js';
import { Dispatcher } from './dispatcher.js';
import type { CallReply, PolicyLoadError, PolicySnapshot, Transaction } from './types.js';

async function setup(
  adapterOpts: StaticHostAdapterOptions = {},
  toolOpts: Partial<ConstructorParameters<typeof MemoryToolRuntime>[0]> = {},
  extra: { transaction?: boolean } = {},
) {
  const ctx = makeContext('/ws');
  const adapter = new StaticHostAdapter(adapterOpts);
  const tools = new MemoryToolRuntime({ root: '/ws', ...toolOpts });
  const policy: PolicySnapshot<null> | PolicyLoadError = await adapter.loadPolicy(ctx);
  const tx: Transaction | undefined = extra.transaction ? tools.beginTransaction() : undefined;
  const denies: string[] = [];
  const dispatcher = new Dispatcher<null>({
    adapter,
    tools,
    ctx,
    policy,
    ...(tx ? { transaction: tx } : {}),
    onDeny: (entry) => denies.push(entry.id),
  });
  return { ctx, adapter, tools, dispatcher, tx, denies };
}

function errorOf(reply: CallReply) {
  if (reply.ok) throw new Error(`expected failure, got ${JSON.stringify(reply.value)}`);
  return reply.error;
}

describe('Dispatcher', () => {
  it('assigns ids in call order and logs each call', async () => {
    const { dispatcher } = await setup({}, { files: { 'a.txt': 'hello' } });
    await Promise.all([
      dispatcher.dispatch('read', { path: 'a.txt' }),
      dispatcher.dispatch('glob', { pattern: '*' }),
      dispatcher.dispatch('write', { path: 'b.txt', content: 'x' }),
    ]);
    expect(dispatcher.calls.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
    expect(dispatcher.calls.map((c) => c.summary)).toEqual(['read a.txt', 'glob *', 'write b.txt']);
    expect(dispatcher.calls.every((c) => c.decision === 'allowed')).toBe(true);
  });

  it('rejects invalid args and unknown tools without preparing', async () => {
    const { dispatcher, adapter } = await setup();
    const bad = errorOf(await dispatcher.dispatch('write', { file_path: 'a', content: 'x' }));
    expect(bad).toMatchObject({ name: 'ToolError', code: 'invalid-args' });
    const unknown = errorOf(await dispatcher.dispatch('rm', {}));
    expect(unknown).toMatchObject({ name: 'ToolError', code: 'invalid-args' });
    const notObject = errorOf(await dispatcher.dispatch('read', 'a.txt'));
    expect(notObject.code).toBe('invalid-args');
    expect(adapter.staticChecked).toHaveLength(0);
    expect(dispatcher.calls.map((c) => c.decision)).toEqual(['error', 'error', 'error']);
  });

  it('keeps mutation order under concurrent Promise.all of 20 reads and 5 writes', async () => {
    const { dispatcher, tools } = await setup({}, { files: { 'r.txt': 'r' }, jitterMs: 5 });
    const calls: Promise<CallReply>[] = [];
    for (let i = 0; i < 25; i++) {
      if (i % 5 === 4) calls.push(dispatcher.dispatch('write', { path: 'out.txt', content: `w${(i + 1) / 5}` }));
      else calls.push(dispatcher.dispatch('read', { path: 'r.txt' }));
    }
    const replies = await Promise.all(calls);
    expect(replies.every((r) => r.ok)).toBe(true);
    const writes = tools.commits.filter((c) => c.tool === 'write').map((c) => c.id);
    expect(writes).toEqual(['c5', 'c10', 'c15', 'c20', 'c25']);
    expect(tools.read('out.txt')).toBe('w5');
    expect(tools.maxConcurrentReads).toBeGreaterThan(1);
  });

  it('denies by static rule without running hooks', async () => {
    const { dispatcher, adapter, tools, denies } = await setup({
      rules: [(p) => (p.tool === 'bash' && p.effect.command.startsWith('rm ') ? { kind: 'deny', reason: 'no rm' } : undefined)],
    });
    const err = errorOf(await dispatcher.dispatch('bash', { command: 'rm -rf /' }));
    expect(err).toEqual({ name: 'PermissionDenied', code: 'denied', source: 'rule', message: 'no rm' });
    expect(adapter.authorized).toHaveLength(0);
    expect(tools.commits).toHaveLength(0);
    expect(denies).toEqual(['c1']);
    expect(dispatcher.calls[0]).toMatchObject({ decision: 'denied', reason: 'rule: no rm' });
  });

  it('turns ask (static or hook) into deny ask-unavailable', async () => {
    const a = await setup({ rules: [() => ({ kind: 'ask', reason: 'confirm' })] });
    expect(errorOf(await a.dispatcher.dispatch('write', { path: 'x', content: '' }))).toMatchObject({ source: 'ask-unavailable' });
    const b = await setup({ hook: { kind: 'ask', reason: 'confirm' } });
    expect(errorOf(await b.dispatcher.dispatch('write', { path: 'x', content: '' }))).toMatchObject({ source: 'ask-unavailable' });
    expect(b.tools.commits).toHaveLength(0);
  });

  it('denies with hook source when a hook denies', async () => {
    const { dispatcher, tools } = await setup({ hook: { kind: 'deny', reason: 'blocked by hook' } });
    expect(errorOf(await dispatcher.dispatch('write', { path: 'x', content: '' }))).toMatchObject({ source: 'hook', message: 'blocked by hook' });
    expect(tools.commits).toHaveLength(0);
  });

  it('turns a throwing or malformed hook adapter into deny hook-error', async () => {
    const thrower = await setup({ hook: { kind: 'throw', message: 'boom' } });
    expect(errorOf(await thrower.dispatcher.dispatch('write', { path: 'x', content: '' }))).toMatchObject({
      source: 'hook-error',
      message: 'hook failed: boom',
    });
    const malformed = await setup({ hook: { kind: 'malformed' } });
    expect(errorOf(await malformed.dispatcher.dispatch('write', { path: 'x', content: '' }))).toMatchObject({ source: 'hook-error' });
    expect(thrower.tools.commits).toHaveLength(0);
    expect(malformed.tools.commits).toHaveLength(0);
  });

  it('denies every call with unsupported-config when the policy failed to load', async () => {
    const { dispatcher, tools } = await setup({ policyError: 'unknown hook type "agent"' }, { files: { 'a.txt': 'x' } });
    expect(errorOf(await dispatcher.dispatch('read', { path: 'a.txt' }))).toMatchObject({ source: 'unsupported-config' });
    expect(tools.commits).toHaveLength(0);
  });

  it('re-prepares updatedArgs and commits the updated effect', async () => {
    const { dispatcher, tools, adapter } = await setup({
      hook: (p) => (p.tool === 'write' && p.effect.afterContent === 'secret' ? { kind: 'updatedArgs', args: { path: 'a.txt', content: 'redacted' } } : { kind: 'allow' }),
    });
    const reply = await dispatcher.dispatch('write', { path: 'a.txt', content: 'secret' });
    expect(reply.ok).toBe(true);
    expect(tools.read('a.txt')).toBe('redacted');
    // Hooks ran once; static rules ran on both the original and the updated call.
    expect(adapter.authorized).toHaveLength(1);
    expect(adapter.staticChecked).toHaveLength(2);
  });

  it('refuses updatedArgs that point outside the workspace', async () => {
    const { dispatcher, tools } = await setup({ hook: { kind: 'updatedArgs', args: { path: '../etc/passwd', content: 'x' } } });
    const err = errorOf(await dispatcher.dispatch('write', { path: 'a.txt', content: 'x' }));
    expect(err).toMatchObject({ name: 'PermissionDenied', source: 'hook' });
    expect(err.message).toContain('outside the workspace');
    expect(tools.commits).toHaveLength(0);
    expect(tools.files.size).toBe(0);
  });

  it('refuses malformed updatedArgs and lets deny rules win over updated args', async () => {
    const malformed = await setup({ hook: { kind: 'updatedArgs', args: { path: 1 } } });
    expect(errorOf(await malformed.dispatcher.dispatch('write', { path: 'a', content: '' }))).toMatchObject({ source: 'hook' });

    const ruled = await setup({
      rules: [(p) => (p.tool === 'bash' && p.effect.command.includes('curl') ? { kind: 'deny', reason: 'no network' } : undefined)],
      hook: { kind: 'updatedArgs', args: { command: 'curl example.com' } },
    });
    expect(errorOf(await ruled.dispatcher.dispatch('bash', { command: 'echo hi' }))).toMatchObject({ source: 'rule', message: 'no network' });
    expect(ruled.tools.commits).toHaveLength(0);
  });

  it('refuses writes to protected paths even through updatedArgs', async () => {
    const { dispatcher, tools } = await setup({
      protectedPaths: ['/ws/.claude/**'],
      hook: { kind: 'updatedArgs', args: { path: '.claude/settings.json', content: '{}' } },
    });
    const direct = await setup({ protectedPaths: ['/ws/.claude/**'] });
    expect(errorOf(await direct.dispatcher.dispatch('write', { path: '.claude/hooks/x.sh', content: '' }))).toMatchObject({ code: 'protected-path' });
    expect(errorOf(await dispatcher.dispatch('write', { path: 'ok.txt', content: '' }))).toMatchObject({ name: 'PermissionDenied' });
    expect(tools.files.size).toBe(0);
  });

  it('denies bash when prepared containment differs from the policy', async () => {
    const adapterOpts: StaticHostAdapterOptions = { bashContainment: { mode: 'sandbox', readOnly: true, writableRoots: [], network: false } };
    const { ctx, adapter } = await setup(adapterOpts);
    const tools = new MemoryToolRuntime({ root: '/ws' });
    const weakened: typeof tools = Object.assign(Object.create(tools) as typeof tools, {
      prepare: async (...args: Parameters<typeof tools.prepare>) => {
        const p = await tools.prepare(...args);
        return p.tool === 'bash' ? { ...p, effect: { ...p.effect, containment: { mode: 'none' as const } } } : p;
      },
    });
    const policy = await adapter.loadPolicy(ctx);
    const dispatcher = new Dispatcher({ adapter, tools: weakened, ctx, policy });
    expect(errorOf(await dispatcher.dispatch('bash', { command: 'ls' }))).toMatchObject({ source: 'containment-unavailable' });
    expect(tools.commits).toHaveLength(0);
  });

  it('refuses calls and commits after stop', async () => {
    const { dispatcher, tools } = await setup({ hook: { kind: 'hang' } });
    const pending = dispatcher.dispatch('write', { path: 'a.txt', content: 'x' });
    await new Promise((r) => setTimeout(r, 10));
    await dispatcher.stop('cancelled');
    expect(errorOf(await pending)).toMatchObject({ code: 'cancelled' });
    expect(errorOf(await dispatcher.dispatch('read', { path: 'a.txt' }))).toMatchObject({ code: 'cancelled' });
    expect(tools.commits).toHaveLength(0);
  });

  it('refuses a queued commit once the run stops', async () => {
    const { dispatcher, tools } = await setup({}, { commitDelayMs: 50 });
    const first = dispatcher.dispatch('write', { path: 'a.txt', content: '1' });
    const second = dispatcher.dispatch('write', { path: 'b.txt', content: '2' });
    await new Promise((r) => setTimeout(r, 10));
    await dispatcher.stop('timeout');
    expect(errorOf(await first)).toMatchObject({ code: 'cancelled' });
    expect(errorOf(await second)).toMatchObject({ code: 'cancelled' });
    expect(tools.files.size).toBe(0);
  });

  it('reports a commit that was mid-flight when the run stopped', async () => {
    const { dispatcher, tools } = await setup({}, { commitDelayMs: 40, honorAbortInCommit: false });
    const pending = dispatcher.dispatch('write', { path: 'a.txt', content: 'x' });
    await new Promise((r) => setTimeout(r, 10));
    await dispatcher.stop('cancelled');
    expect((await pending).ok).toBe(true);
    expect(tools.read('a.txt')).toBe('x');
    expect(dispatcher.warnings.join('\n')).toMatch(/c1 \(write a\.txt\) was committing when the run stopped \(cancelled\)/);
    expect(dispatcher.changedFiles).toEqual(['a.txt']);
  });

  it('fails a write whose file changed between prepare and commit (stale)', async () => {
    const { dispatcher, tools } = await setup({ hook: (p) => {
      if (p.tool === 'edit') tools.externalWrite('a.txt', 'changed by someone else');
      return { kind: 'allow' };
    } }, { files: { 'a.txt': 'old text' } });
    const err = errorOf(await dispatcher.dispatch('edit', { path: 'a.txt', oldString: 'old', newString: 'new' }));
    expect(err).toMatchObject({ name: 'ToolError', code: 'stale' });
    expect(tools.read('a.txt')).toBe('changed by someone else');
  });

  it('collects changed files and the combined diff in commit order', async () => {
    const { dispatcher } = await setup({}, { files: { 'a.txt': 'one\n' } });
    await dispatcher.dispatch('edit', { path: 'a.txt', oldString: 'one', newString: 'two' });
    await dispatcher.dispatch('write', { path: 'sub/b.txt', content: 'b\n' });
    await dispatcher.dispatch('write', { path: 'a.txt', content: 'three\n' });
    expect(dispatcher.changedFiles).toEqual(['a.txt', 'sub/b.txt']);
    const diff = dispatcher.diff;
    expect(diff.indexOf('+two')).toBeLessThan(diff.indexOf('+b'));
    expect(diff.indexOf('+b')).toBeLessThan(diff.indexOf('+three'));
  });

  it('deep-freezes prepared calls before adapters see them', async () => {
    const { dispatcher, adapter } = await setup();
    await dispatcher.dispatch('write', { path: 'a.txt', content: 'x' });
    const seen = adapter.authorized[0];
    expect(seen && Object.isFrozen(seen) && Object.isFrozen(seen.effect) && Object.isFrozen(seen.args)).toBe(true);
  });

  it('a deny mid-script in a transaction lets the transaction roll back earlier writes', async () => {
    const { dispatcher, tools, tx, denies } = await setup(
      { rules: [(p) => (p.tool === 'write' && p.effect.absPath.endsWith('forbidden.txt') ? { kind: 'deny', reason: 'nope' } : undefined)] },
      { files: { 'a.txt': 'original' } },
      { transaction: true },
    );
    expect((await dispatcher.dispatch('write', { path: 'a.txt', content: 'changed' })).ok).toBe(true);
    expect((await dispatcher.dispatch('write', { path: 'new.txt', content: 'n' })).ok).toBe(true);
    expect((await dispatcher.dispatch('write', { path: 'forbidden.txt', content: 'x' })).ok).toBe(false);
    expect(denies).toEqual(['c3']);
    const report = await tx?.rollback();
    expect([...(report?.restored ?? [])].sort()).toEqual(['/ws/a.txt', '/ws/new.txt']);
    expect(tools.read('a.txt')).toBe('original');
    expect(tools.read('new.txt')).toBeUndefined();
  });

  it('a hook that tries to mutate the prepared call is denied hook-error and nothing is committed', async () => {
    const { dispatcher, tools } = await setup({
      hook: (p) => {
        if (p.tool === 'write') Object.assign(p.effect, { absPath: '/etc/passwd' });
        return { kind: 'allow' };
      },
    });
    expect(errorOf(await dispatcher.dispatch('write', { path: 'a.txt', content: 'x' }))).toMatchObject({ source: 'hook-error' });
    expect(tools.commits).toHaveLength(0);
  });

  it('refuses a prepared call that does not belong to the call', async () => {
    const { ctx, adapter } = await setup();
    const tools = new MemoryToolRuntime({ root: '/ws' });
    const wrong: typeof tools = Object.assign(Object.create(tools) as typeof tools, {
      prepare: async (...args: Parameters<typeof tools.prepare>) => ({ ...(await tools.prepare(...args)), id: 'c999' }),
    });
    const dispatcher = new Dispatcher({ adapter, tools: wrong, ctx, policy: await adapter.loadPolicy(ctx) });
    expect(errorOf(await dispatcher.dispatch('write', { path: 'a.txt', content: 'x' }))).toMatchObject({ code: 'tool-error' });
    expect(tools.commits).toHaveLength(0);
  });

  it('commits the authorized effect even when the runtime returns a shallow-frozen call it can still mutate', async () => {
    const { ctx, adapter } = await setup();
    const tools = new MemoryToolRuntime({ root: '/ws' });
    let returned: { effect: { afterContent: string } } | undefined;
    const sneaky: typeof tools = Object.assign(Object.create(tools) as typeof tools, {
      commit: tools.commit.bind(tools),
      prepare: async (...args: Parameters<typeof tools.prepare>) => {
        const p = Object.freeze(await tools.prepare(...args));
        returned = p as unknown as { effect: { afterContent: string } };
        return p;
      },
    });
    let authorized: string | undefined;
    const spy = new StaticHostAdapter({
      hook: (p) => {
        if (p.tool === 'write') {
          authorized = p.effect.afterContent;
          // Both the runtime's own object and the one the hook sees are tampered with.
          if (returned && !Object.isFrozen(returned.effect)) returned.effect.afterContent = 'EVIL';
          try {
            Object.assign(p.effect, { afterContent: 'EVIL' });
          } catch {
            // Frozen, as it must be.
          }
        }
        return { kind: 'allow' };
      },
    });
    void adapter;
    const dispatcher = new Dispatcher({ adapter: spy, tools: sneaky, ctx, policy: await spy.loadPolicy(ctx) });
    const reply = await dispatcher.dispatch('write', { path: 'a.txt', content: 'SAFE' });
    expect(reply.ok).toBe(true);
    expect(authorized).toBe('SAFE');
    expect(tools.read('a.txt')).toBe('SAFE');
    const seen = spy.authorized[0];
    expect(seen && Object.isFrozen(seen.effect)).toBe(true);
  });

  it('stop gives up on a commit that ignores the signal after the grace and reports it', async () => {
    const { ctx, adapter } = await setup();
    const tools = new MemoryToolRuntime({ root: '/ws' });
    const stuck: typeof tools = Object.assign(Object.create(tools) as typeof tools, {
      prepare: tools.prepare.bind(tools),
      commit: () => new Promise<never>(() => undefined),
    });
    const dispatcher = new Dispatcher({ adapter, tools: stuck, ctx, policy: await adapter.loadPolicy(ctx) });
    void dispatcher.dispatch('write', { path: 'a.txt', content: 'x' });
    await new Promise((r) => setTimeout(r, 10));
    const started = Date.now();
    await dispatcher.stop('cancelled', 50);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(dispatcher.warnings.join('\n')).toMatch(/c1 \(write a\.txt\) did not settle within 50 ms/);
    expect(dispatcher.calls[0]).toMatchObject({ id: 'c1', decision: 'error' });
  });

  it('stops waiting for a PostToolUse hook that never returns once the run stops', async () => {
    const { ctx, tools } = await setup();
    const adapter = new StaticHostAdapter();
    adapter.postToolUse = () => new Promise<void>(() => undefined);
    const dispatcher = new Dispatcher({ adapter, tools, ctx, policy: await adapter.loadPolicy(ctx) });
    const pending = dispatcher.dispatch('write', { path: 'a.txt', content: 'x' });
    await new Promise((r) => setTimeout(r, 10));
    await dispatcher.stop('cancelled', 60_000);
    expect((await pending).ok).toBe(true);
    expect(dispatcher.warnings.join('\n')).toContain('PostToolUse hooks for c1 (write a.txt) were abandoned');
  });

  it('runs postToolUse after commit and turns its failure into a warning', async () => {
    const { ctx, tools } = await setup();
    const adapter = new StaticHostAdapter();
    adapter.postToolUse = async () => {
      throw new Error('post failed');
    };
    const dispatcher = new Dispatcher({ adapter, tools, ctx, policy: await adapter.loadPolicy(ctx) });
    expect((await dispatcher.dispatch('write', { path: 'a.txt', content: 'x' })).ok).toBe(true);
    expect(dispatcher.warnings[0]).toContain('post failed');
  });
});
