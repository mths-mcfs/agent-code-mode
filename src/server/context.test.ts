import { describe, expect, it } from 'vitest';
import { GenericContextProvider, detectHost } from './context.js';

describe('context providers', () => {
  it('Generic: ignores relative roots', async () => {
    const ctx = await new GenericContextProvider().resolve({ env: {}, meta: undefined, roots: ['relative', '/ws'], serverCwd: '/srv' });
    expect(ctx.cwd).toBe('/ws');
  });

  it('detectHost: flag, then Claude env, then Codex meta, then generic', () => {
    expect(detectHost({ flag: 'codex', env: { CLAUDE_CODE_SESSION_ID: 'x' }, meta: {} })).toBe('codex');
    expect(detectHost({ env: { CLAUDE_CODE_SESSION_ID: 'x' }, meta: {} })).toBe('claude');
    expect(detectHost({ env: {}, meta: { 'x-codex-turn-metadata': {} } })).toBe('codex');
    expect(detectHost({ env: {}, meta: { 'x-codex-turn-metadata': 'str' } })).toBe('generic');
    expect(detectHost({ env: {}, meta: null })).toBe('generic');
  });
});
