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

  it('two servers with the same schema $id each validate against their own schema', () => {
    const tool = (required: string) => ({ name: 'check', inputSchema: { type: 'object' }, outputSchema: { $id: 'shared', type: 'object', required: [required] } });
    const catalog = buildCatalog([{ server: 'first', tools: [tool('first')], truncated: false }, { server: 'second', tools: [tool('second')], truncated: false }], []);
    const second = catalog.lookup('second', 'check')?.checkOutput;
    expect(second?.({ second: true })).toBeUndefined();
    expect(second?.({ first: true })).toMatch(/second/);
    expect(catalog.lookup('first', 'check')?.checkOutput?.({ first: true })).toBeUndefined();
  });

  it('an outputSchema with a `__proto__` key leaves the tool out', () => {
    const problems: string[] = [];
    const raw: unknown = JSON.parse('{"name":"t","inputSchema":{"type":"object"},"outputSchema":{"type":"object","properties":{"__proto__":{"type":"string"}}}}');
    const catalog = buildCatalog([{ server: 'srv', tools: [raw, { name: 'ok', inputSchema: { type: 'object' } }], truncated: false }], problems);
    expect(catalog.tools.map((t) => t.tool)).toEqual(['ok']);
    expect(problems.join()).toContain('__proto__');
  });

  it('a recursive outputSchema makes a call invalid, never throws', () => {
    const catalog = buildCatalog([{ server: 'srv', tools: [{ name: 'loop', inputSchema: { type: 'object' }, outputSchema: { $id: 'loop', type: 'object', allOf: [{ $ref: 'loop' }] } }], truncated: false }], []);
    const check = catalog.lookup('srv', 'loop')?.checkOutput;
    expect(() => check?.({ a: 1 })).not.toThrow();
    expect(check?.({ a: 1 })).toMatch(/could not be checked/);
  });

  it('an invalid entry still counts for duplicates', () => {
    const problems: string[] = [];
    const catalog = buildCatalog([{ server: 'srv', tools: [{ name: 'valid', inputSchema: { type: 'object' } }, { name: 'valid', description: 12 }], truncated: false }], problems);
    expect(catalog.lookup('srv', 'valid')).toBeUndefined();
    expect(problems.join()).toContain('names more than one tool');
  });

  it('reports a server whose list was cut', () => {
    const problems: string[] = [];
    buildCatalog([{ server: 'srv', tools: [tool('ok')], truncated: true }], problems);
    expect(problems[0]).toContain('the rest are left out');
  });
});
