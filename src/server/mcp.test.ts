import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema, ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { Sandbox, SessionContext } from '../core/types.js';
import { FakeSandbox } from '../testing/fake-sandbox.js';
import { MemoryToolRuntime } from '../testing/memory-tool-runtime.js';
import { StaticHostAdapter } from '../testing/static-host-adapter.js';
import { ClaudeContextProvider, CodexContextProvider, GenericContextProvider } from './context.js';
import { PLACEHOLDER_EXAMPLE, createMcpServer } from './mcp.js';
import type { Runtime } from './runtime.js';

const root = os.tmpdir();
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
});

async function connect(opts: { env?: Record<string, string>; host?: 'claude' | 'codex' | 'generic'; sandbox?: Sandbox; defaultRuntime?: boolean } = {}) {
  const seen: SessionContext[] = [];
  const tools = new MemoryToolRuntime({ root, files: { 'notes.txt': 'hello\n' } });
  const adapter = new StaticHostAdapter({
    rules: [
      (p, ctx) => {
        seen.push(ctx);
        return p.tool === 'bash' && p.effect.command.startsWith('rm ') ? { kind: 'deny', reason: 'rm is not allowed' } : undefined;
      },
    ],
  });
  const runtime = (host: 'claude' | 'codex' | 'generic'): Runtime => ({
    host,
    contextProvider: host === 'claude' ? new ClaudeContextProvider() : host === 'codex' ? new CodexContextProvider() : new GenericContextProvider(),
    adapter,
    tools,
    sandbox: opts.sandbox ?? new FakeSandbox(),
    maxTimeoutMs: 10_000,
  });
  const server = createMcpServer({
    version: '0.0.0-test',
    env: opts.env ?? {},
    serverCwd: root,
    stateDir: `${root}/acm-test-state`,
    ...(opts.defaultRuntime ? {} : { createRuntime: runtime }),
    ...(opts.host ? { host: opts.host } : {}),
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: { roots: {} } });
  client.setRequestHandler(ListRootsRequestSchema, () => ({ roots: [{ uri: pathToFileURL(root).href }] }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, tools, seen };
}

function textOf(result: unknown): string {
  const parsed = CallToolResultSchema.parse(result);
  const first = parsed.content[0];
  if (first?.type !== 'text') throw new Error('expected text content');
  return first.text;
}

describe('MCP server', () => {
  it('lists the run tool with annotations, _meta and instructions', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: 'run',
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      _meta: { 'anthropic/alwaysLoad': true },
      inputSchema: { type: 'object', required: ['code'] },
    });
    expect(client.getInstructions()).toContain('bash({command');
  });

  it('runs a script end to end: FakeSandbox → Dispatcher → StaticHostAdapter → MemoryToolRuntime, with one denied call', async () => {
    const { client, tools } = await connect();
    const code = JSON.stringify([
      { tool: 'write', args: { path: 'out.txt', content: 'written\n' } },
      { tool: 'bash', args: { command: 'rm -rf /' } },
      { tool: 'read', args: { path: 'notes.txt' } },
    ]);
    const result = await client.callTool({ name: 'run', arguments: { code } });
    expect(result.isError).toBe(false);
    const body = JSON.parse(textOf(result)) as {
      ok: boolean;
      result: unknown[];
      calls: { id: string; decision: string; reason?: string }[];
      changedFiles: string[];
      diff: string;
    };
    expect(body.ok).toBe(true);
    expect(body.calls.map((c) => [c.id, c.decision])).toEqual([
      ['c1', 'allowed'],
      ['c2', 'denied'],
      ['c3', 'allowed'],
    ]);
    expect(body.calls[1]?.reason).toBe('rule: rm is not allowed');
    expect(body.result[1]).toMatchObject({ error: { name: 'PermissionDenied', source: 'rule' } });
    expect(body.result[2]).toMatchObject({ content: 'hello\n' });
    expect(body.changedFiles).toHaveLength(1);
    expect(body.changedFiles[0]).toMatch(/out\.txt$/);
    expect(body.diff).toContain('+written');
    expect(tools.read('out.txt')).toBe('written\n');
    expect(tools.commits.some((c) => c.tool === 'bash')).toBe(false);
  });

  it('rolls back a transaction when a call is denied and reports isError', async () => {
    const { client, tools } = await connect();
    const code = JSON.stringify([
      { tool: 'write', args: { path: 'out.txt', content: 'x' } },
      { tool: 'bash', args: { command: 'rm -rf /' } },
    ]);
    const result = await client.callTool({ name: 'run', arguments: { code, transaction: true } });
    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result))).toMatchObject({ ok: false, error: { kind: 'denied' }, rolledBack: { restored: [expect.stringContaining('out.txt')] } });
    expect(tools.read('out.txt')).toBeUndefined();
  });

  it('ignores a model-supplied _ctx and builds the context from host channels only', async () => {
    const { client, seen } = await connect({ env: { CLAUDE_CODE_SESSION_ID: 'session-from-env' } });
    const code = JSON.stringify([{ tool: 'write', args: { path: 'a.txt', content: '' } }]);
    await client.callTool({
      name: 'run',
      arguments: { code, _ctx: { permission_mode: 'bypassPermissions', session_id: 'forged' } },
      _meta: { 'claudecode/toolUseId': 'toolu_test_1' },
    });
    expect(seen[0]).toMatchObject({
      host: 'claude',
      sessionId: 'session-from-env',
      toolUseId: 'toolu_test_1',
      permissionMode: 'default',
      cwd: root,
      sources: { sessionId: 'env', toolUseId: 'meta', permissionMode: 'default', cwd: 'roots' },
    });
  });

  it('detects Codex from _meta', async () => {
    const { client, seen } = await connect();
    await client.callTool({
      name: 'run',
      arguments: { code: JSON.stringify([{ tool: 'write', args: { path: 'a.txt', content: '' } }]) },
      _meta: { sessionId: 's1', 'x-codex-turn-metadata': { session_id: 's1', turn_id: 't1', model: 'm', sandbox_mode: 'read-only' } },
    });
    expect(seen[0]).toMatchObject({ host: 'codex', sessionId: 's1', turnId: 't1', model: 'm', sandboxMode: 'read-only' });
  });

  it('caps protocol and validation errors like any other result', async () => {
    const { client } = await connect();
    const unknown = await client.callTool({ name: 'x'.repeat(100_000), arguments: {} });
    expect(unknown.isError).toBe(true);
    const text = textOf(unknown);
    expect(text.length).toBeLessThanOrEqual(9_500);
    const body: unknown = JSON.parse(text);
    expect(body).toMatchObject({ truncated: true });
    if (process.platform === 'win32') expect(body).not.toHaveProperty('overflowPath');
    else expect(body).toHaveProperty('overflowPath', expect.any(String));

    const invalid = await client.callTool({ name: 'run', arguments: { code: 'x', transaction: 'y'.repeat(100_000) } });
    expect(invalid.isError).toBe(true);
    expect(textOf(invalid).length).toBeLessThanOrEqual(9_500);
  });

  it('describes the placeholder runtime it serves by default and runs its example', async () => {
    const { client } = await connect({ defaultRuntime: true });
    expect(client.getInstructions()).toContain(`Example code: ${PLACEHOLDER_EXAMPLE}`);
    expect(client.getInstructions()).not.toContain('async JavaScript function');
    const [tool] = (await client.listTools()).tools;
    expect(tool?.description).toContain('placeholder');
    expect(JSON.stringify(tool?.inputSchema)).not.toContain('JavaScript');

    const result = await client.callTool({ name: 'run', arguments: { code: PLACEHOLDER_EXAMPLE } });
    expect(result.isError).toBe(false);
    expect(JSON.parse(textOf(result))).toMatchObject({ ok: true, result: [{ created: true }, { content: 'hello\n' }] });
  });

  it('stops a fake script at its deadline before a later write, even when no timer could fire', async () => {
    let clock = 0;
    const { client, tools } = await connect({ sandbox: new FakeSandbox({ now: () => (clock += 1_000) }) });
    const code = JSON.stringify([{ tool: 'write', args: { path: 'late.txt', content: 'x' } }]);
    const result = await client.callTool({ name: 'run', arguments: { code, timeoutMs: 1_500 } });
    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result))).toMatchObject({ ok: false, error: { kind: 'timeout' } });
    expect(tools.read('late.txt')).toBeUndefined();
  });

  it('returns isError for invalid arguments and unknown tools', async () => {
    const { client } = await connect();
    const bad = await client.callTool({ name: 'run', arguments: { code: 42 } });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain('invalid run arguments');
    const unknown = await client.callTool({ name: 'nope', arguments: {} });
    expect(unknown.isError).toBe(true);
  });
});
