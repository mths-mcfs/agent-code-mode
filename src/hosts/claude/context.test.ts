import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { CONTEXT_TTL_MS, runContextHook } from './context-hook.js';
import type { HookContextRecord, HookContextStore } from '../../core/types.js';
import { ClaudeContextProvider, FileHookContextStore, createClaudeContextProvider, routineContextChange } from './context.js';

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
  it.skipIf(!posix)('writes one record per tool use that is read once, then deleted', async () => {
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

  it.skipIf(posix)('does not write a companion record on Windows', async () => {
    const dir = await stateDir();
    expect(await runContextHook(hookInput(), { stateDir: dir })).toBe(0);
    expect(await readdir(dir)).toEqual([]);
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

  it.skipIf(!posix)('prunes records older than one hour', async () => {
    const dir = await stateDir();
    await runContextHook(hookInput({ tool_use_id: 'toolu_old' }), { stateDir: dir });
    const old = (Date.now() - CONTEXT_TTL_MS - 60_000) / 1000;
    await utimes(path.join(dir, 'ctx', 'toolu_old.json'), old, old);
    await runContextHook(hookInput({ tool_use_id: 'toolu_new' }), { stateDir: dir });
    expect(await readdir(path.join(dir, 'ctx'))).toEqual(['toolu_new.json']);
  });

  async function privateStore(): Promise<{ dir: string; store: FileHookContextStore }> {
    const dir = await stateDir();
    await runContextHook(hookInput({ tool_use_id: 'toolu_base' }), { stateDir: dir });
    const store = new FileHookContextStore(dir);
    expect(await store.lookup('toolu_base')).toMatchObject({ toolUseId: 'toolu_base' });
    return { dir, store };
  }

  it.skipIf(!posix)('does not follow a symlink planted under the record name', async () => {
    const { dir, store } = await privateStore();
    const target = path.join(dir, 'elsewhere.json');
    await writeFile(target, JSON.stringify({ tool_use_id: 'toolu_link', session_id: 's' }), { mode: 0o600 });
    await symlink(target, path.join(dir, 'ctx', 'toolu_link.json'));
    expect(await store.lookup('toolu_link')).toBeUndefined();
  });

  it.skipIf(!posix)('refuses a record whose tool-use id differs from its file name', async () => {
    const { dir, store } = await privateStore();
    await writeFile(path.join(dir, 'ctx', 'toolu_a.json'), JSON.stringify({ tool_use_id: 'toolu_b', session_id: 's' }), { mode: 0o600 });
    expect(await store.lookup('toolu_a')).toBeUndefined();
  });

  it.skipIf(!posix)('writes nothing through a context directory entry that is a link', async () => {
    const dir = await stateDir();
    const elsewhere = await stateDir();
    await chmod(elsewhere, 0o755);
    await symlink(elsewhere, path.join(dir, 'ctx'));
    expect(await runContextHook(hookInput(), { stateDir: dir })).toBe(0);
    expect(await readdir(elsewhere)).toEqual([]);
    expect((await stat(elsewhere)).mode & 0o777).toBe(0o755);
  });
});

describe('Claude context provider', () => {
  it.skipIf(!posix)('joins the record by _meta toolUseId and never reads model-supplied _ctx', async () => {
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

describe.skipIf(!posix)('context record provenance', () => {
  it('trusts no record in a context directory or file others can write', async () => {
    const dir = await stateDir();
    await runContextHook(hookInput(), { stateDir: dir });
    await chmod(path.join(dir, 'ctx', 'toolu_01ABC.json'), 0o666);
    expect(await new FileHookContextStore(dir).lookup('toolu_01ABC')).toBeUndefined();
    await runContextHook(hookInput(), { stateDir: dir });
    await chmod(path.join(dir, 'ctx'), 0o755);
    expect(await new FileHookContextStore(dir).lookup('toolu_01ABC')).toBeUndefined();
  });
});

const store = (record: HookContextRecord | undefined): HookContextStore => ({ lookup: async () => record });

describe('ClaudeContextProvider', () => {
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

    const nested = await new ClaudeContextProvider(store({ ...record, cwd: '/ws/..samples' })).resolve(input);
    expect(nested.cwd).toBe('/ws/..samples');

    const otherSession = await new ClaudeContextProvider(store({ ...record, sessionId: 's2' })).resolve(input);
    expect(otherSession.permissionMode).toBe('default');
    const otherCall = await new ClaudeContextProvider(store({ ...record, toolUseId: 't2' })).resolve(input);
    expect(otherCall.permissionMode).toBe('default');
    const outsideRoots = await new ClaudeContextProvider(store({ ...record, cwd: '/elsewhere' })).resolve(input);
    expect(outsideRoots.cwd).toBe('/ws');
    const throwing = await new ClaudeContextProvider({ lookup: () => Promise.reject(new Error('io')) }).resolve(input);
    expect(throwing.permissionMode).toBe('default');
  });
});

describe.runIf(posix)('routineContextChange', () => {
  it('passes what the hook and the server do routinely and reports the rest', async () => {
    const base = await stateDir();
    onTestFinished(() => rm(base, { recursive: true, force: true }));
    const dir = path.join(base, 'ctx');
    await mkdir(dir, { mode: 0o700 });
    const routine = routineContextChange(dir);
    const file = { type: 'file' as const, mode: 0o100600 };
    const at = (name: string): string => path.join(dir, name);
    await writeFile(at('toolu_1.json'), JSON.stringify({ tool_use_id: 'toolu_1', session_id: 's' }));
    await writeFile(at('toolu_2.json'), JSON.stringify({ tool_use_id: 'toolu_other', session_id: 's' }));
    await writeFile(at('toolu_3.json'), 'not json');
    const cases: [string, Parameters<typeof routine>[0], boolean][] = [
      ['the directory created private', { path: dir, after: { type: 'dir', mode: 0o40700 } }, true],
      ['the directory opened up', { path: dir, after: { type: 'dir', mode: 0o40755 } }, false],
      ['a new well-formed record', { path: at('toolu_1.json'), after: file }, true],
      ['a new record naming another id', { path: at('toolu_2.json'), after: file }, false],
      ['a new malformed record', { path: at('toolu_3.json'), after: file }, false],
      ['a new record others can read', { path: at('toolu_1.json'), after: { type: 'file', mode: 0o100644 } }, false],
      ['a record rewritten', { path: at('toolu_1.json'), before: file, after: file }, false],
      ['a record consumed', { path: at('toolu_1.json'), before: file }, true],
      ['a hook temp file', { path: at('.toolu_1.0123456789ab.tmp'), after: file }, true],
      ['a server claim', { path: at('.toolu_1.0123456789ab.claimed'), after: file }, true],
      ['another file', { path: at('notes.txt'), after: file }, false],
      ['a nested file', { path: path.join(dir, 'sub', 'toolu_1.json'), after: file }, false],
    ];
    for (const [label, change, expected] of cases) expect(await routine(change), label).toBe(expected);
  });
});
