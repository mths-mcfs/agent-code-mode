import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema, ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { McpServerSpec, Sandbox, SessionContext } from '../core/types.js';
import { McpUpstreams } from '../mcp/upstream.js';
import { FakeSandbox } from '../testing/fake-sandbox.js';
import { MemoryToolRuntime } from '../testing/memory-tool-runtime.js';
import { StaticHostAdapter } from '../testing/static-host-adapter.js';
import { ClaudeContextProvider } from '../hosts/claude/context.js';
import { CodexContextProvider } from '../hosts/codex/context.js';
import { FileTransaction } from '../tools/journal.js';
import { NodeToolRuntime } from '../tools/runtime.js';
import { ROOTED_OPS_REFUSED } from '../testing/platform.js';
import { GenericContextProvider } from './context.js';
import { GenericHostAdapter } from './generic-adapter.js';
import { CODEX_SEARCH_NOTE } from '../hosts/codex/index.js';
import { QuickJsSandbox } from '../sandbox/quickjs-sandbox.js';
import { HYBRID_GUIDANCE, RUN_DESCRIPTION, RUN_LOG_ENV, createMcpServer } from './mcp.js';
import { createRuntime, type Runtime, type RuntimeFactory } from './runtime.js';

const root = os.tmpdir();
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
});

async function connect(opts: { env?: Record<string, string>; host?: 'claude' | 'codex' | 'generic'; sandbox?: Sandbox; hybrid?: boolean } = {}) {
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
    createRuntime: runtime,
    recoverJournals: false,
    ...(opts.host ? { host: opts.host } : {}),
    ...(opts.hybrid ? { hybrid: true } : {}),
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
    expect(tools[0]?.description).toBe(RUN_DESCRIPTION);
    expect(tools[0]?.description).toContain('readOverflow(id, offset?, limit?)');
    expect(tools[0]?.description).toContain(CODEX_SEARCH_NOTE);
    expect(client.getInstructions()).toBe(CODEX_SEARCH_NOTE);
  });

  it('adds the hybrid guidance to the run description only with --hybrid', async () => {
    const { client } = await connect({ hybrid: true });
    const { tools } = await client.listTools();
    expect(tools[0]?.description).toBe(`${RUN_DESCRIPTION}\n${HYBRID_GUIDANCE}`);
  });

  it('returns a default readOverflow page whole, so paging needs no further overflow', async () => {
    const { client } = await connect({ sandbox: new QuickJsSandbox() });
    const first = JSON.parse(textOf(await client.callTool({ name: 'run', arguments: { code: `return '"'.repeat(120000);` } }))) as { overflow: { id: string } };
    const page = JSON.parse(textOf(await client.callTool({ name: 'run', arguments: { code: `return await readOverflow(${JSON.stringify(first.overflow.id)});` } })));
    expect(page).not.toHaveProperty('truncated');
    expect(page).toMatchObject({ ok: true, result: { offset: 0, truncated: true } });
  });

  it('keeps the whole target of every denied call, however long, for readOverflow', async () => {
    const { client } = await connect({ sandbox: new QuickJsSandbox() });
    const code = `for (let i = 0; i < 500; i++) { try { await bash({ command: 'rm f' + 'a'.repeat(170) + i }); } catch {} } return 1;`;
    const first = JSON.parse(textOf(await client.callTool({ name: 'run', arguments: { code } }))) as { calls: { denied: { calls: string[] }[] }; overflow?: { id: string } };
    const targets = Array.from({ length: 500 }, (_, i) => `bash rm f${'a'.repeat(170)}${i}`);
    const shown = first.calls.denied.flatMap((g) => g.calls).filter((c) => !c.startsWith('…'));
    expect(shown.length).toBeGreaterThan(0);
    expect(shown).toEqual(targets.slice(0, shown.length));
    const back = `let t = ''; for (;;) { const s = await readOverflow(${JSON.stringify(first.overflow?.id ?? '')}, t.length); t += s.text; if (!s.truncated) break; } const denied = JSON.parse(t).calls.filter((c) => c.decision === 'denied').map((c) => c.summary); return { count: denied.length, exact: denied.every((d, i) => d === 'bash rm f' + 'a'.repeat(170) + i) };`;
    expect(JSON.parse(textOf(await client.callTool({ name: 'run', arguments: { code: back } })))).toMatchObject({ result: { count: 500, exact: true } });
  });

  it('logs a readOverflow failure the script caught', async () => {
    const { client } = await connect({ sandbox: new QuickJsSandbox() });
    const body = JSON.parse(textOf(await client.callTool({ name: 'run', arguments: { code: `try { await readOverflow('unknown'); } catch (e) { return e.name; }` } })));
    expect(body).toMatchObject({ ok: true, result: 'ToolError', calls: { total: 1, byTool: { readOverflow: 1 }, errors: [{ tool: 'readOverflow', summary: 'readOverflow unknown' }] } });
  });

  it('reads back with readOverflow what a response cut', async () => {
    const { client } = await connect({ sandbox: new QuickJsSandbox() });
    const first = JSON.parse(textOf(await client.callTool({ name: 'run', arguments: { code: `return Array.from({ length: 20000 }, (_, i) => 'row ' + i);` } }))) as { overflow: { id: string; chars: number } };
    const code = `let text = ''; for (;;) { const s = await readOverflow(${JSON.stringify(first.overflow.id)}, text.length); text += s.text; if (!s.truncated) break; } return JSON.parse(text).result.length;`;
    const second = JSON.parse(textOf(await client.callTool({ name: 'run', arguments: { code } })));
    expect(second).toMatchObject({ ok: true, result: 20000 });
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
      calls: unknown;
      changedFiles: string[];
      diff: string;
    };
    expect(body.ok).toBe(true);
    expect(body.calls).toEqual({
      total: 3,
      byTool: { write: 1, bash: 1, read: 1 },
      denied: [{ id: 'c2', tool: 'bash', summary: 'bash rm -rf /', reason: 'rule: rm is not allowed' }],
    });
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
    expect(body).toHaveProperty('overflow.id', expect.any(String));

    const invalid = await client.callTool({ name: 'run', arguments: { code: 'x', transaction: 'y'.repeat(100_000) } });
    expect(invalid.isError).toBe(true);
    expect(textOf(invalid).length).toBeLessThanOrEqual(9_500);
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

async function connectReal(opts: { serverCwd: string; stateDir: string; roots?: readonly string[]; env?: Record<string, string>; createRuntime?: RuntimeFactory }) {
  const server = createMcpServer({
    version: '0.0.0-test',
    env: opts.env ?? {},
    serverCwd: opts.serverCwd,
    stateDir: opts.stateDir,
    ...(opts.createRuntime ? { createRuntime: opts.createRuntime } : {}),
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: { roots: {} } });
  client.setRequestHandler(ListRootsRequestSchema, () => ({ roots: (opts.roots ?? []).map((r) => ({ uri: pathToFileURL(r).href })) }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

describe('MCP server and the session\'s upstream servers', () => {
  it('runs no script before the session\'s upstream servers are spawned', async () => {
    const upstreams = new McpUpstreams();
    let release: (specs: readonly McpServerSpec[]) => void = () => undefined;
    upstreams.start(new Promise((resolve) => (release = resolve)));
    const sandbox = new FakeSandbox();
    const adapter = new StaticHostAdapter();
    const factory: RuntimeFactory = (host) => ({ host, contextProvider: new GenericContextProvider(), adapter, tools: new MemoryToolRuntime({ root: '/ws' }), sandbox, maxTimeoutMs: 10_000 });
    const server = createMcpServer({ version: '0', env: {}, serverCwd: '/ws', stateDir: '/nonexistent-state', recoverJournals: false, createRuntime: factory, upstreams });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closers.push(async () => {
      await client.close();
      await server.close();
    });
    let done = false;
    const pending = client.callTool({ name: 'run', arguments: { code: JSON.stringify([{ log: 'ran' }]) } }).then((r) => ((done = true), r));
    await new Promise((r) => setTimeout(r, 200));
    expect(done).toBe(false);
    release([]);
    expect(JSON.stringify((await pending).content)).toContain('ran');
  });
});

describe.skipIf(ROOTED_OPS_REFUSED)('MCP server with the real runtime', () => {
  let base: string;
  let workspace: string;
  let stateDir: string;

  beforeEach(() => {
    base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'acm-mcp-')));
    workspace = path.join(base, 'ws');
    stateDir = path.join(base, 'state');
    mkdirSync(workspace);
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  async function crashedWrite(file: string, content: string, root = workspace): Promise<void> {
    const tools = new NodeToolRuntime({ stateDir });
    const tx = tools.beginTransaction();
    if (!(tx instanceof FileTransaction)) throw new Error('expected a disk journal');
    const ctx = { host: 'generic' as const, cwd: root, roots: [root], permissionMode: 'default', sources: {} };
    const policy = { host: 'generic' as const, bashContainment: { mode: 'none' as const }, protectedPaths: [], payload: null };
    const prepared = await tools.prepare({ id: 'c1', tool: 'write', args: { path: file, content } }, ctx, policy);
    await tools.commit(prepared, new AbortController().signal, tx);
    const dead = Number(execFileSync(process.execPath, ['-p', 'process.pid'], { encoding: 'utf8' }));
    const manifest = path.join(tx.dir, 'manifest.json');
    writeFileSync(manifest, readFileSync(manifest, 'utf8').replace(`"pid":${process.pid},`, `"pid":${dead},`));
  }

  it('leaves the overflow files older versions wrote in the state directory, and writes none', async () => {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const old = path.join(stateDir, 'run-1732500000000-0123456789ab.json');
    writeFileSync(old, '{"ok":true}');
    const client = await connectReal({ serverCwd: workspace, stateDir });
    const body = JSON.parse(textOf(await client.callTool({ name: 'run', arguments: { code: `return 'x'.repeat(60000);` } })));
    expect(body).toHaveProperty('overflow.id');
    expect(readFileSync(old, 'utf8')).toBe('{"ok":true}');
    expect(readdirSync(stateDir).filter((n) => n.startsWith('run-'))).toEqual([path.basename(old)]);
  });

  it('runs JavaScript in the real sandbox and applies the generic policy: reads only', async () => {
    writeFileSync(path.join(workspace, 'a.txt'), 'hello\n');
    const client = await connectReal({ serverCwd: workspace, stateDir });
    const code = `const r = await read({ path: 'a.txt' });
let w; try { await write({ path: 'b.txt', content: 'x' }); w = 'written'; } catch (e) { w = e.name; }
return { content: r.content, w };`;
    const body = JSON.parse(textOf(await client.callTool({ name: 'run', arguments: { code } })));
    expect(body).toMatchObject({ ok: true, result: { content: 'hello\n', w: 'PermissionDenied' } });
    expect(body.calls).toMatchObject({ total: 2, denied: [{ id: 'c2', tool: 'write' }] });
  });

  it('restores what a crashed run left in the server cwd at start, and reports it in the first run and the run log', async () => {
    writeFileSync(path.join(workspace, 'a.txt'), 'original');
    await crashedWrite('a.txt', 'half-done');
    const log = path.join(base, 'run.log');
    const client = await connectReal({ serverCwd: workspace, stateDir, env: { [RUN_LOG_ENV]: log } });
    const first = JSON.parse(textOf(await client.callTool({ name: 'run', arguments: { code: `return (await read({ path: 'a.txt' })).content;` } })));
    expect(first.result).toBe('original');
    expect(first.warnings.join('\n')).toContain(`restored: ${path.join(workspace, 'a.txt')}`);
    const second = JSON.parse(textOf(await client.callTool({ name: 'run', arguments: { code: 'return 1;' } })));
    expect(second).not.toHaveProperty('warnings');
    const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.event)).toEqual(['recovery', 'run', 'run']);
    expect(lines[0]).toMatchObject({ trigger: 'startup', journals: [{ restored: [path.join(workspace, 'a.txt')], conflicts: [], leftoverTemps: [] }] });
    expect(lines[1]).toMatchObject({ recovery: [{ trigger: 'startup' }], calls: [{ decision: 'allowed' }] });
    expect(lines[2].recovery).toBeUndefined();
  });

  it('recovers a workspace root once, on the first run that names it', async () => {
    const elsewhere = path.join(base, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(path.join(workspace, 'a.txt'), 'original');
    await crashedWrite('a.txt', 'half-done');
    const client = await connectReal({ serverCwd: elsewhere, stateDir, roots: [workspace] });
    const first = JSON.parse(textOf(await client.callTool({ name: 'run', arguments: { code: `return (await read({ path: 'a.txt' })).content;` } })));
    expect(first.result).toBe('original');
    expect(first.warnings.join('\n')).toContain('restored');
    await crashedWrite('a.txt', 'again');
    const second = JSON.parse(textOf(await client.callTool({ name: 'run', arguments: { code: `return (await read({ path: 'a.txt' })).content;` } })));
    expect(second.result).toBe('again');
  });

  it('reports a file changed since the crash as a conflict and leaves it alone', async () => {
    writeFileSync(path.join(workspace, 'a.txt'), 'original');
    await crashedWrite('a.txt', 'half-done');
    writeFileSync(path.join(workspace, 'a.txt'), 'edited by hand');
    const client = await connectReal({ serverCwd: workspace, stateDir });
    const first = JSON.parse(textOf(await client.callTool({ name: 'run', arguments: { code: `return (await read({ path: 'a.txt' })).content;` } })));
    expect(first.result).toBe('edited by hand');
    expect(first.warnings.join('\n')).toContain('was not restored (changed-externally');
  });

  it("recovers the host policy's additional roots, which neither the cwd nor the client roots name", async () => {
    const extra = path.join(base, 'extra');
    mkdirSync(extra);
    writeFileSync(path.join(extra, 'a.txt'), 'original');
    await crashedWrite('a.txt', 'half-done', extra);
    const generic = new GenericHostAdapter({ stateDir });
    const factory: RuntimeFactory = (host) => ({
      ...createRuntime(host, { env: {}, serverCwd: workspace, stateDir }),
      adapter: {
        host: 'generic',
        loadPolicy: async (ctx) => ({ ...(await generic.loadPolicy(ctx)), additionalRoots: [extra] }),
        checkStatic: (prepared) => generic.checkStatic(prepared),
        authorize: () => generic.authorize(),
      },
    });
    const client = await connectReal({ serverCwd: workspace, stateDir, createRuntime: factory });
    const first = JSON.parse(textOf(await client.callTool({ name: 'run', arguments: { code: `return (await read({ path: ${JSON.stringify(path.join(extra, 'a.txt'))} })).content;` } })));
    expect(first.result).toBe('original');
    expect(first.warnings.join('\n')).toContain(`restored: ${path.join(extra, 'a.txt')}`);
  });
  it('restores additional roots outside all declared MCP roots', async () => {
    const declared = path.join(base, 'declared');
    const extra = path.join(base, 'custom');
    mkdirSync(declared);
    mkdirSync(extra);
    const file = path.join(extra, 'document.txt');
    writeFileSync(file, 'original');
    await crashedWrite('document.txt', 'half-done', extra);

    const createTestRuntime: RuntimeFactory = (host) => {
      const runtime = createRuntime(host, { env: {}, serverCwd: workspace, stateDir });
      const generic = new GenericHostAdapter({ stateDir });
      return {
        ...runtime,
        adapter: {
          host: 'generic',
          loadPolicy: async (ctx) => ({ ...(await generic.loadPolicy(ctx)), additionalRoots: [extra] }),
          checkStatic: (prepared) => generic.checkStatic(prepared),
          authorize: () => generic.authorize(),
        },
      };
    };
    const client = await connectReal({ serverCwd: workspace, stateDir, roots: [declared], createRuntime: createTestRuntime });
    const first = await client.callTool({
      name: 'run',
      arguments: { code: `return (await read({ path: ${JSON.stringify(file)} })).content;` },
    });
    expect(JSON.parse(textOf(first))).toMatchObject({ ok: true, result: 'original' });
    expect(readFileSync(file, 'utf8')).toBe('original');
  });

  it('leaves a journal entry for a host-protected file untouched', async () => {
    const declared = path.join(base, 'declared');
    mkdirSync(declared);
    const file = path.join(declared, 'protected.txt');
    writeFileSync(file, 'original');
    await crashedWrite('protected.txt', 'current', declared);

    const createTestRuntime: RuntimeFactory = (host) => {
      const runtime = createRuntime(host, { env: {}, serverCwd: workspace, stateDir });
      const generic = new GenericHostAdapter({ stateDir });
      return {
        ...runtime,
        adapter: {
          host: 'generic',
          loadPolicy: async (ctx) => ({ ...(await generic.loadPolicy(ctx)), protectedPaths: [file] }),
          checkStatic: (prepared) => generic.checkStatic(prepared),
          authorize: () => generic.authorize(),
        },
      };
    };
    const client = await connectReal({ serverCwd: workspace, stateDir, roots: [declared], createRuntime: createTestRuntime });
    const first = await client.callTool({ name: 'run', arguments: { code: 'return 1;' } });
    expect(textOf(first)).toContain('a protected host policy path');
    expect(readFileSync(file, 'utf8')).toBe('current');
  });

  it('makes concurrent first runs wait for recovery of the extra root', async () => {
    const extra = path.join(base, 'extra');
    mkdirSync(extra);
    const file = path.join(extra, 'document.txt');
    writeFileSync(file, 'original');
    await crashedWrite('document.txt', 'half-done', extra);

    let releasePolicy = () => {};
    let policyStarted = () => {};
    const pending = new Promise<void>((resolve) => { releasePolicy = resolve; });
    const started = new Promise<void>((resolve) => { policyStarted = resolve; });
    let policyCalls = 0;
    const createTestRuntime: RuntimeFactory = (host) => {
      const runtime = createRuntime(host, { env: {}, serverCwd: workspace, stateDir });
      const generic = new GenericHostAdapter({ stateDir });
      return {
        ...runtime,
        adapter: {
          host: 'generic',
          loadPolicy: async (ctx) => {
            if (++policyCalls === 1) {
              policyStarted();
              await pending;
            }
            return { ...(await generic.loadPolicy(ctx)), additionalRoots: [extra] };
          },
          checkStatic: (prepared) => generic.checkStatic(prepared),
          authorize: () => generic.authorize(),
        },
      };
    };
    const client = await connectReal({ serverCwd: workspace, stateDir, createRuntime: createTestRuntime });
    const request = {
      name: 'run',
      arguments: { code: `return (await read({ path: ${JSON.stringify(file)} })).content;` },
    };
    const first = client.callTool(request);
    await started;
    const second = client.callTool(request);
    const releaseTimer = setTimeout(releasePolicy, 2_000);
    try {
      const result = await second;
      expect(JSON.parse(textOf(result))).toMatchObject({ ok: true, result: 'original' });
    } finally {
      clearTimeout(releaseTimer);
      releasePolicy();
      await first;
    }
  });

});
