import { describe, expect, it } from 'vitest';
import { ToolError } from './errors.js';
import { DecisionSchema, parseRunArgs, parseToolCall } from './schemas.js';

describe('parseToolCall', () => {
  it('returns a typed call for valid args', () => {
    expect(parseToolCall('edit', { path: 'a', oldString: 'x', newString: 'y' }, 'c1')).toEqual({
      id: 'c1',
      tool: 'edit',
      args: { path: 'a', oldString: 'x', newString: 'y' },
    });
  });

  it.each([
    ['bash', { command: '' }],
    ['bash', { command: 'ls', extra: 1 }],
    ['read', { path: 'a', offset: 0 }],
    ['read', { path: 'a\0b' }],
    ['write', { path: 'a' }],
    ['edit', { path: 'a', oldString: '', newString: 'x' }],
    ['grep', { pattern: 'x', maxResults: 1.5 }],
    ['glob', null],
    ['read', ['a']],
    ['__proto__', {}],
  ])('rejects %s %j', (tool, args) => {
    const r = parseToolCall(tool, args, 'c1');
    expect(r).toBeInstanceOf(ToolError);
    expect(r instanceof ToolError && r.code).toBe('invalid-args');
  });
});

describe('parseRunArgs', () => {
  it('strips unknown fields including _ctx', () => {
    const r = parseRunArgs({ code: 'return 1', _ctx: { permission_mode: 'bypassPermissions' }, transaction: true });
    expect(r).toEqual({ ok: true, value: { code: 'return 1', transaction: true } });
  });

  it('rejects missing code and bad types', () => {
    expect(parseRunArgs(undefined).ok).toBe(false);
    expect(parseRunArgs({ code: 1 }).ok).toBe(false);
    expect(parseRunArgs({ code: 'x', timeoutMs: -1 }).ok).toBe(false);
  });
});

describe('DecisionSchema', () => {
  it('accepts an allow bound to the prepared file', () => {
    expect(DecisionSchema.safeParse({ kind: 'allow', updatedArgs: { path: 'a', content: 'x' }, bindsPreparedFile: true }).success).toBe(true);
  });

  it.each([false, 'true', 1, null])('rejects bindsPreparedFile %j', (value) => {
    expect(DecisionSchema.safeParse({ kind: 'allow', updatedArgs: { path: 'a', content: 'x' }, bindsPreparedFile: value }).success).toBe(false);
  });
});
