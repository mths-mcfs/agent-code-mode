import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parse as parseToml } from 'smol-toml';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { z } from 'zod';
import { DEFAULT_FIXTURE_SEED, generateFixture } from '../fixture/generate.ts';
import { claudeMcpConfig } from '../lib/claude.ts';
import { codexConfigToml, parseCodexTranscript } from '../lib/codex.ts';
import { checkArm, checkMcpCalls, checkSurface, mcpCallCounts, taskToolName } from '../lib/record.ts';
import { offLimitsHits, taskServer, toolInputsText } from '../lib/task-mcp.ts';
import { claudeProjectSettings, createWorkspace } from '../lib/workspace.ts';
import { codeModeReasons } from '../run.ts';
import { TASKS } from '../tasks/index.ts';
import { dollars, t16Data, T16_QUARTER, topRefunded } from '../tasks/T16/data.ts';
import { answerPairs } from '../tasks/T16/verify.ts';
import { DEFAULT_TASK_IDS, TASK_IDS } from '../tasks/types.ts';

const task = TASKS.T16;
const facts = generateFixture(DEFAULT_FIXTURE_SEED).facts;
const server = task.mcpServer;
if (server === undefined) throw new Error('T16 has no MCP server');
const stdio = taskServer(task, facts);
if (stdio === undefined) throw new Error('T16 has no MCP server');

const Text = z.object({ content: z.array(z.object({ type: z.literal('text'), text: z.string() })).min(1), isError: z.boolean().optional() }).passthrough();
const CustomerPage = z.object({ nextPage: z.number().nullable(), customers: z.array(z.object({ id: z.string() }).passthrough()) }).passthrough();
const OrderPage = z.object({ nextPage: z.number().nullable(), orders: z.array(z.object({ id: z.string(), status: z.string(), orderDate: z.string() }).passthrough()) }).passthrough();
const FullOrder = z.object({ customerId: z.string(), refunds: z.array(z.object({ date: z.string(), amountCents: z.number(), status: z.string() })) }).passthrough();

let client: Client;
let calls = 0;
const sizes: Record<string, number[]> = {};

async function call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  calls += 1;
  const r = Text.parse(await client.callTool({ name, arguments: args }));
  const text = r.content.map((c) => c.text).join('');
  (sizes[name] ??= []).push(Buffer.byteLength(text));
  return { text, isError: r.isError === true };
}

beforeAll(async () => {
  client = new Client({ name: 'bench-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: stdio.command, args: [...stdio.args], stderr: 'pipe' }));
}, 30_000);

afterAll(async () => {
  await client.close();
});

describe('T16 orders server', () => {
  it('lists the three tools the task names', async () => {
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name).sort()).toEqual([...server.tools].sort());
  });

  it('answers the question through its tools in about 30 calls, with pages of 5 to 20 KB', async () => {
    calls = 0;
    const customers: string[] = [];
    for (let page: number | null = 1; page !== null; ) {
      const p = CustomerPage.parse(JSON.parse((await call('list_customers', { page })).text));
      customers.push(...p.customers.map((c) => c.id));
      page = p.nextPage;
    }
    const totals = new Map<string, number>();
    for (const id of customers) {
      for (let page: number | null = 1; page !== null; ) {
        const p = OrderPage.parse(JSON.parse((await call('list_orders', { customer_id: id, page })).text));
        for (const o of p.orders) {
          if (!o.status.includes('refund') || o.orderDate > T16_QUARTER.to) continue;
          const full = FullOrder.parse(JSON.parse((await call('get_order', { order_id: o.id })).text));
          for (const r of full.refunds) if (r.status === 'succeeded' && r.date >= T16_QUARTER.from && r.date <= T16_QUARTER.to) totals.set(full.customerId, (totals.get(full.customerId) ?? 0) + r.amountCents);
        }
        page = p.nextPage;
      }
    }
    const viaTools = [...totals].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([customerId, cents]) => ({ customerId, cents }));
    expect(viaTools).toEqual(topRefunded(t16Data(DEFAULT_FIXTURE_SEED), 3));
    expect(calls).toBeGreaterThanOrEqual(25);
    expect(calls).toBeLessThanOrEqual(40);
    const pages = [...(sizes['list_customers'] ?? []), ...(sizes['list_orders'] ?? [])];
    expect(Math.max(...pages)).toBeLessThanOrEqual(20_000);
    expect((sizes['list_customers'] ?? []).every((b) => b >= 5_000)).toBe(true);
    expect((sizes['list_orders'] ?? []).filter((b) => b >= 5_000).length).toBeGreaterThan(pages.length / 3);
  }, 60_000);

  it('keeps refunds out of list_orders', async () => {
    const id = t16Data(DEFAULT_FIXTURE_SEED).orders.find((o) => o.refunds.length > 0)?.customerId ?? '';
    const { text } = await call('list_orders', { customer_id: id });
    expect(text).not.toContain('amountCents');
    expect(text).not.toContain('RF-');
  });

  it.each([
    ['list_orders', { customer_id: 'C-9999' }, 'no customer'],
    ['get_order', { order_id: 'O-1' }, 'no order'],
    ['list_customers', { page: 0 }, 'invalid arguments'],
    ['list_customers', { extra: true }, 'invalid arguments'],
  ])('%s %j is an error result', async (name, args, message) => {
    const r = await call(name, args);
    expect(r.isError).toBe(true);
    expect(r.text).toContain(message);
  });

  it('exits when its stdin closes', async () => {
    const child = spawn(stdio.command, [...stdio.args], { stdio: ['pipe', 'ignore', 'ignore'] });
    onTestFinished(() => {
      child.kill('SIGKILL');
    });
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    await new Promise((resolve) => setTimeout(resolve, 500));
    child.stdin.end();
    const code = await Promise.race([exited, new Promise<'alive'>((resolve) => setTimeout(() => resolve('alive'), 5_000))]);
    expect(code).toBe(0);
  });

  it('refuses to start without a seed', () => {
    expect(() => execFileSync(stdio.command, [server.entry], { stdio: 'pipe' })).toThrow();
  });
});

describe('T16 data', () => {
  it('is deterministic, depends on the seed, and its top four totals are distinct', () => {
    const a = t16Data(DEFAULT_FIXTURE_SEED);
    expect(JSON.stringify(t16Data(DEFAULT_FIXTURE_SEED))).toBe(JSON.stringify(a));
    expect(new Set(topRefunded(a, 4).map((t) => t.cents)).size).toBe(4);
    expect(JSON.stringify(t16Data(DEFAULT_FIXTURE_SEED + 1))).not.toBe(JSON.stringify(a));
  });

  it('is not in the workspace: the task adds no file', () => {
    const files = new Map<string, string>([['a.txt', 'x']]);
    expect(task.setup(files, facts)).toBe(files);
  });

  it('runs only when asked for', () => {
    expect(TASK_IDS).toContain('T16');
    expect(DEFAULT_TASK_IDS).not.toContain('T16');
  });
});

describe('T16 answer', () => {
  it.each([
    ['C-0343 1673.00, C-0103 876.90, C-0063 279.00', [167300, 87690, 27900]],
    ['C-0343: $1,673.00, C-0103: $876.90, C-0063: $279.00', [167300, 87690, 27900]],
    ['`C-0343` (1673.00) | C-0103 = 876.90 | C-0063 279.00', [167300, 87690, 27900]],
    ['C-0343 -1673.00, C-0103 876.9, C-0063 279', [null, null, null]],
    ['C-0343 1673.001, C-0103 +876.90, C-0063 279.00.', [null, null, 27900]],
  ])('%j', (line, cents) => {
    expect(answerPairs(line).map((p) => p.cents)).toEqual(cents);
    expect(answerPairs(line).map((p) => p.customerId)).toEqual(['C-0343', 'C-0103', 'C-0063']);
  });

  const top = topRefunded(t16Data(DEFAULT_FIXTURE_SEED), 3);
  const right = `ANSWER: ${top.map((t) => `${t.customerId} ${dollars(t.cents)}`).join(', ')}`;
  const ctx = { workspace: '/nonexistent-acm-t16', facts, initial: new Map<string, string>() };
  const answerFails = (details: readonly string[]): string[] => details.filter((d) => d.startsWith('FAIL') && !d.includes('workspace'));

  it('the reference answer passes', async () => {
    expect(answerFails((await task.verify({ ...ctx, answer: right })).details)).toEqual([]);
  });

  it.each([
    ['one cent off', right.replace(/(\d)(,|$)/, (_m, d: string, end: string) => `${(Number(d) + 1) % 10}${end}`)],
    ['a negative total', right.replace(/C-(\d{4}) (\d)/, 'C-$1 -$2')],
    ['a third decimal', right.replace(/(\.\d{2}),/, '$11,')],
    ['a fourth customer', `${right}, C-9999 1.00`],
    ['two customers swapped', `ANSWER: ${[top[1], top[0], top[2]].map((t) => `${t?.customerId} ${dollars(t?.cents ?? 0)}`).join(', ')}`],
  ])('the verifier refuses %s', async (_label, answer) => {
    expect(answer).not.toBe(right);
    expect(answerFails((await task.verify({ ...ctx, answer })).details).length).toBeGreaterThan(0);
  });
});

describe('T16 in the host configs', () => {
  const Servers = z.object({ mcpServers: z.record(z.string(), z.object({ command: z.string(), args: z.array(z.string()) }).passthrough()) });
  const servers = (arm: 'A' | 'B' | 'C' | 'D') => Servers.parse(claudeMcpConfig(arm, 'cli.js', stdio)).mcpServers;

  it('every Claude arm gets orders, next to agent-code-mode where it has it, with no serve flag', () => {
    expect(Object.keys(servers('A'))).toEqual(['orders']);
    expect(Object.keys(servers('D'))).toEqual(['orders']);
    expect(Object.keys(servers('B')).sort()).toEqual(['agent-code-mode', 'orders']);
    expect(servers('B')['agent-code-mode']?.args).toEqual(['cli.js', 'serve', '--host', 'claude']);
    expect(servers('C')['agent-code-mode']?.args).toEqual(['cli.js', 'serve', '--host', 'claude', '--hybrid']);
    expect(servers('B')['orders']).toEqual({ type: 'stdio', command: process.execPath, args: [server.entry, '--seed', String(DEFAULT_FIXTURE_SEED)] });
  });

  it('without an MCP task the Claude configs are what they were', () => {
    expect(claudeMcpConfig('A', 'cli.js')).toEqual({ mcpServers: {} });
    expect(Object.keys(Servers.parse(claudeMcpConfig('B', 'cli.js')).mcpServers)).toEqual(['agent-code-mode']);
  });

  it('the Claude settings allow mcp__orders for T16 only', () => {
    const fixture = generateFixture(DEFAULT_FIXTURE_SEED);
    expect(JSON.stringify(claudeProjectSettings(task, fixture))).toContain('"mcp__orders"');
    expect(JSON.stringify(claudeProjectSettings(TASKS.T4, fixture))).not.toContain('mcp__orders');
  });

  const Toml = z.object({ mcp_servers: z.record(z.string(), z.object({ command: z.string(), args: z.array(z.string()), tools: z.record(z.string(), z.object({ approval_mode: z.string() })).optional() }).passthrough()) }).passthrough();
  const codex = (arm: 'A' | 'B' | 'C', withTask: boolean) =>
    Toml.parse(parseToml(codexConfigToml({ arm, model: 'm', effort: 'medium', codexHome: '/h', catalogFile: null, serverEntry: 'cli.js', nodePath: 'node', emptyServerEntry: 'empty.mjs', ...(withTask ? { task: { server: stdio, tools: server.tools } } : {}) }))).mcp_servers;

  it.each(['A', 'B', 'C'] as const)('Codex arm %s gets orders with each of its tools approved', (arm) => {
    const orders = codex(arm, true)['orders'];
    expect(orders?.command).toBe(process.execPath);
    expect(orders?.args).toEqual([server.entry, '--seed', String(DEFAULT_FIXTURE_SEED)]);
    expect(orders?.tools).toEqual(Object.fromEntries(server.tools.map((t) => [t, { approval_mode: 'approve' }])));
    expect(Object.keys(codex(arm, false))).not.toContain('orders');
  });

  it('the workspace commit names no seed', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'acm-t16-ws-'));
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
    const ws = path.join(dir, 'ws');
    await createWorkspace(ws, task, 'claude', DEFAULT_FIXTURE_SEED);
    const log = execFileSync('git', ['log', '--format=%B'], { cwd: ws, encoding: 'utf8' });
    expect(log.trim()).toBe('fixture for T16');
  });
});

describe('T16 validity', () => {
  it.each([
    ['mcp__orders__list_orders', 'list_orders'],
    ['mcp__orders__.list_orders', 'list_orders'],
    ['mcp__orders.get_order', 'get_order'],
    ['exec.mcp__orders__get_order', 'get_order'],
    ['mcp__agent-code-mode__run', null],
    ['mcp__orders2__get_order', null],
    ['Read', null],
  ])('taskToolName(%s)', (name, tool) => {
    expect(taskToolName(name, 'orders')).toBe(tool);
  });

  it.each([
    ['claude', 'A', { direct: 30, script: 0 }, [], false],
    ['claude', 'A', { direct: 0, script: 0 }, ['native arm made no direct MCP tool call'], false],
    ['claude', 'B', { direct: 0, script: 30 }, [], false],
    ['claude', 'B', { direct: 0, script: 0 }, ['script arm made no MCP call from a script'], false],
    ['claude', 'B', { direct: 2, script: 28 }, ['script arm made 2 direct MCP tool call(s)'], true],
    ['claude', 'C', { direct: 3, script: 27 }, [], false],
    ['claude', 'C', { direct: 0, script: 0 }, ['hybrid arm made no MCP call, direct or from a script'], false],
    ['claude', 'D', { direct: 0, script: 30 }, [], false],
    ['codex', 'A', { direct: 30, script: 0 }, [], false],
    ['codex', 'B', { direct: 0, script: 30 }, [], false],
    ['codex', 'C', { direct: 1, script: 30 }, ['script arm made 1 direct MCP tool call(s)'], true],
  ] as const)('checkMcpCalls %s %s %j', (host, arm, counts, reasons, fallback) => {
    expect(checkMcpCalls(host, arm, counts)).toEqual({ reasons, fallback });
  });

  it('direct calls to the task tools are not calls outside the hybrid arm surface; script calls are counted from run results', () => {
    const calls = { native: 0, run: 2, codeMode: 0, other: 4, byName: { 'mcp__agent-code-mode__run': 2, mcp__orders__list_orders: 4 } };
    expect(checkArm('claude', 'C', calls).reasons).toEqual(['hybrid agent-code-mode arm made 4 call(s) to tools outside its surface']);
    expect(checkArm('claude', 'C', calls, 'orders').reasons).toEqual([]);
    expect(mcpCallCounts({ toolCalls: calls, innerCalls: { total: 9, byTool: { mcp__orders__get_order: 7, Read: 2 } } }, 'orders')).toEqual({ direct: 4, script: 7 });
  });

  it('a Codex code-mode script counts its MCP calls by tool', () => {
    const lines = [
      { type: 'item.completed', item: { id: 'a', type: 'mcp_tool_call', server: 'orders', tool: 'list_orders', result: { content: [] } } },
      { type: 'item.completed', item: { id: 'b', type: 'mcp_tool_call', server: 'orders', tool: 'get_order', result: { content: [] } } },
      { type: 'item.completed', item: { id: 'c', type: 'command_execution', command: 'ls' } },
      { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 } },
    ];
    const requests = `${JSON.stringify({ kind: 'request', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 } })}\n${JSON.stringify({ kind: 'call', type: 'custom_tool_call', name: 'exec', args: 'x' })}\n`;
    const parsed = parseCodexTranscript(lines.map((l) => JSON.stringify(l)).join('\n'), requests);
    expect(mcpCallCounts(parsed, 'orders')).toEqual({ direct: 0, script: 2 });
  });

  it('every arm must list the task tools, besides its own surface', () => {
    const t = { server: 'orders', tools: server.tools };
    const claudeTools = server.tools.map((x) => `mcp__orders__${x}`);
    expect(checkSurface('claude', 'A', ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', ...claudeTools], t)).toEqual([]);
    expect(checkSurface('claude', 'B', ['mcp__agent-code-mode__run', ...claudeTools], t)).toEqual([]);
    expect(checkSurface('claude', 'B', ['mcp__agent-code-mode__run'], t)).toEqual(["arm B does not list the task's MCP tools list_customers, list_orders, get_order"]);
    expect(checkSurface('claude', 'B', ['mcp__agent-code-mode__run', ...claudeTools]).join()).toMatch(/expected exactly/);
    const codexC = ['functions.list_mcp_resources', 'functions.list_mcp_resource_templates', 'functions.read_mcp_resource', 'functions.request_user_input', 'mcp__agent_code_mode.run', ...server.tools.map((x) => `mcp__orders.${x}`)];
    expect(checkSurface('codex', 'C', codexC, t)).toEqual([]);
  });

  it('Code Mode scripts may call the task tools and the discovery helpers, nothing else new', () => {
    const base = { efforts: ['medium'], permissionModes: ['default'], replMode: true, usageByModel: {}, sessionCost: null };
    const opts = { dryRun: true, claudeEffort: 'medium' as const, claudeModel: 'm' };
    const ok = { ...base, innerByTool: { searchTools: 1, mcp__orders__get_order: 3, Read: 1 } };
    expect(codeModeReasons(opts, null, ok, task)).toEqual([]);
    expect(codeModeReasons(opts, null, ok).join()).toMatch(/searchTools/);
    expect(codeModeReasons(opts, null, { ...base, innerByTool: { mcp__other__x: 1 } }, task).join()).toMatch(/mcp__other__x/);
  });

  const claudeUse = (input: unknown) => JSON.stringify({ type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 'u', name: 'Bash', input }] } });

  it.each([
    ['reading the bench config next to the workspace', { command: 'cat ../mcp-config.json' }],
    ['reading the server source', { file_path: '/repo/bench/x/server.ts' }],
    ['calling the generator from a run script', { code: 'const { t16Data } = await import(p); return t16Data(1115);' }],
    ['reading the process table', { command: 'ps aux | grep node' }],
    ['reading /proc', { command: 'cat /proc/123/cmdline' }],
  ])('Claude: %s makes the run invalid', (_label, input) => {
    expect(offLimitsHits(task, toolInputsText('claude', claudeUse(input), null)).length).toBeGreaterThan(0);
  });

  it('Codex: a rollout call or a command that reads the config makes the run invalid', () => {
    const requests = JSON.stringify({ kind: 'call', type: 'function_call', name: 'exec_command', args: '{"cmd":"cat ../codex-home/config.toml"}' });
    expect(offLimitsHits(task, toolInputsText('codex', '', requests))).toEqual(['codex-home', 'config.toml']);
    const stdout = JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'pgrep -a node' } });
    expect(offLimitsHits(task, toolInputsText('codex', stdout, null))).toEqual(['pgrep']);
  });

  it('ordinary calls, and text that only mentions a marker, do not', () => {
    const text = JSON.stringify({ type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'I will not read mcp-config.json or server.ts' }] } });
    expect(offLimitsHits(task, toolInputsText('claude', [claudeUse({ code: 'await mcpCall("orders", "list_orders", { customer_id: "C-0001" })' }), text].join('\n'), null))).toEqual([]);
    expect(offLimitsHits(TASKS.T4, toolInputsText('claude', claudeUse({ command: 'ps aux' }), null))).toEqual([]);
  });
});
