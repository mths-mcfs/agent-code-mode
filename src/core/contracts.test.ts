import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeHostAdapter } from '../hosts/claude/adapter.js';
import { makeContext } from '../testing/context.js';
import { StaticHostAdapter } from '../testing/static-host-adapter.js';
import { NodeToolRuntime } from '../tools/runtime.js';
import { Dispatcher } from './dispatcher.js';
import type { CallReply, GlobResult, GrepResult, PolicySnapshot, PreparedCall, SessionContext, ToolCall } from './types.js';

const posix = process.platform !== 'win32';

let base: string;

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'acm-contracts-')));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function value<T>(reply: CallReply): T {
  if (!reply.ok) throw new Error(`expected success, got ${JSON.stringify(reply.error)}`);
  // The test knows which tool it called.
  return reply.value as T;
}

function dispatcherFor(ctx: SessionContext, policy: PolicySnapshot<null>, adapter = new StaticHostAdapter()): Dispatcher<null> {
  return new Dispatcher<null>({ adapter, tools: new NodeToolRuntime({ stateDir: path.join(base, 'state') }), ctx, policy });
}

describe.runIf(posix)('dispatcher with a symlinked cwd', () => {
  it('reports changedFiles relative to the real cwd', async () => {
    const real = path.join(base, 'real');
    mkdirSync(real);
    const link = path.join(base, 'link');
    symlinkSync(real, link);
    const ctx = makeContext(link);
    const policy: PolicySnapshot<null> = { host: 'generic', bashContainment: { mode: 'none' }, protectedPaths: [], payload: null };
    const d = dispatcherFor(ctx, policy);
    value(await d.dispatch('write', { path: 'f', content: 'x' }));
    expect(d.changedFiles).toEqual(['f']);
    expect(d.calls[0]?.summary).toBe('write f');
  });

  it('refuses a write to a protected pattern spelled with the symlinked cwd', async () => {
    const real = path.join(base, 'real');
    mkdirSync(path.join(real, '.claude'), { recursive: true });
    const link = path.join(base, 'link');
    symlinkSync(real, link);
    const ctx = makeContext(link);
    const policy: PolicySnapshot<null> = {
      host: 'generic',
      bashContainment: { mode: 'none' },
      protectedPaths: [path.join(link, '.claude', 'settings*.json')],
      payload: null,
    };
    // The tool runtime's own check is bypassed so the dispatcher's check is what is tested.
    const tools = new NodeToolRuntime({ stateDir: path.join(base, 'state') });
    const passthrough = {
      prepare: (call: ToolCall, c: SessionContext, p: PolicySnapshot<null>) => tools.prepare(call, c, { ...p, protectedPaths: [] }),
      commit: tools.commit.bind(tools),
      beginTransaction: tools.beginTransaction.bind(tools),
    };
    const d = new Dispatcher<null>({ adapter: new StaticHostAdapter(), tools: passthrough, ctx, policy });
    const reply = await d.dispatch('write', { path: '.claude/settings.json', content: '{}' });
    expect(reply.ok).toBe(false);
    expect(reply.ok ? undefined : reply.error.code).toBe('protected-path');
    expect(() => readFileSync(path.join(real, '.claude', 'settings.json'))).toThrow();
  });
});

describe('PreparedCall.requestedPath', () => {
  it('is the path as the script wrote it, replacing whatever the runtime returned', async () => {
    const ws = path.join(base, 'ws');
    mkdirSync(path.join(ws, 'sub'), { recursive: true });
    writeFileSync(path.join(ws, 'sub', 'a.txt'), 'hello\n');
    const ctx = makeContext(ws);
    const policy: PolicySnapshot<null> = { host: 'generic', bashContainment: { mode: 'none' }, protectedPaths: [], payload: null };
    const tools = new NodeToolRuntime({ stateDir: path.join(base, 'state') });
    const lying = {
      prepare: async (call: ToolCall, c: SessionContext, p: PolicySnapshot<null>): Promise<PreparedCall> => ({ ...(await tools.prepare(call, c, p)), requestedPath: '/etc/elsewhere' }),
      commit: tools.commit.bind(tools),
      beginTransaction: tools.beginTransaction.bind(tools),
    };
    const adapter = new StaticHostAdapter();
    const d = new Dispatcher<null>({ adapter, tools: lying, ctx, policy });
    value(await d.dispatch('read', { path: './sub/../sub/a.txt' }));
    value(await d.dispatch('grep', { pattern: 'hello' }));
    value(await d.dispatch('glob', { pattern: '*', path: 'sub' }));
    expect(adapter.staticChecked.map((p) => p.requestedPath)).toEqual(['./sub/../sub/a.txt', undefined, 'sub']);
    expect(Object.isFrozen(adapter.staticChecked[0])).toBe(true);
  });
});

describe('PolicySnapshot.readFilter and additionalRoots', () => {
  function workspace(): { ws: string; ctx: SessionContext } {
    const ws = path.join(base, 'ws');
    mkdirSync(path.join(ws, 'src'), { recursive: true });
    writeFileSync(path.join(ws, 'src', 'a.ts'), 'const token = 1;\n');
    writeFileSync(path.join(ws, '.env'), 'token=secret\n');
    writeFileSync(path.join(ws, 'src', 'b.secret'), 'token=two\n');
    return { ws, ctx: makeContext(ws) };
  }

  it('drops filtered grep matches and glob entries and counts them', async () => {
    const { ws, ctx } = workspace();
    const policy: PolicySnapshot<null> = {
      host: 'generic',
      bashContainment: { mode: 'none' },
      protectedPaths: [],
      readFilter: (p) => path.basename(p) !== '.env' && !p.endsWith('.secret'),
      payload: null,
    };
    const d = dispatcherFor(ctx, policy);
    const grep = value<GrepResult>(await d.dispatch('grep', { pattern: 'token' }));
    expect(grep.matches.map((m) => path.relative(ws, m.file))).toEqual([path.join('src', 'a.ts')]);
    expect(grep.filtered).toBe(2);
    const glob = value<GlobResult>(await d.dispatch('glob', { pattern: '**/*' }));
    expect(glob.files.map((f) => path.relative(ws, f))).toEqual([path.join('src', 'a.ts')]);
    expect(glob.filtered).toBe(2);
  });

  it('reports filtered 0 without a filter', async () => {
    const { ctx } = workspace();
    const policy: PolicySnapshot<null> = { host: 'generic', bashContainment: { mode: 'none' }, protectedPaths: [], payload: null };
    const grep = value<GrepResult>(await dispatcherFor(ctx, policy).dispatch('grep', { pattern: 'token' }));
    expect(grep.matches).toHaveLength(3);
    expect(grep.filtered).toBe(0);
  });

  it('lets the tools reach the policy additional roots and nothing else', async () => {
    const { ctx } = workspace();
    const extra = path.join(base, 'extra');
    mkdirSync(extra);
    writeFileSync(path.join(extra, 'x.txt'), 'x\n');
    writeFileSync(path.join(base, 'outside.txt'), 'o\n');
    const without: PolicySnapshot<null> = { host: 'generic', bashContainment: { mode: 'none' }, protectedPaths: [], payload: null };
    const denied = await dispatcherFor(ctx, without).dispatch('read', { path: path.join(extra, 'x.txt') });
    expect(denied.ok ? undefined : denied.error.code).toBe('outside-workspace');
    const withRoot: PolicySnapshot<null> = { ...without, additionalRoots: [extra] };
    const d = dispatcherFor(ctx, withRoot);
    expect(value<{ content: string }>(await d.dispatch('read', { path: path.join(extra, 'x.txt') })).content).toBe('x');
    const stillOut = await d.dispatch('read', { path: path.join(base, 'outside.txt') });
    expect(stillOut.ok ? undefined : stillOut.error.code).toBe('outside-workspace');
  });
});

describe('names of files outside the session cwd', () => {
  it('diff headers and changedFiles name a file in an additional root as <root basename>/<path>', async () => {
    const ws = path.join(base, 'ws');
    const extra = path.join(base, 'extra');
    mkdirSync(ws);
    mkdirSync(path.join(extra, 'sub'), { recursive: true });
    writeFileSync(path.join(extra, 'sub', 'x'), 'old\n');
    const policy: PolicySnapshot<null> = { host: 'generic', bashContainment: { mode: 'none' }, protectedPaths: [], additionalRoots: [extra], payload: null };
    const d = dispatcherFor(makeContext(ws), policy);
    const w = value<{ diff: string }>(await d.dispatch('write', { path: path.join(extra, 'sub', 'x'), content: 'new\n' }));
    value(await d.dispatch('write', { path: 'f', content: 'x\n' }));
    expect(w.diff.split('\n').slice(0, 2)).toEqual(['--- a/extra/sub/x', '+++ b/extra/sub/x']);
    expect(d.diff).not.toMatch(/^\+\+\+ b\/\//m);
    expect(d.diff).toMatch(/^\+\+\+ b\/f$/m);
    expect(d.changedFiles).toEqual(['extra/sub/x', 'f']);
  });
});

describe('Claude policy wiring', () => {
  async function claude(settings: Record<string, unknown>, files: Record<string, string> = {}) {
    const home = path.join(base, 'home');
    const project = path.join(base, 'project');
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    mkdirSync(path.join(project, '.claude'), { recursive: true });
    writeFileSync(path.join(project, '.claude', 'settings.json'), JSON.stringify(settings));
    writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { [project]: { hasTrustDialogAccepted: true } } }));
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
      writeFileSync(path.join(project, rel), content);
    }
    const adapter = new ClaudeHostAdapter({ env: {}, home, managedDir: null, stateDir: path.join(base, 'state'), readParent: async () => undefined });
    const ctx = makeContext(project, { host: 'claude', sessionId: 's', permissionMode: 'bypassPermissions', sources: { cwd: 'roots', permissionMode: 'ctx-file' } });
    const policy = await adapter.loadPolicy(ctx);
    if ('error' in policy) throw new Error(policy.error);
    const d = new Dispatcher({ adapter, tools: new NodeToolRuntime({ stateDir: path.join(base, 'state') }), ctx, policy });
    return { d, policy, project };
  }

  it('exposes Read deny and ask rules as the read filter, so grep skips those files', async () => {
    const { d, policy, project } = await claude(
      { permissions: { deny: ['Read(./.env)'], ask: ['Read(./private/**)'] } },
      { '.env': 'key=1\n', 'private/p.txt': 'key=2\n', 'src/ok.txt': 'key=3\n' },
    );
    expect(policy.readFilter?.(path.join(project, '.env'))).toBe(false);
    expect(policy.readFilter?.(path.join(project, 'private', 'p.txt'))).toBe(false);
    expect(policy.readFilter?.(path.join(project, 'src', 'ok.txt'))).toBe(true);
    const grep = value<GrepResult>(await d.dispatch('grep', { pattern: 'key' }));
    expect(grep.matches.map((m) => path.relative(project, m.file))).toEqual([path.join('src', 'ok.txt')]);
    expect(grep.filtered).toBe(2);
  });

  it('puts additionalDirectories in the snapshot', async () => {
    const extra = path.join(base, 'extra');
    mkdirSync(extra);
    const { policy } = await claude({ permissions: { additionalDirectories: [extra] } });
    expect(policy.additionalRoots).toEqual([extra]);
  });

  it.runIf(posix)('matches deny rules against the path as written, not only the real path', async () => {
    const { d, project } = await claude({ permissions: { deny: ['Read(./secrets/**)'] } }, { 'data/key.txt': 'k\n' });
    symlinkSync(path.join(project, 'data'), path.join(project, 'secrets'));
    const viaLink = await d.dispatch('read', { path: 'secrets/key.txt' });
    expect(viaLink.ok).toBe(false);
    expect(viaLink.ok ? undefined : viaLink.error.code).toBe('denied');
    value(await d.dispatch('read', { path: 'data/key.txt' }));
  });
});
