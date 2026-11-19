import { mkdir, mkdtemp, readdir, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONTEXT_TTL_MS, runContextHook } from './context-hook.js';
import { FileHookContextStore, createClaudeContextProvider } from './context.js';

const posix = process.platform !== 'win32';

async function stateDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'acm-ctx-'));
}

function hookInput(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: 'sess-1',
    transcript_path: '/home/u/.claude/projects/p/sess-1.jsonl',
    cwd: '/ws/proj',
    permission_mode: 'acceptEdits',
    hook_event_name: 'PreToolUse',
    tool_name: 'mcp__agent-code-mode__run',
    tool_input: { code: 'return 1' },
    tool_use_id: 'toolu_01ABC',
    ...overrides,
  });
}

describe('companion hook and context store', () => {
  it('writes one record per tool use that is read once, then deleted', async () => {
    const dir = await stateDir();
    expect(await runContextHook(hookInput({ agent_id: 'agent-7', agent_type: 'Explore' }), { stateDir: dir })).toBe(0);
    const store = new FileHookContextStore(dir);
    expect(await store.lookup('toolu_01ABC')).toEqual({
      sessionId: 'sess-1',
      toolUseId: 'toolu_01ABC',
      cwd: '/ws/proj',
      transcriptPath: '/home/u/.claude/projects/p/sess-1.jsonl',
      permissionMode: 'acceptEdits',
      agentId: 'agent-7',
      agentType: 'Explore',
    });
    expect(await store.lookup('toolu_01ABC')).toBeUndefined();
    expect(await readdir(path.join(dir, 'ctx'))).toEqual([]);
  });

  it.skipIf(!posix)('writes and reads the record when the platform reports win32', async () => {
    const dir = await stateDir();
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      expect(await runContextHook(hookInput(), { stateDir: dir })).toBe(0);
      expect(await new FileHookContextStore(dir).lookup('toolu_01ABC')).toMatchObject({ sessionId: 'sess-1', toolUseId: 'toolu_01ABC' });
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
  });

  it.skipIf(!posix)('creates the directory 0700 and the file 0600', async () => {
    const dir = await stateDir();
    await runContextHook(hookInput(), { stateDir: dir });
    expect((await stat(path.join(dir, 'ctx'))).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(dir, 'ctx', 'toolu_01ABC.json'))).mode & 0o777).toBe(0o600);
  });

  it('rejects tool-use ids that are not safe file names', async () => {
    const dir = await stateDir();
    await mkdir(path.join(dir, 'ctx'), { recursive: true });
    await writeFile(path.join(dir, 'x.json'), JSON.stringify({ tool_use_id: 'x', session_id: 's' }));
    const store = new FileHookContextStore(dir);
    expect(await store.lookup('../x')).toBeUndefined();
    expect(await store.lookup('a/b')).toBeUndefined();
    expect(await store.lookup('')).toBeUndefined();
    expect(await runContextHook(hookInput({ tool_use_id: '../evil' }), { stateDir: dir })).toBe(0);
    expect(await readdir(path.join(dir, 'ctx'))).toEqual([]);
  });

  it('never fails the hook on bad input and prints nothing', async () => {
    const dir = await stateDir();
    expect(await runContextHook('not json', { stateDir: dir })).toBe(0);
    expect(await runContextHook(JSON.stringify({ tool_use_id: 'toolu_x' }), { stateDir: dir })).toBe(0);
    expect(await runContextHook(hookInput(), { stateDir: path.join(dir, 'file-not-dir', 'x') })).toBe(0);
  });

  it('prunes records older than one hour', async () => {
    const dir = await stateDir();
    await runContextHook(hookInput({ tool_use_id: 'toolu_old' }), { stateDir: dir });
    const old = (Date.now() - CONTEXT_TTL_MS - 60_000) / 1000;
    await utimes(path.join(dir, 'ctx', 'toolu_old.json'), old, old);
    await runContextHook(hookInput({ tool_use_id: 'toolu_new' }), { stateDir: dir });
    expect(await readdir(path.join(dir, 'ctx'))).toEqual(['toolu_new.json']);
  });

  it.skipIf(!posix)('does not follow a symlink planted under the record name', async () => {
    const dir = await stateDir();
    await mkdir(path.join(dir, 'ctx'), { recursive: true });
    const target = path.join(dir, 'elsewhere.json');
    await writeFile(target, JSON.stringify({ tool_use_id: 'toolu_link', session_id: 's' }));
    await symlink(target, path.join(dir, 'ctx', 'toolu_link.json'));
    expect(await new FileHookContextStore(dir).lookup('toolu_link')).toBeUndefined();
  });

  it('refuses a record whose tool-use id differs from its file name', async () => {
    const dir = await stateDir();
    await mkdir(path.join(dir, 'ctx'), { recursive: true });
    await writeFile(path.join(dir, 'ctx', 'toolu_a.json'), JSON.stringify({ tool_use_id: 'toolu_b', session_id: 's' }));
    expect(await new FileHookContextStore(dir).lookup('toolu_a')).toBeUndefined();
  });
});

describe('Claude context provider', () => {
  it('joins the record by _meta toolUseId and never reads model-supplied _ctx', async () => {
    const dir = await stateDir();
    await runContextHook(hookInput(), { stateDir: dir });
    const provider = createClaudeContextProvider({ stateDir: dir });
    const ctx = await provider.resolve({
      env: { CLAUDE_CODE_SESSION_ID: 'sess-1' },
      meta: { 'claudecode/toolUseId': 'toolu_01ABC', progressToken: 1, _ctx: { permission_mode: 'bypassPermissions' } },
      roots: ['/ws/proj'],
      serverCwd: '/',
    });
    expect(ctx).toMatchObject({
      host: 'claude',
      cwd: '/ws/proj',
      sessionId: 'sess-1',
      toolUseId: 'toolu_01ABC',
      permissionMode: 'acceptEdits',
      transcriptPath: '/home/u/.claude/projects/p/sess-1.jsonl',
    });
    expect(ctx.sources['permissionMode']).toBe('ctx-file');
    // The record was consumed: a replay of the same id falls back to the default mode.
    const again = await provider.resolve({ env: { CLAUDE_CODE_SESSION_ID: 'sess-1' }, meta: { 'claudecode/toolUseId': 'toolu_01ABC' }, roots: ['/ws/proj'], serverCwd: '/' });
    expect(again.permissionMode).toBe('default');
    expect(again.sources['permissionMode']).toBe('default');
  });

  it('ignores a record from another session and a traversal tool-use id', async () => {
    const dir = await stateDir();
    await runContextHook(hookInput({ session_id: 'other' }), { stateDir: dir });
    const provider = createClaudeContextProvider({ stateDir: dir });
    const ctx = await provider.resolve({ env: { CLAUDE_CODE_SESSION_ID: 'sess-1' }, meta: { 'claudecode/toolUseId': 'toolu_01ABC' }, roots: ['/ws/proj'], serverCwd: '/' });
    expect(ctx.permissionMode).toBe('default');
    const traversal = await provider.resolve({ env: {}, meta: { 'claudecode/toolUseId': '../ctx/toolu_01ABC' }, roots: [], serverCwd: '/srv' });
    expect(traversal).toMatchObject({ permissionMode: 'default', cwd: '/srv' });
  });
});
