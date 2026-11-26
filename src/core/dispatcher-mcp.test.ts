import { describe, expect, it } from 'vitest';
import { makeContext } from '../testing/context.js';
import { MemoryToolRuntime } from '../testing/memory-tool-runtime.js';
import { StaticHostAdapter, type StaticHostAdapterOptions } from '../testing/static-host-adapter.js';
import { Dispatcher } from './dispatcher.js';
import { ToolError } from './errors.js';
import type { CallReply, McpEffect, McpPolicy, McpResult, McpRuntime, McpServerSpec } from './types.js';

const spec: McpServerSpec = { name: 'srv', command: 'node', args: [], env: { TOKEN: 'secret' }, cwd: '/ws', startupTimeoutMs: 1_000, toolTimeoutMs: 5_000, origin: 'test', autostart: true, secrets: ['secret'] };
const MCP: McpPolicy = { servers: [spec], notes: ['server "other" (test): only stdio servers are reachable from scripts'] };

class FakeRuntime implements McpRuntime {
  readonly sent: McpEffect[] = [];
  constructor(readonly reply: (effect: McpEffect) => Promise<McpResult> = async (e) => ({ isError: false, structuredContent: { got: e.input } })) {}
  async call(_spec: McpServerSpec, effect: McpEffect, _signal: AbortSignal, onSent?: () => void): Promise<McpResult> {
    onSent?.();
    this.sent.push(effect);
    return this.reply(effect);
  }
  async close(): Promise<void> {}
}

async function setup(opts: StaticHostAdapterOptions = {}, runtime = new FakeRuntime()) {
  const ctx = makeContext('/ws');
  const adapter = new StaticHostAdapter({ mcp: MCP, ...opts });
  const tools = new MemoryToolRuntime({ root: '/ws' });
  const policy = await adapter.loadPolicy(ctx);
  const dispatcher = new Dispatcher<null>({ adapter, tools, ctx, policy, mcp: runtime });
  return { adapter, dispatcher, runtime };
}

const errorOf = (reply: CallReply) => {
  if (reply.ok) throw new Error(`expected a failure, got ${JSON.stringify(reply.value)}`);
  return reply.error;
};
const denyMcp = (): NonNullable<StaticHostAdapterOptions['rules']> => [(p) => (p.tool === 'mcp' ? { kind: 'deny', reason: 'no mcp' } : undefined)];

describe('Dispatcher mcpCall', () => {
  it('authorizes the host name of the tool, then sends exactly the prepared call', async () => {
    const { adapter, dispatcher, runtime } = await setup();
    const reply = await dispatcher.dispatch('mcp', { server: 'srv', tool: 'list', args: { page: 2 }, options: { timeoutMs: 9_000 } });
    expect(reply).toEqual({ ok: true, value: { isError: false, structuredContent: { got: { page: 2 } } } });
    expect(adapter.staticChecked[0]).toMatchObject({ tool: 'mcp', effect: { qualifiedName: 'mcp__srv__list', input: { page: 2 }, timeoutMs: 5_000 } });
    expect(Object.isFrozen(adapter.staticChecked[0])).toBe(true);
    expect(runtime.sent).toEqual([{ server: 'srv', tool: 'list', qualifiedName: 'mcp__srv__list', input: { page: 2 }, timeoutMs: 5_000 }]);
    expect(dispatcher.calls[0]).toMatchObject({ tool: 'mcp__srv__list', decision: 'allowed', summary: 'mcp srv.list {"page":2}' });
    expect(dispatcher.mcpCallsSent).toBe(1);
  });

  it.each<[string, StaticHostAdapterOptions, string]>([
    ['a deny rule', { rules: denyMcp() }, 'rule'],
    ['an ask rule', { rules: [() => ({ kind: 'ask', reason: 'ask' })] }, 'ask-unavailable'],
    ['a hook deny', { hook: { kind: 'deny', reason: 'hook says no' } }, 'hook'],
    ['a hook ask', { hook: { kind: 'ask', reason: 'hook asks' } }, 'ask-unavailable'],
    ['a failing hook', { hook: { kind: 'throw', message: 'boom' } }, 'hook-error'],
    ['managed restrictions', { mcp: { ...MCP, unsupported: 'restricted' } }, 'unsupported-config'],
  ])('never sends a call refused by %s', async (_name, opts, source) => {
    const { dispatcher, runtime } = await setup(opts);
    const err = errorOf(await dispatcher.dispatch('mcp', { server: 'srv', tool: 'list' }));
    expect(err).toMatchObject({ name: 'PermissionDenied', source });
    expect(runtime.sent).toEqual([]);
  });

  it('refuses a server the host does not configure, naming the configured ones and why others were left out', async () => {
    const { adapter, dispatcher, runtime } = await setup();
    const err = errorOf(await dispatcher.dispatch('mcp', { server: 'other', tool: 'x' }));
    expect(err.message).toMatch(/no MCP server "other" .*servers: "srv"; left out: server "other"/);
    expect(adapter.staticChecked).toEqual([]);
    expect(runtime.sent).toEqual([]);
  });

  it.each([
    [{ server: 'srv' }],
    [{ server: 'a__b', tool: 't' }],
    [{ server: 'srv', tool: 't', args: [1] }],
    [{ server: 'srv', tool: 't', options: { timeoutMs: 0 } }],
    [{ server: 'srv', tool: 't', extra: 1 }],
  ])('rejects malformed arguments %j before any check', async (args) => {
    const { adapter, dispatcher } = await setup();
    expect(errorOf(await dispatcher.dispatch('mcp', args))).toMatchObject({ name: 'ToolError', code: 'invalid-args' });
    expect(adapter.staticChecked).toEqual([]);
  });

  it('applies a hook rewrite of the input and checks it again, but never a rewrite to another tool', async () => {
    const rewrite = (args: unknown): StaticHostAdapterOptions => ({ hook: { kind: 'updatedArgs', args } });
    const ok = await setup(rewrite({ server: 'srv', tool: 'list', args: { page: 3 } }));
    expect(await ok.dispatcher.dispatch('mcp', { server: 'srv', tool: 'list', args: { page: 1 } })).toMatchObject({ ok: true });
    expect(ok.runtime.sent.map((e) => e.input)).toEqual([{ page: 3 }]);
    expect(ok.dispatcher.calls[0]?.summary).toBe('mcp srv.list {"page":3}');
    expect(ok.adapter.staticChecked).toHaveLength(2);

    const other = await setup(rewrite({ server: 'srv', tool: 'delete', args: {} }));
    expect(errorOf(await other.dispatcher.dispatch('mcp', { server: 'srv', tool: 'list' }))).toMatchObject({ source: 'hook', message: expect.stringMatching(/another MCP server or tool/) });
    expect(other.runtime.sent).toEqual([]);

    const rechecked = await setup({ ...rewrite({ server: 'srv', tool: 'list', args: { page: 'all' } }), rules: [(p) => (p.tool === 'mcp' && p.effect.input['page'] === 'all' ? { kind: 'deny', reason: 'no' } : undefined)] });
    expect(errorOf(await rechecked.dispatcher.dispatch('mcp', { server: 'srv', tool: 'list' }))).toMatchObject({ source: 'rule' });
    expect(rechecked.runtime.sent).toEqual([]);
  });

  it('never shows a config secret in the call log, also after a hook rewrite adds one', async () => {
    const plain = await setup();
    await plain.dispatcher.dispatch('mcp', { server: 'srv', tool: 'list', args: { auth: 'secret' } });
    expect(plain.dispatcher.calls[0]?.summary).toBe('mcp srv.list {"auth":"<redacted>"}');
    const hooked = await setup({ hook: { kind: 'updatedArgs', args: { server: 'srv', tool: 'list', args: { auth: 'secret', page: 2 } } } });
    await hooked.dispatcher.dispatch('mcp', { server: 'srv', tool: 'list' });
    expect(hooked.dispatcher.calls[0]?.summary).toBe('mcp srv.list {"auth":"<redacted>","page":2}');
  });

  it.each([['a quote', 'ab"cd123'], ['a backslash', 'ab\\cd123'], ['a newline', 'ab\ncd123']])('redacts a secret with %s, which JSON escapes', async (_name, secret) => {
    const ctx = makeContext('/ws');
    const adapter = new StaticHostAdapter({ mcp: { servers: [{ ...spec, secrets: [secret] }], notes: [] }, hook: { kind: 'updatedArgs', args: { server: 'srv', tool: 'list', args: { auth: `x${secret}`, page: 2 } } } });
    const runtime = new FakeRuntime();
    const dispatcher = new Dispatcher<null>({ adapter, tools: new MemoryToolRuntime({ root: '/ws' }), ctx, policy: await adapter.loadPolicy(ctx), mcp: runtime });
    await dispatcher.dispatch('mcp', { server: 'srv', tool: 'list', args: { auth: secret } });
    const shown = JSON.stringify(dispatcher.calls);
    expect(shown).not.toContain(JSON.stringify(secret).slice(1, -1));
    expect(dispatcher.calls[0]?.summary).toBe('mcp srv.list {"auth":"x<redacted>","page":2}');
    expect(runtime.sent[0]?.input).toEqual({ auth: `x${secret}`, page: 2 });
  });

  it('runs mcpCalls one at a time with the mutations, in call order', async () => {
    const order: string[] = [];
    const runtime = new FakeRuntime(async (e) => {
      order.push(`start ${String(e.input['n'])}`);
      await new Promise((r) => setTimeout(r, e.input['n'] === 1 ? 50 : 0));
      order.push(`end ${String(e.input['n'])}`);
      return { isError: false };
    });
    const { dispatcher } = await setup({}, runtime);
    await Promise.all([dispatcher.dispatch('mcp', { server: 'srv', tool: 't', args: { n: 1 } }), dispatcher.dispatch('mcp', { server: 'srv', tool: 't', args: { n: 2 } })]);
    expect(order).toEqual(['start 1', 'end 1', 'start 2', 'end 2']);
  });

  it('reports a failed call as a ToolError and runs PostToolUse with the result', async () => {
    const failing = await setup({}, new FakeRuntime(async () => Promise.reject(new ToolError('tool-error', 'did not answer'))));
    expect(errorOf(await failing.dispatcher.dispatch('mcp', { server: 'srv', tool: 't' }))).toMatchObject({ name: 'ToolError', message: 'did not answer' });
    const ok = await setup();
    await ok.dispatcher.dispatch('mcp', { server: 'srv', tool: 't' });
    expect(ok.adapter.postToolUses[0]?.result).toEqual({ isError: false, structuredContent: { got: {} } });
  });

  it('fails every mcpCall when the server has no MCP runtime', async () => {
    const ctx = makeContext('/ws');
    const adapter = new StaticHostAdapter({ mcp: MCP });
    const dispatcher = new Dispatcher<null>({ adapter, tools: new MemoryToolRuntime({ root: '/ws' }), ctx, policy: await adapter.loadPolicy(ctx) });
    expect(errorOf(await dispatcher.dispatch('mcp', { server: 'srv', tool: 't' }))).toMatchObject({ name: 'ToolError' });
  });
});
