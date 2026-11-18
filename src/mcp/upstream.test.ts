import { afterEach, describe, expect, it } from 'vitest';
import { FAKE_MCP_UPSTREAM, memoryMcpRuntime } from '../testing/index.js';
import { connectUpstreams, type McpUpstream } from './upstream.js';

// The boundary with real stdio upstream servers (the fake in src/testing): what a listing or a result may hide.

let up: McpUpstream | undefined;
afterEach(async () => {
  await up?.close();
  up = undefined;
});

async function connect(variant: string): Promise<McpUpstream> {
  up = await connectUpstreams([{ name: 'srv', command: process.execPath, args: [FAKE_MCP_UPSTREAM, variant], env: {} }], { connectTimeoutMs: 10_000 });
  return up;
}

const signal = new AbortController().signal;

async function callTool(u: McpUpstream, tool: string) {
  const entry = u.catalog.lookup('srv', tool);
  if (entry === undefined) throw new Error(`no ${tool}`);
  return u.call(entry, {}, { signal, timeoutMs: 5_000 });
}

describe('tools/list', () => {
  it('a name listed again past the 500-tool cap is a collision: the tool is left out', async () => {
    const u = await connect('dup-past-cap');
    expect(u.catalog.lookup('srv', 'dup')).toBeUndefined();
    expect(u.catalog.lookup('srv', 't0')).toBeDefined();
    expect(u.catalog.problems.join('\n')).toContain('mcp__srv__dup names more than one tool');
    expect(u.catalog.problems.join('\n')).toContain('lists more tools than 500');
  });
});

describe('tools/list, per tool', () => {
  it('a name listed again after more than 10,000 other names is still a collision', async () => {
    const u = await connect('dup-far');
    expect(u.catalog.lookup('srv', 'valid')).toBeUndefined();
    expect(u.catalog.problems.join('\n')).toContain('mcp__srv__valid names more than one tool');
  });

  it('an outputSchema that does not compile leaves out that tool only, without fetching the reference', async () => {
    const u = await connect('bad-ref');
    expect(u.catalog.tools.map((t) => t.tool)).toEqual(['valid']);
    expect(u.catalog.problems.join('\n')).toMatch(/tool "broken" of MCP server "srv" left out: .*example\.invalid/);
  });
});

describe('tools/call results', () => {
  it('the outputSchema of every page is checked the same way', async () => {
    const u = await connect('schema-pages');
    expect(u.catalog.tools.map((t) => t.tool)).toEqual(['page1', 'page2']);
    for (const tool of ['page1', 'page2']) {
      expect(await callTool(u, tool)).toMatchObject({ ok: false, failure: { kind: 'invalid-result', message: expect.stringContaining('outputSchema') } });
    }
  });

  it('structuredContent keeps a `__proto__` key as data', async () => {
    const u = await connect('inventory');
    const out = await callTool(u, 'proto_data');
    expect(out.ok).toBe(true);
    const rt = memoryMcpRuntime(u);
    const parsed = rt.parse({ server: 'srv', tool: 'proto_data' }, 'c1');
    if (!parsed.ok) throw new Error(parsed.message);
    const result = await rt.commit(rt.prepare(parsed.call), signal);
    expect(JSON.stringify(result.structuredContent)).toBe('{"__proto__":"literal","normal":true}');
    expect(Object.getPrototypeOf(result.structuredContent)).toBe(Object.prototype);
  });

  it('a result with neither content nor structuredContent is a format error, not an empty success', async () => {
    const u = await connect('inventory');
    const rt = memoryMcpRuntime(u);
    const parsed = rt.parse({ server: 'srv', tool: 'empty_result' }, 'c1');
    if (!parsed.ok) throw new Error(parsed.message);
    await expect(rt.commit(rt.prepare(parsed.call), signal)).rejects.toMatchObject({ code: 'tool-error', message: expect.stringContaining('neither content nor structuredContent') });
  });

  it('onSent fires for a call that goes out, not for one refused unsent', async () => {
    const u = await connect('inventory');
    let sent = 0;
    const entry = u.catalog.lookup('srv', 'list_items');
    const crash = u.catalog.lookup('srv', 'crash');
    if (!entry || !crash) throw new Error('catalog');
    await u.call(entry, {}, { signal, timeoutMs: 5_000, onSent: () => sent++ });
    await u.call(crash, {}, { signal, timeoutMs: 5_000, onSent: () => sent++ });
    expect(sent).toBe(2);
    const after = await u.call(entry, {}, { signal, timeoutMs: 5_000, onSent: () => sent++ });
    expect(after).toMatchObject({ ok: false, failure: { kind: 'not-connected' } });
    expect(sent).toBe(2);
  });
});
