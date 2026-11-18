import { describe, expect, it } from 'vitest';
import { mcpNameProblem } from './names.js';
import { buildCatalog } from './upstream.js';

describe('mcpNameProblem', () => {
  it.each(['inventory', 'get_item', 'a', 'A-1', 'x9', 'snake_case-and-dash', 'a'.repeat(64)])('%j is a valid name', (name) => {
    expect(mcpNameProblem(name)).toBeUndefined();
  });
  it.each([
    ['', 'empty'],
    ['a'.repeat(65), 'longer than 64'],
    ['bad name', 'letters, digits'],
    ['dot.name', 'letters, digits'],
    ['é', 'letters, digits'],
    ['a/b', 'letters, digits'],
    ['a__b', '`__`'],
    ['_lead', 'starts or ends'],
    ['trail_', 'starts or ends'],
    ['-lead', 'starts or ends'],
    ['trail-', 'starts or ends'],
    ['__proto__', 'reserved'],
    ['constructor', 'reserved'],
    ['prototype', 'reserved'],
    ['mcp\n', 'letters, digits'],
  ])('%j is refused (%s)', (name, why) => {
    expect(mcpNameProblem(name)).toContain(why);
  });
});

describe('buildCatalog', () => {
  const tool = (name: unknown, extra: Record<string, unknown> = {}) => ({ name, inputSchema: { type: 'object' }, ...extra });

  it('keeps valid tools under their qualified name and reports the rest', () => {
    const problems: string[] = [];
    const catalog = buildCatalog(
      [{ server: 'srv', tools: [tool('ok'), tool('bad name'), tool('dup'), tool('dup'), tool('a__b'), { nope: true }], truncated: false }],
      problems,
    );
    expect(catalog.tools.map((t) => t.qualifiedName)).toEqual(['mcp__srv__ok']);
    expect(catalog.lookup('srv', 'ok')?.tool).toBe('ok');
    expect(catalog.lookup('srv', 'dup')).toBeUndefined();
    expect(catalog.lookup('srv', 'bad name')).toBeUndefined();
    expect(problems).toHaveLength(4);
    expect(problems.join('\n')).toContain('mcp__srv__dup names more than one tool');
  });

  it('lookup does not reach object prototype keys', () => {
    const catalog = buildCatalog([{ server: 'srv', tools: [tool('ok')], truncated: false }], []);
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(catalog.lookup('srv', name)).toBeUndefined();
      expect(catalog.lookup(name, 'ok')).toBeUndefined();
    }
  });

  it('a description is one bounded line; the input schema becomes a compact shape', () => {
    const catalog = buildCatalog(
      [
        {
          server: 'srv',
          tools: [
            tool('t', {
              description: `line one\nline two\u2028${'x'.repeat(1_000)}`,
              inputSchema: { type: 'object', properties: { sku: { type: 'string' }, qty: { type: 'integer' }, mode: { enum: ['a', 'b'] } }, required: ['sku'] },
            }),
          ],
          truncated: false,
        },
      ],
      [],
    );
    const entry = catalog.tools[0];
    expect(entry?.description).not.toMatch(/[\n\u2028]/);
    expect(entry?.description.length).toBeLessThanOrEqual(300);
    expect(entry?.inputShape).toBe('{sku: string; qty?: number; mode?: "a" | "b"}');
  });

  it('a gigantic or hostile schema stays bounded', () => {
    const deep: Record<string, unknown> = { type: 'object', properties: {} };
    let cur = deep;
    for (let i = 0; i < 1_000; i++) {
      const next: Record<string, unknown> = { type: 'object', properties: {} };
      cur['properties'] = { [`k${i}`]: next, ...Object.fromEntries(Array.from({ length: 50 }, (_, j) => [`p${j}`, { type: 'string' }])) };
      cur = next;
    }
    const catalog = buildCatalog([{ server: 'srv', tools: [tool('t', { inputSchema: deep })], truncated: false }], []);
    expect(catalog.tools[0]?.inputShape.length).toBeLessThanOrEqual(400);
  });

  it('reports a server whose list was cut', () => {
    const problems: string[] = [];
    buildCatalog([{ server: 'srv', tools: [tool('ok')], truncated: true }], problems);
    expect(problems[0]).toContain('the rest are left out');
  });
});
