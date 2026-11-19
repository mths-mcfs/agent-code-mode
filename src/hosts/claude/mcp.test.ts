import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../core/dispatcher.js';
import type { PolicySnapshot, SessionContext } from '../../core/types.js';
import { MemoryMcpUpstream, MemoryToolRuntime, StaticHostAdapter, makeContext, memoryMcpRuntime, preparedMcpCall } from '../../testing/index.js';
import { ClaudeHostAdapter, governsMcp, type ClaudePolicy } from './adapter.js';
import { parseRule } from './rules.js';

// How the Claude Code adapter authorizes mcpCall: rule matching on mcp__<server>__<tool>, the permission modes, hooks.

const upstream = new MemoryMcpUpstream({ inventory: ['get_item', 'adjust_stock'], other: ['get_item'] });

interface Lab {
  readonly adapter: ClaudeHostAdapter;
  readonly ctx: SessionContext;
  readonly policy: PolicySnapshot<ClaudePolicy>;
  readonly base: string;
}

async function setup(opts: {
  permissions?: Record<string, unknown>;
  hooks?: Record<string, unknown>;
  mode?: string;
  argv?: readonly string[];
  managed?: Record<string, unknown>;
}): Promise<Lab> {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'acm-mcp-auth-')));
  const home = path.join(base, 'home');
  const project = path.join(base, 'project');
  await mkdir(path.join(home, '.claude'), { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: opts.permissions ?? {}, ...(opts.hooks ? { hooks: opts.hooks } : {}) }));
  let managedDir: string | null = null;
  if (opts.managed) {
    managedDir = path.join(base, 'managed');
    await mkdir(managedDir, { recursive: true });
    await writeFile(path.join(managedDir, 'managed-settings.json'), JSON.stringify(opts.managed));
  }
  const argv = opts.argv;
  const adapter = new ClaudeHostAdapter({
    env: {},
    home,
    managedDir,
    stateDir: path.join(base, 'state'),
    readParent: async () => (argv ? { argv: ['claude', ...argv], cwd: project } : undefined),
  });
  const mode = opts.mode ?? 'default';
  const ctx = makeContext(project, { host: 'claude', permissionMode: mode, sources: { cwd: 'roots', permissionMode: 'ctx-file' }, toolUseId: 'toolu_1', sessionId: 's1' });
  const policy = await adapter.loadPolicy(ctx);
  if ('error' in policy) throw new Error(policy.error);
  return { adapter, ctx, policy, base };
}

const decide = (lab: Lab, server: string, tool: string): string => lab.adapter.checkStatic(preparedMcpCall(upstream, server, tool), lab.ctx, lab.policy).kind;

const MODES = ['default', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions'] as const;
type Mode = (typeof MODES)[number];
type Row = Record<Mode, 'allow' | 'ask' | 'deny'>;

const NO_RULE: Row = { default: 'ask', acceptEdits: 'ask', auto: 'ask', plan: 'deny', dontAsk: 'deny', bypassPermissions: 'allow' };
const ALLOWED: Row = { default: 'allow', acceptEdits: 'allow', auto: 'allow', plan: 'deny', dontAsk: 'allow', bypassPermissions: 'allow' };
const DENIED: Row = { default: 'deny', acceptEdits: 'deny', auto: 'deny', plan: 'deny', dontAsk: 'deny', bypassPermissions: 'deny' };
const ASKED: Row = { default: 'ask', acceptEdits: 'ask', auto: 'ask', plan: 'deny', dontAsk: 'deny', bypassPermissions: 'ask' };

describe('the decision for mcp__inventory__get_item, by permission mode and rules', () => {
  const table: [string, Record<string, unknown>, Row][] = [
    ['no rule', {}, NO_RULE],
    ['allow mcp__inventory (the whole server)', { allow: ['mcp__inventory'] }, ALLOWED],
    ['allow mcp__inventory__*', { allow: ['mcp__inventory__*'] }, ALLOWED],
    ['allow mcp__inventory__get*', { allow: ['mcp__inventory__get*'] }, ALLOWED],
    ['allow mcp__inventory__get_item (exact)', { allow: ['mcp__inventory__get_item'] }, ALLOWED],
    ['allow another tool of the server', { allow: ['mcp__inventory__adjust_stock'] }, NO_RULE],
    ['allow another server', { allow: ['mcp__other'] }, NO_RULE],
    ['allow a server whose name is a prefix', { allow: ['mcp__inv'] }, NO_RULE],
    ['allow mcp__* (unanchored allow glob: skipped)', { allow: ['mcp__*'] }, NO_RULE],
    ['allow * (unanchored allow glob: skipped)', { allow: ['*'] }, NO_RULE],
    ['allow Bash and Read (not MCP rules)', { allow: ['Bash', 'Read'] }, NO_RULE],
    ['deny mcp__inventory beats allow of the tool', { deny: ['mcp__inventory'], allow: ['mcp__inventory__get_item'] }, DENIED],
    ['deny mcp__inventory__* beats allow of the server', { deny: ['mcp__inventory__*'], allow: ['mcp__inventory'] }, DENIED],
    ['deny the exact tool', { deny: ['mcp__inventory__get_item'], allow: ['mcp__inventory'] }, DENIED],
    ['deny mcp__* (glob in deny applies)', { deny: ['mcp__*'], allow: ['mcp__inventory'] }, DENIED],
    ['deny * (glob in deny applies)', { deny: ['*'], allow: ['mcp__inventory'] }, DENIED],
    ['deny another tool only', { deny: ['mcp__inventory__adjust_stock'], allow: ['mcp__inventory'] }, ALLOWED],
    ['ask the exact tool beats allow of the server', { ask: ['mcp__inventory__get_item'], allow: ['mcp__inventory'] }, ASKED],
    ['ask mcp__inventory beats allow of the tool', { ask: ['mcp__inventory'], allow: ['mcp__inventory__get_item'] }, ASKED],
    ['ask mcp__* (glob in ask applies)', { ask: ['mcp__*'], allow: ['mcp__inventory'] }, ASKED],
    ['deny beats ask', { deny: ['mcp__inventory'], ask: ['mcp__inventory__get_item'] }, DENIED],
  ];
  for (const [label, permissions, row] of table) {
    it.each(MODES)(`${label}: %s`, async (mode) => {
      const lab = await setup({ permissions, mode });
      expect(decide(lab, 'inventory', 'get_item')).toBe(row[mode]);
    });
  }

  it('plan mode denies before any allow rule, whatever the rule', async () => {
    const lab = await setup({ permissions: { allow: ['mcp__inventory', 'mcp__inventory__get_item'] }, mode: 'plan' });
    expect(lab.adapter.checkStatic(preparedMcpCall(upstream, 'inventory', 'get_item'), lab.ctx, lab.policy)).toMatchObject({ kind: 'deny', source: 'rule', reason: expect.stringContaining('plan mode') });
  });

  it('the deny reason names the rule and where it came from', async () => {
    const lab = await setup({ permissions: { deny: ['mcp__inventory'] }, mode: 'bypassPermissions' });
    expect(lab.adapter.checkStatic(preparedMcpCall(upstream, 'inventory', 'get_item'), lab.ctx, lab.policy)).toMatchObject({
      kind: 'deny',
      reason: expect.stringContaining('"mcp__inventory" from user settings'),
    });
  });
});

describe('rules from the parent Claude Code process flags', () => {
  it('--disallowedTools mcp__inventory denies the server even with an allow rule in settings', async () => {
    const lab = await setup({ permissions: { allow: ['mcp__inventory'] }, argv: ['--disallowedTools', 'mcp__inventory'], mode: 'bypassPermissions' });
    expect(decide(lab, 'inventory', 'get_item')).toBe('deny');
    expect(decide(lab, 'other', 'get_item')).toBe('allow');
  });

  it('--disallowedTools with an exact tool name denies only that tool', async () => {
    const lab = await setup({ permissions: { allow: ['mcp__inventory'] }, argv: ['--disallowedTools', 'mcp__inventory__adjust_stock'] });
    expect(decide(lab, 'inventory', 'adjust_stock')).toBe('deny');
    expect(decide(lab, 'inventory', 'get_item')).toBe('allow');
  });

  it('--disallowedTools still denies under allowManagedPermissionRulesOnly with a managed allow', async () => {
    const managed = { allowManagedPermissionRulesOnly: true, permissions: { allow: ['mcp__inventory'] } };
    const lab = await setup({ managed, argv: ['--disallowedTools', 'mcp__inventory__adjust_stock'], mode: 'bypassPermissions' });
    expect(decide(lab, 'inventory', 'adjust_stock')).toBe('deny');
    expect(decide(lab, 'inventory', 'get_item')).toBe('allow');
    // Settings deny and ask rules narrow the managed policy too; their allow rules do not count.
    const narrowed = await setup({ managed, permissions: { deny: ['mcp__inventory__get_item'], ask: ['mcp__inventory__adjust_stock'], allow: ['mcp__other'] }, mode: 'default' });
    expect(decide(narrowed, 'inventory', 'get_item')).toBe('deny');
    expect(decide(narrowed, 'inventory', 'adjust_stock')).toBe('ask');
    expect(decide(narrowed, 'other', 'get_item')).toBe('ask');
  });

  it('--allowedTools approves the tool it names', async () => {
    const lab = await setup({ argv: ['--allowedTools', 'mcp__inventory__get_item'] });
    expect(decide(lab, 'inventory', 'get_item')).toBe('allow');
    expect(decide(lab, 'inventory', 'adjust_stock')).toBe('ask');
  });
});

describe('governsMcp', () => {
  const anchors = { cwd: '/w', sourceDir: '/w', home: '/h' };
  const rule = (raw: string, kind: 'allow' | 'deny' = 'deny') => {
    const r = parseRule(raw, kind, 'user', anchors);
    if (!r) throw new Error(raw);
    return r;
  };
  it.each([
    ['mcp__inventory', true],
    ['mcp__inventory__get_item', true],
    ['mcp__inventory__*', true],
    ['mcp__*', true],
    ['*', true],
    ['mcp__inventory__adjust_stock', false],
    ['mcp__inv', false],
    ['mcp__inventory_', false],
    ['mcp__other', false],
    ['Bash', false],
    // A specifier on an MCP rule matches nothing (Claude Code skips it).
    ['mcp__inventory(get_item)', false],
  ])('deny %j covers mcp__inventory__get_item: %s', (raw, expected) => {
    expect(governsMcp(rule(raw), 'inventory', 'mcp__inventory__get_item')).toBe(expected);
  });
});

describe('managed MCP restrictions this adapter does not evaluate', () => {
  it.each([{ allowedMcpServers: [{ serverName: 'inventory' }] }, { deniedMcpServers: [{ serverName: 'other' }] }])('%j denies every mcpCall unsupported-config', async (managed) => {
    const lab = await setup({ permissions: { allow: ['mcp__inventory'] }, mode: 'bypassPermissions', managed });
    expect(lab.adapter.checkStatic(preparedMcpCall(upstream, 'inventory', 'get_item'), lab.ctx, lab.policy)).toMatchObject({ kind: 'deny', source: 'unsupported-config' });
  });
});

describe('PreToolUse hooks on mcpCall', () => {
  async function hookLab(script: string, matcher: string, extra: Record<string, unknown> = {}): Promise<Lab & { log: string }> {
    const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'acm-mcp-hook-')));
    const file = path.join(base, 'hook.mjs');
    const log = path.join(base, 'input.json');
    await writeFile(file, `import { readFileSync, writeFileSync } from 'node:fs';\nconst input = JSON.parse(readFileSync(0, 'utf8'));\nwriteFileSync(${JSON.stringify(log)}, JSON.stringify(input));\n${script}\n`);
    const lab = await setup({
      permissions: { allow: ['mcp__inventory'] },
      hooks: { PreToolUse: [{ matcher, hooks: [{ type: 'command', command: `"${process.execPath}" "${file}"`, ...extra }] }] },
    });
    return { ...lab, log };
  }

  it('get tool_name mcp__<server>__<tool>, tool_input = the args and mcp_server', async () => {
    const lab = await hookLab('', 'mcp__inventory__.*');
    const decision = await lab.adapter.authorize(preparedMcpCall(upstream, 'inventory', 'get_item', { sku: 'A-1' }, 'c3'), lab.ctx, lab.policy, new AbortController().signal);
    expect(decision).toEqual({ kind: 'allow' });
    const { readFile } = await import('node:fs/promises');
    const input: unknown = JSON.parse(await readFile(lab.log, 'utf8'));
    expect(input).toMatchObject({
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__inventory__get_item',
      tool_input: { sku: 'A-1' },
      mcp_server: 'inventory',
      permission_mode: 'default',
      tool_use_id: 'toolu_1/c3',
      session_id: 's1',
    });
  });

  it('a hook that blocks (exit 2) denies the call', async () => {
    const lab = await hookLab(`process.stderr.write('no stock changes'); process.exit(2);`, 'mcp__inventory__adjust_stock');
    const signal = new AbortController().signal;
    expect(await lab.adapter.authorize(preparedMcpCall(upstream, 'inventory', 'adjust_stock'), lab.ctx, lab.policy, signal)).toMatchObject({ kind: 'deny', source: 'hook', reason: 'no stock changes' });
    // The matcher does not select the other tool.
    expect(await lab.adapter.authorize(preparedMcpCall(upstream, 'inventory', 'get_item'), lab.ctx, lab.policy, signal)).toEqual({ kind: 'allow' });
  });

  it('an `if` condition naming the server selects every tool of it', async () => {
    const lab = await hookLab(`process.exit(2);`, '*', { if: 'mcp__inventory' });
    const signal = new AbortController().signal;
    expect((await lab.adapter.authorize(preparedMcpCall(upstream, 'inventory', 'get_item'), lab.ctx, lab.policy, signal)).kind).toBe('deny');
    expect((await lab.adapter.authorize(preparedMcpCall(upstream, 'other', 'get_item'), lab.ctx, lab.policy, signal)).kind).toBe('allow');
  });

  it('updatedInput rewrites the args, keeping the server and tool', async () => {
    const lab = await hookLab(
      `process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { sku: 'B-7' } } }));`,
      'mcp__inventory__get_item',
    );
    const decision = await lab.adapter.authorize(preparedMcpCall(upstream, 'inventory', 'get_item', { sku: 'A-1' }), lab.ctx, lab.policy, new AbortController().signal);
    expect(decision).toMatchObject({ kind: 'allow', updatedArgs: { server: 'inventory', tool: 'get_item', args: { sku: 'B-7' } } });
  });

  it('a hook type that cannot run outside Claude Code denies the call', async () => {
    const lab = await setup({ permissions: { allow: ['mcp__inventory'] }, hooks: { PreToolUse: [{ matcher: 'mcp__inventory__get_item', hooks: [{ type: 'prompt', prompt: 'x' }] }] } });
    expect(await lab.adapter.authorize(preparedMcpCall(upstream, 'inventory', 'get_item'), lab.ctx, lab.policy, new AbortController().signal)).toMatchObject({ kind: 'deny', source: 'unsupported-config' });
  });
});

describe('mcpCall through the dispatcher', () => {
  it('a hook that rewrites the input is validated again and the upstream gets the new input', async () => {
    const up = new MemoryMcpUpstream({ inventory: ['get_item', 'adjust_stock'] });
    const adapter = new StaticHostAdapter({ host: 'claude', hook: { kind: 'updatedArgs', args: { server: 'inventory', tool: 'get_item', args: { sku: 'B-7' } } } });
    const ctx = makeContext('/w', { host: 'claude' });
    const tools = new MemoryToolRuntime({ root: '/w' });
    const policy = await adapter.loadPolicy(ctx);
    const d = new Dispatcher({ adapter, tools, ctx, policy, mcp: memoryMcpRuntime(up) });
    const reply = await d.dispatch('mcp', { server: 'inventory', tool: 'get_item', args: { sku: 'A-1' } });
    expect(reply.ok).toBe(true);
    expect(up.calls).toEqual([{ qualifiedName: 'mcp__inventory__get_item', input: { sku: 'B-7' } }]);
  });

  it.each([
    [{ server: 'inventory', tool: 'adjust_stock', args: {} }, 'names another tool'],
    [{ server: 'inventory', tool: 'get_item', args: [1] }, 'args must be an object'],
    [{ server: 'inventory', tool: 'missing', args: {} }, 'has no tool'],
  ])('a hook rewrite to %j is denied', async (updated, reason) => {
    const up = new MemoryMcpUpstream({ inventory: ['get_item', 'adjust_stock'] });
    const adapter = new StaticHostAdapter({ host: 'claude', hook: { kind: 'updatedArgs', args: updated } });
    const ctx = makeContext('/w', { host: 'claude' });
    const policy = await adapter.loadPolicy(ctx);
    const d = new Dispatcher({ adapter, tools: new MemoryToolRuntime({ root: '/w' }), ctx, policy, mcp: memoryMcpRuntime(up) });
    const reply = await d.dispatch('mcp', { server: 'inventory', tool: 'get_item', args: { sku: 'A-1' } });
    expect(reply).toMatchObject({ ok: false, error: { name: 'PermissionDenied', source: 'hook', message: expect.stringContaining(reason) } });
    expect(up.calls).toEqual([]);
  });

  it('an ask from the rules is a deny and nothing is sent upstream', async () => {
    const lab = await setup({ mode: 'default' });
    const up = new MemoryMcpUpstream({ inventory: ['get_item', 'adjust_stock'] });
    const d = new Dispatcher({ adapter: lab.adapter, tools: new MemoryToolRuntime({ root: lab.ctx.cwd }), ctx: lab.ctx, policy: lab.policy, mcp: memoryMcpRuntime(up) });
    const reply = await d.dispatch('mcp', { server: 'inventory', tool: 'get_item', args: {} });
    expect(reply).toMatchObject({ ok: false, error: { name: 'PermissionDenied', source: 'ask-unavailable' } });
    expect(up.calls).toEqual([]);
    expect(d.calls[0]).toMatchObject({ tool: 'mcp__inventory__get_item', decision: 'denied' });
  });

  it('mcpCalls run one at a time, in call order', async () => {
    const order: string[] = [];
    const up = new MemoryMcpUpstream({ inventory: ['slow', 'fast'] }, async (entry) => {
      order.push(`start ${entry.tool}`);
      await new Promise((r) => setTimeout(r, entry.tool === 'slow' ? 50 : 1));
      order.push(`end ${entry.tool}`);
      return { ok: true, result: { content: [] } };
    });
    const adapter = new StaticHostAdapter({ host: 'claude' });
    const ctx = makeContext('/w', { host: 'claude' });
    const d = new Dispatcher({ adapter, tools: new MemoryToolRuntime({ root: '/w' }), ctx, policy: await adapter.loadPolicy(ctx), mcp: memoryMcpRuntime(up) });
    await Promise.all([d.dispatch('mcp', { server: 'inventory', tool: 'slow' }), d.dispatch('mcp', { server: 'inventory', tool: 'fast' })]);
    expect(order).toEqual(['start slow', 'end slow', 'start fast', 'end fast']);
    expect(d.mcpCallsSent).toBe(2);
  });

  it('without an MCP runtime, mcpCall is an invalid-args error', async () => {
    const adapter = new StaticHostAdapter({ host: 'claude' });
    const ctx = makeContext('/w', { host: 'claude' });
    const d = new Dispatcher({ adapter, tools: new MemoryToolRuntime({ root: '/w' }), ctx, policy: await adapter.loadPolicy(ctx) });
    expect(await d.dispatch('mcp', { server: 'inventory', tool: 'get_item' })).toMatchObject({ ok: false, error: { code: 'invalid-args', message: expect.stringContaining('no upstream MCP servers') } });
  });
});
