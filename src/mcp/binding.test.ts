import { describe, expect, it } from 'vitest';
import { ToolError } from '../core/errors.js';
import { OverflowStore } from '../core/overflow.js';
import { MemoryMcpUpstream, memoryMcpRuntime } from '../testing/index.js';
import { shapeResult } from './binding.js';

const upstream = new MemoryMcpUpstream({ inventory: ['get_item', 'list_items'] });
const runtime = memoryMcpRuntime(upstream);

describe('McpBindingRuntime.parse', () => {
  it('accepts a cataloged tool with object args and an optional timeout', () => {
    const r = runtime.parse({ server: 'inventory', tool: 'get_item', args: { sku: 'A-1' }, options: { timeoutMs: 500 } }, 'c1');
    expect(r).toEqual({ ok: true, call: { id: 'c1', tool: 'mcp', args: { server: 'inventory', tool: 'get_item', input: { sku: 'A-1' }, timeoutMs: 500 } } });
    expect(runtime.parse({ server: 'inventory', tool: 'list_items' }, 'c2')).toMatchObject({ ok: true, call: { args: { input: {} } } });
  });

  it.each([
    [{ server: 'nope', tool: 'get_item' }, 'unknown MCP server'],
    [{ server: 'inventory', tool: 'nope' }, 'has no tool'],
    [{ server: 'inventory', tool: '__proto__' }, 'has no tool'],
    [{ server: '__proto__', tool: 'get_item' }, 'unknown MCP server'],
    [{ server: 'inventory', tool: 'get_item', args: [1, 2] }, 'args must be an object'],
    [{ server: 'inventory', tool: 'get_item', args: 'sku=A-1' }, 'args must be an object'],
    [{ server: 'inventory', tool: 'get_item', args: null }, 'args must be an object'],
    [{ server: 'inventory', tool: 'get_item', args: 7 }, 'args must be an object'],
    [{ server: 'inventory', tool: 'get_item', extra: 1 }, 'extra'],
    [{ server: 'inventory', tool: 'get_item', options: { timeoutMs: 0 } }, 'options.timeoutMs'],
    [{ server: 'inventory', tool: 'get_item', options: { timeoutMs: 10_000_000 } }, 'options.timeoutMs'],
    [{ server: 'inventory', tool: 'get_item', options: { retries: 3 } }, 'retries'],
    [{ server: 1, tool: 'get_item' }, 'server'],
    [null, 'args'],
    ['inventory.get_item', 'args'],
  ])('refuses %j', (raw, message) => {
    const r = runtime.parse(raw, 'c1');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain(message);
  });
});

describe('shapeResult', () => {
  it('returns structuredContent when present, with isError', () => {
    expect(shapeResult({ content: [{ type: 'text', text: 'x' }], structuredContent: { qty: 3 } }, 1_000, undefined, 't')).toEqual({ isError: false, structuredContent: { qty: 3 } });
  });

  it('else joins the text of the content blocks; other blocks become notes', () => {
    const r = shapeResult(
      {
        isError: true,
        content: [
          { type: 'text', text: 'one' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          { type: 'resource', resource: { uri: 'file:///a', text: 'res text' } },
          { type: 'resource_link', uri: 'file:///b', name: 'b' },
          { type: 'resource', resource: { uri: 'file:///c', blob: 'AAAA', mimeType: 'application/pdf' } },
        ],
      },
      1_000,
      undefined,
      't',
    );
    expect(r).toEqual({ isError: true, text: 'one\n[image content omitted (image/png)]\nres text\n[resource link file:///b]\n[resource file:///c (application/pdf): binary content omitted]' });
  });

  it.each([
    [{ content: 'nope' }],
    [null],
    ['text'],
    [{ isError: 'yes' }],
    [{ structuredContent: [1] }],
    [{ content: [null] }],
    [{ content: [{ type: 'text', text: 12 }] }],
    [{ content: [{ type: 'invented' }] }],
    [{ content: [{ type: 'image', mimeType: 'image/png' }] }],
    [{ content: [{ type: 'resource_link', uri: 'file:///b' }] }],
    [{ content: [{ type: 'resource', resource: { uri: 'file:///a' } }] }],
  ])('throws on an invalid result %j', (raw) => {
    expect(() => shapeResult(raw, 1_000, undefined, 't')).toThrow(ToolError);
  });

  it('above the cap, keeps the whole text in the overflow store and returns its start', () => {
    const store = new OverflowStore();
    const big = 'y'.repeat(50_000);
    const r = shapeResult({ content: [{ type: 'text', text: big }] }, 10_000, store, 't');
    expect(r.truncated).toBe(true);
    expect(r.text?.length).toBeLessThan(10_000);
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(10_000);
    const id = r.overflow?.id ?? '';
    expect(r.overflow?.chars).toBe(50_000);
    expect(store.read({ id, limit: 1_000_000 })).toMatchObject({ ok: true, value: { text: big, totalChars: 50_000, truncated: false } });
  });

  it('a structured result above the cap keeps its JSON for readOverflow', () => {
    const store = new OverflowStore();
    const structured = { rows: Array.from({ length: 2_000 }, (_, i) => ({ i, name: `item-${i}` })) };
    const r = shapeResult({ structuredContent: structured }, 5_000, store, 't');
    expect(r.structuredContent).toBeUndefined();
    const read = store.read({ id: r.overflow?.id ?? '', limit: 1_000_000 });
    expect(read.ok && 'totalChars' in read.value ? JSON.parse(read.value.text) : undefined).toEqual(structured);
  });

  it.each(['\n', '\u0000', '"', 'é', '😀'])('the cap holds for the serialized result of text made of %j', (ch) => {
    for (const overflow of [new OverflowStore(), undefined]) {
      const r = shapeResult({ content: [{ type: 'text', text: ch.repeat(60_000) }] }, 10_000, overflow, 't');
      expect(r.truncated).toBe(true);
      expect(JSON.stringify(r).length).toBeLessThanOrEqual(10_000);
      expect((r.text ?? '').length).toBeGreaterThan(1_000);
    }
  });

  it('above the cap without a store, cuts with an explicit warning', () => {
    const r = shapeResult({ content: [{ type: 'text', text: 'z'.repeat(50_000) }] }, 10_000, undefined, 't');
    expect(r).toMatchObject({ truncated: true, warning: expect.stringContaining('could not be kept') });
    expect(r.overflow).toBeUndefined();
  });
});

describe('McpBindingRuntime.commit', () => {
  it('maps a timeout to a tool-error that says the effect is unknown, and a cancel to cancelled', async () => {
    const up = new MemoryMcpUpstream({ srv: ['t'] }, async (_e, _i, opts) =>
      opts.signal.aborted ? { ok: false, failure: { kind: 'cancelled', message: 'cancelled' } } : { ok: false, failure: { kind: 'timeout', message: 'timed out; its effect is unknown' } },
    );
    const rt = memoryMcpRuntime(up, { defaultTimeoutMs: 123 });
    const parsed = rt.parse({ server: 'srv', tool: 't' }, 'c1');
    if (!parsed.ok) throw new Error(parsed.message);
    const prepared = rt.prepare(parsed.call);
    expect(prepared.effect).toMatchObject({ qualifiedName: 'mcp__srv__t', timeoutMs: 123 });
    await expect(rt.commit(prepared, new AbortController().signal)).rejects.toMatchObject({ code: 'tool-error', message: expect.stringContaining('effect is unknown') });
    const aborted = new AbortController();
    aborted.abort();
    await expect(rt.commit(prepared, aborted.signal)).rejects.toMatchObject({ code: 'cancelled' });
  });
});
