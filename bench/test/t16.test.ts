import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEFAULT_FIXTURE_SEED, generateFixture } from '../fixture/generate.ts';
import { claudeMcpConfig, contextOf, parseClaudeTranscript, upstreamMcpConfig } from '../lib/claude.ts';
import { checkArm, checkMcpCalls, checkSurface, mcpCallCounts } from '../lib/record.ts';
import { claudeProjectSettings } from '../lib/workspace.ts';
import { interactiveReasons, offLimitsHits, taskDirectTools, taskScriptTools, toolInputsText } from '../run.ts';
import { createWorkspace } from '../lib/workspace.ts';
import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TASKS } from '../tasks/index.ts';
import { dollars, t16Data, T16_QUARTER, topRefunded } from '../tasks/T16/data.ts';
import { answerPairs } from '../tasks/T16/verify.ts';
import { DEFAULT_TASK_IDS, TASK_IDS } from '../tasks/types.ts';

const task = TASKS.T16;
const facts = generateFixture(DEFAULT_FIXTURE_SEED).facts;
const server = task.mcpServer;
if (server === undefined) throw new Error('T16 has no MCP server');

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
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [server.entry, ...server.args(facts)], stderr: 'pipe' }));
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
    // Full pages: the last page of a customer may hold a single order.
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
});

describe('T16 data', () => {
  it('is deterministic and the decoys change the answer', () => {
    const a = t16Data(DEFAULT_FIXTURE_SEED);
    expect(JSON.stringify(t16Data(DEFAULT_FIXTURE_SEED))).toBe(JSON.stringify(a));
    const top4 = topRefunded(a, 4);
    expect(new Set(top4.map((t) => t.cents)).size).toBe(4);
    expect(JSON.stringify(t16Data(DEFAULT_FIXTURE_SEED + 1))).not.toBe(JSON.stringify(a));
  });

  it('is not in the workspace: the task adds no file', () => {
    const files = new Map<string, string>([['a.txt', 'x']]);
    expect(task.setup(files, facts)).toBe(files);
  });

  it('is not in the default task set', () => {
    expect(TASK_IDS).toContain('T16');
    expect(DEFAULT_TASK_IDS).not.toContain('T16');
  });
});

describe('T16 answer parsing', () => {
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

  it.each([
    ['a negative total', (t: string) => t.replace(/C-(\d{4}) (\d)/, 'C-$1 -$2')],
    ['a third decimal', (t: string) => t.replace(/(\.\d{2}),/, '$11,')],
    ['a fourth customer', (t: string) => `${t}, C-9999 1.00`],
  ])('the verifier refuses %s', async (_label, change) => {
    const top = topRefunded(t16Data(DEFAULT_FIXTURE_SEED), 3);
    const right = `ANSWER: ${top.map((t) => `${t.customerId} ${dollars(t.cents)}`).join(', ')}`;
    const ctx = { workspace: '/nonexistent-acm-t16', facts, initial: new Map<string, string>() };
    const answer = change(right);
    expect(answer).not.toBe(right);
    const r = await task.verify({ ...ctx, answer });
    expect(r.details.some((d) => d.startsWith('FAIL') && !d.includes('workspace'))).toBe(true);
  });

  it('the verifier wants the exact totals', async () => {
    const top = topRefunded(t16Data(DEFAULT_FIXTURE_SEED), 3);
    const right = `ANSWER: ${top.map((t) => `${t.customerId} ${dollars(t.cents)}`).join(', ')}`;
    const wrong = `ANSWER: ${top.map((t, i) => `${t.customerId} ${dollars(t.cents + (i === 2 ? 1 : 0))}`).join(', ')}`;
    const ctx = { workspace: '/nonexistent-acm-t16', facts, initial: new Map<string, string>() };
    const ok = await task.verify({ ...ctx, answer: right });
    const bad = await task.verify({ ...ctx, answer: wrong });
    expect(ok.details.filter((d) => d.startsWith('FAIL') && !d.includes('workspace'))).toEqual([]);
    expect(bad.details.some((d) => d.startsWith('FAIL totals'))).toBe(true);
  });
});

describe('T16 arms', () => {
  const mcp = { server: { name: 'orders', command: 'node', args: ['server.ts', '--seed', '1'] }, upstreamConfigFile: '/run/upstream-mcp.json' };
  const servers = (arm: 'A' | 'B' | 'C' | 'D'): Record<string, { args: string[] }> => z.object({ mcpServers: z.record(z.string(), z.object({ args: z.array(z.string()) }).passthrough()) }).parse(claudeMcpConfig(arm, 'cli.js', mcp)).mcpServers;

  it('A and D get the orders server directly, B only through agent-code-mode, C both', () => {
    expect(Object.keys(servers('A'))).toEqual(['orders']);
    expect(Object.keys(servers('D'))).toEqual(['orders']);
    expect(Object.keys(servers('B'))).toEqual(['agent-code-mode']);
    expect(servers('B')['agent-code-mode']?.args).toEqual(['cli.js', 'serve', '--host', 'claude', '--mcp-config', '/run/upstream-mcp.json']);
    expect(Object.keys(servers('C')).sort()).toEqual(['agent-code-mode', 'orders']);
    expect(servers('C')['agent-code-mode']?.args).toEqual(['cli.js', 'serve', '--host', 'claude', '--hybrid', '--mcp-config', '/run/upstream-mcp.json']);
    expect(upstreamMcpConfig(mcp.server)).toEqual({ mcpServers: { orders: { command: 'node', args: ['server.ts', '--seed', '1'] } } });
  });

  it('without an MCP task the configs are what they were', () => {
    expect(claudeMcpConfig('A', 'cli.js')).toEqual({ mcpServers: {} });
    expect(claudeMcpConfig('C', 'cli.js')).toEqual({ mcpServers: { 'agent-code-mode': { type: 'stdio', command: process.execPath, args: ['cli.js', 'serve', '--host', 'claude', '--hybrid'] } } });
  });

  it('the settings allow mcp__orders for T16 only', () => {
    const fixture = generateFixture(DEFAULT_FIXTURE_SEED);
    expect(JSON.stringify(claudeProjectSettings(task, fixture))).toContain('"mcp__orders"');
    expect(JSON.stringify(claudeProjectSettings(TASKS.T4, fixture))).not.toContain('mcp__orders');
  });

  it('B sees no task tool directly; the others see all three', () => {
    expect(taskDirectTools(task, 'B')).toEqual([]);
    expect(taskDirectTools(task, 'D')).toEqual([]);
    expect(taskDirectTools(task, 'A')).toEqual(['mcp__orders__list_customers', 'mcp__orders__list_orders', 'mcp__orders__get_order']);
  });

  it.each([
    ['A', { direct: 30, script: 0 }, []],
    ['A', { direct: 0, script: 0 }, ['native arm made no direct MCP tool call']],
    ['B', { direct: 0, script: 30 }, []],
    ['B', { direct: 0, script: 0 }, ['agent-code-mode arm made no mcpCall from a run script']],
    ['C', { direct: 3, script: 27 }, []],
    ['C', { direct: 0, script: 0 }, ['hybrid arm made no MCP call, direct or from a script']],
    ['D', { direct: 0, script: 30 }, []],
    ['D', { direct: 2, script: 30 }, ['Code Mode arm made 2 direct MCP tool call(s)']],
  ] as const)('checkMcpCalls %s %j', (arm, counts, reasons) => {
    expect(checkMcpCalls(arm, counts)).toEqual(reasons);
  });

  it('direct calls to the task tools are not calls outside the surface of the hybrid arm', () => {
    const calls = { native: 0, run: 2, codeMode: 0, other: 4, byName: { 'mcp__agent-code-mode__run': 2, mcp__orders__list_orders: 4 } };
    expect(checkArm('claude', 'C', calls).reasons).toEqual(['hybrid agent-code-mode arm made 4 call(s) to tools outside its surface']);
    expect(checkArm('claude', 'C', calls, taskDirectTools(task, 'C')).reasons).toEqual([]);
    expect(mcpCallCounts({ toolCalls: calls, innerCalls: { total: 9, byTool: { mcp__orders__get_order: 7, Read: 2 } } }, 'orders')).toEqual({ direct: 4, script: 7 });
  });

  it('the surface of A and C includes the task tools, B does not', () => {
    const a = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', ...taskDirectTools(task, 'A')];
    expect(checkSurface('claude', 'A', a, taskDirectTools(task, 'A'))).toEqual([]);
    expect(checkSurface('claude', 'A', a).join()).toMatch(/expected exactly/);
    expect(checkSurface('claude', 'B', ['mcp__agent-code-mode__run'], taskDirectTools(task, 'B'))).toEqual([]);
  });
});

describe('T16 in arm D', () => {
  it('REPL scripts may call the task tools and the discovery helpers, nothing else new', () => {
    const facts = { efforts: ['medium'], permissionModes: ['default'], replMode: true, finished: true, interrupted: false, sessionCost: null };
    const opts = { dryRun: true, claudeEffort: 'medium' as const };
    const ok = { ...facts, innerByTool: { searchTools: 1, mcp__orders__get_order: 3, Read: 1 } };
    expect(interactiveReasons(opts, { arm: 'D' }, null, ok, taskScriptTools(task))).toEqual([]);
    expect(interactiveReasons(opts, { arm: 'D' }, null, ok).join()).toMatch(/searchTools/);
    const other = { ...facts, innerByTool: { mcp__other__x: 1 } };
    expect(interactiveReasons(opts, { arm: 'D' }, null, other, taskScriptTools(task)).join()).toMatch(/mcp__other__x/);
  });
});

describe('T16 without the server', () => {
  it('the workspace commit names no seed', async () => {
    const ws = path.join(await mkdtemp(path.join(os.tmpdir(), 'acm-t16-ws-')), 'ws');
    await createWorkspace(ws, task, 'claude', DEFAULT_FIXTURE_SEED);
    const log = execFileSync('git', ['log', '--format=%B'], { cwd: ws, encoding: 'utf8' });
    expect(log.trim()).toBe('fixture for T16');
    expect(log).not.toContain(String(DEFAULT_FIXTURE_SEED));
  });

  const use = (input: unknown, synthetic = false) =>
    JSON.stringify({ type: 'assistant', ...(synthetic ? { isVirtual: true } : {}), message: { id: 'm', model: synthetic ? '<synthetic>' : 'x', content: [{ type: 'tool_use', id: 'u', name: 'Bash', input }] } });

  it.each([
    ['reading the bench config next to the workspace', { command: 'cat ../mcp-config.json' }],
    ['reading the server source', { file_path: '/repo/bench/x/server.ts' }],
    ['calling the generator from a script', { code: "const { t16Data } = await import(p); return t16Data(1115);" }],
    ['reading the process table', { command: 'ps aux | grep node' }],
    ['reading /proc', { command: 'cat /proc/123/cmdline' }],
  ])('%s makes the run invalid', (_label, input) => {
    expect(offLimitsHits(task, use(input)).length).toBeGreaterThan(0);
    expect(offLimitsHits(task, use(input, true)).length).toBeGreaterThan(0);
  });

  it('ordinary tool calls and text that only mentions a marker do not', () => {
    const text = JSON.stringify({ type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'I will not read mcp-config.json or server.ts' }] } });
    expect(offLimitsHits(task, [use({ server: 'orders', tool: 'list_orders', args: { customer_id: 'C-0001' } }), text].join('\n'))).toEqual([]);
    expect(toolInputsText(use({ command: 'ls' }))).toBe('{"command":"ls"}');
    expect(offLimitsHits(TASKS.T4, use({ command: 'ps aux' }))).toEqual([]);
  });
});

describe('context per request', () => {
  it('is the largest and the last prompt (uncached input + cache read + cache write)', () => {
    expect(contextOf([])).toBeNull();
    expect(contextOf([10, 50, 30])).toEqual({ peak: 50, last: 30 });
    const ev = (id: string, input: number, read: number, write: number) =>
      JSON.stringify({ type: 'assistant', message: { id, content: [{ type: 'text', text: 'x' }], usage: { input_tokens: input, output_tokens: 1, cache_read_input_tokens: read, cache_creation_input_tokens: write } } });
    const result = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1, total_cost_usd: 0, result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } });
    const parsed = parseClaudeTranscript([ev('m1', 5, 1000, 200), ev('m1', 5, 1000, 200), ev('m2', 3, 1500, 40), result].join('\n'));
    expect(parsed.context).toEqual({ peak: 1543, last: 1543 });
    expect(parseClaudeTranscript([ev('m1', 5, 3000, 0), ev('m2', 3, 1500, 40), result].join('\n')).context).toEqual({ peak: 3005, last: 1543 });
  });
});
