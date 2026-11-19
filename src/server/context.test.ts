import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HookContextRecord, HookContextStore } from '../core/types.js';
import { ClaudeContextProvider } from '../hosts/claude/context.js';
import { CodexContextProvider } from '../hosts/codex/context.js';
import { GenericContextProvider, detectHost } from './context.js';

const store = (record: HookContextRecord | undefined): HookContextStore => ({ lookup: async () => record });

describe('context providers', () => {
  it('Claude: falls back to conservative defaults', async () => {
    const ctx = await new ClaudeContextProvider().resolve({ env: {}, meta: 'garbage', roots: [], serverCwd: '/srv' });
    expect(ctx).toMatchObject({ host: 'claude', cwd: '/srv', permissionMode: 'default', sources: { cwd: 'default', permissionMode: 'default' } });
    expect(ctx.sessionId).toBeUndefined();
  });

  it('Claude: ignores invalid meta values', async () => {
    const ctx = await new ClaudeContextProvider().resolve({ env: {}, meta: { 'claudecode/toolUseId': 123 }, roots: ['/ws'], serverCwd: '/srv' });
    expect(ctx.toolUseId).toBeUndefined();
    expect(ctx.cwd).toBe('/ws');
  });

  it('Claude: uses a companion-hook record only for the same call and session', async () => {
    const record: HookContextRecord = { sessionId: 's1', toolUseId: 't1', permissionMode: 'acceptEdits', agentId: 'a1', agentType: 'helper', cwd: '/ws/sub' };
    const input = { env: { CLAUDE_CODE_SESSION_ID: 's1' }, meta: { 'claudecode/toolUseId': 't1' }, roots: ['/ws'], serverCwd: '/srv' };
    const good = await new ClaudeContextProvider(store(record)).resolve(input);
    expect(good).toMatchObject({ permissionMode: 'acceptEdits', agentId: 'a1', cwd: '/ws/sub', sources: { permissionMode: 'ctx-file' } });

    const otherSession = await new ClaudeContextProvider(store({ ...record, sessionId: 's2' })).resolve(input);
    expect(otherSession.permissionMode).toBe('default');
    const otherCall = await new ClaudeContextProvider(store({ ...record, toolUseId: 't2' })).resolve(input);
    expect(otherCall.permissionMode).toBe('default');
    const outsideRoots = await new ClaudeContextProvider(store({ ...record, cwd: '/elsewhere' })).resolve(input);
    expect(outsideRoots.cwd).toBe('/ws');
    const throwing = await new ClaudeContextProvider({ lookup: () => Promise.reject(new Error('io')) }).resolve(input);
    expect(throwing.permissionMode).toBe('default');
  });

  it('Codex: reads turn metadata and drops malformed fields', async () => {
    const ctx = await new CodexContextProvider().resolve({
      env: {},
      meta: { sessionId: 's', 'x-codex-turn-metadata': { turn_id: 't', model: 7, sandbox_mode: 'workspace-write' } },
      roots: [],
      serverCwd: '/srv',
    });
    expect(ctx).toMatchObject({ host: 'codex', sessionId: 's', turnId: 't', sandboxMode: 'workspace-write', cwd: path.resolve('/srv') });
    expect(ctx.model).toBeUndefined();
  });

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
