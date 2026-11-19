import { describe, expect, it } from 'vitest';
import { RUN_DESCRIPTION, runDescription } from '../server/mcp.js';
import { MemoryMcpUpstream } from '../testing/index.js';
import { MCP_CALL_DECLARATION, MCP_HYBRID_GUIDANCE, describeCatalog } from './describe.js';
import { buildCatalog } from './upstream.js';

describe('describeCatalog', () => {
  it('lists each tool with its shape and description, then what was left out', () => {
    const problems = ['tool "bad name" of MCP server "srv" left out: the name may only contain letters, digits, `_` and `-`'];
    const catalog = buildCatalog(
      [{ server: 'srv', tools: [{ name: 'get_item', description: 'One item.', inputSchema: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'] } }], truncated: false }],
      problems,
    );
    const text = describeCatalog(catalog);
    expect(text).toContain(MCP_CALL_DECLARATION);
    expect(text).toContain('- srv.get_item({sku: string}): One item.');
    expect(text).toContain('Left out at start:');
    expect(text).toContain('"bad name"');
  });

  it('stops at the size cap and says how many tools it did not list', () => {
    const catalog = buildCatalog([{ server: 'srv', tools: Array.from({ length: 300 }, (_, i) => ({ name: `tool${i}`, description: 'd'.repeat(200), inputSchema: { type: 'object' } })), truncated: false }], []);
    const text = describeCatalog(catalog, 4_000);
    expect(text.length).toBeLessThanOrEqual(4_200);
    expect(text).toMatch(/…\[\d+ more tools not listed here/);
  });
});

describe('describeCatalog cap', () => {
  it('holds for the whole text, the start-up problems and the "more tools" note included', () => {
    const problems = Array.from({ length: 9 }, (_, i) => `MCP server "s${i}" left out: ${'reason '.repeat(60)}`);
    const catalog = buildCatalog([{ server: 'srv', tools: Array.from({ length: 80 }, (_, i) => ({ name: `tool${i}`, description: 'd'.repeat(210), inputSchema: { type: 'object' } })), truncated: false }], problems);
    for (const cap of [8_000, 3_000, 900]) {
      const text = describeCatalog(catalog, cap);
      expect(text.length).toBeLessThanOrEqual(cap);
    }
    expect(describeCatalog(catalog)).toContain('Left out at start:');
    expect(describeCatalog(catalog)).toMatch(/more tools not listed here/);
  });
});

describe('runDescription', () => {
  const mcp = new MemoryMcpUpstream({ srv: ['t'] });
  it('is the base description without upstream servers', () => {
    expect(runDescription({})).toBe(RUN_DESCRIPTION);
  });
  it('adds the catalog, and with --hybrid the line about chaining calls in one script', () => {
    expect(runDescription({ mcp })).toContain('- srv.t(');
    expect(runDescription({ mcp })).not.toContain(MCP_HYBRID_GUIDANCE);
    expect(runDescription({ mcp, hybrid: true })).toContain(MCP_HYBRID_GUIDANCE);
    expect(runDescription({ hybrid: true })).not.toContain(MCP_HYBRID_GUIDANCE);
  });
});
