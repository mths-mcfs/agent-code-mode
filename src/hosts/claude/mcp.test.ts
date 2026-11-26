import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { PolicySnapshot, PreparedMcpCall } from '../../core/types.js';
import { makeContext } from '../../testing/index.js';
import { ClaudeHostAdapter, type ClaudePolicy } from './adapter.js';
import { expandVars } from './mcp.js';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'example-hook.mjs');
const bases: string[] = [];
afterAll(async () => {
  await Promise.all(bases.map((b) => rm(b, { recursive: true, force: true })));
});

const server = (command = 'node', extra: Record<string, unknown> = {}): Record<string, unknown> => ({ command, args: ['srv.js'], ...extra });

interface Options {
  readonly argv?: readonly string[];
  readonly project?: Record<string, unknown>;
  readonly local?: Record<string, unknown>;
  readonly user?: Record<string, unknown>;
  readonly mcpJson?: Record<string, unknown>;
  readonly projectEntry?: Record<string, unknown>;
  readonly userServers?: Record<string, unknown>;
  readonly trusted?: boolean;
  readonly mode?: string;
  readonly env?: Record<string, string>;
  readonly managed?: Record<string, string>;
  readonly noParent?: true;
}

async function load(o: Options = {}): Promise<{ adapter: ClaudeHostAdapter; policy: PolicySnapshot<ClaudePolicy>; project: string; ctx: ReturnType<typeof makeContext> }> {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'acm-claude-mcp-')));
  bases.push(base);
  const home = path.join(base, 'home');
  const project = path.join(base, 'project');
  const managed = path.join(base, 'managed');
  await mkdir(path.join(home, '.claude'), { recursive: true });
  await mkdir(path.join(project, '.claude'), { recursive: true });
  await mkdir(managed, { recursive: true });
  if (o.project) await writeFile(path.join(project, '.claude', 'settings.json'), JSON.stringify(o.project));
  if (o.local) await writeFile(path.join(project, '.claude', 'settings.local.json'), JSON.stringify(o.local));
  if (o.user) await writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify(o.user));
  if (o.mcpJson) await writeFile(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: o.mcpJson }));
  for (const [name, text] of Object.entries(o.managed ?? {})) await writeFile(path.join(managed, name), text);
  const entry = { ...(o.trusted === false ? {} : { hasTrustDialogAccepted: true }), ...o.projectEntry };
  await writeFile(path.join(home, '.claude.json'), JSON.stringify({ projects: { [project]: entry }, ...(o.userServers ? { mcpServers: o.userServers } : {}) }));
  const adapter = new ClaudeHostAdapter({
    env: o.env ?? { PATH: '/usr/bin' },
    home,
    managedDir: managed,
    stateDir: path.join(base, 'state'),
    readParent: async () => (o.noParent ? undefined : { argv: ['claude', ...(o.argv ?? [])], cwd: project }),
  });
  const ctx = makeContext(project, {
    host: 'claude',
    sessionId: 's1',
    toolUseId: 'toolu_1',
    permissionMode: o.mode ?? 'default',
    // A live mode from the companion record: without one, Windows refuses every call (mode unknown).
    sources: { cwd: 'roots', permissionMode: 'ctx-file' },
  });
  const policy = await adapter.loadPolicy(ctx);
  if ('error' in policy) throw new Error(policy.error);
  return { adapter, policy, project, ctx };
}

const names = (p: PolicySnapshot<ClaudePolicy>): string[] => (p.mcp?.servers ?? []).map((s) => s.name).sort();

function mcp(server: string, tool: string, input: Record<string, unknown> = {}): PreparedMcpCall {
  return { id: 'c1', tool: 'mcp', args: { server, tool, input }, effect: { server, tool, qualifiedName: `mcp__${server}__${tool}`, input, timeoutMs: 60_000 } };
}

describe('Claude MCP servers come from where Claude Code keeps them', () => {
  it('reads --mcp-config files and inline JSON, and --strict-mcp-config leaves out every other scope', async () => {
    const userServers = { user: server() };
    const local = { local: server() };
    const plain = await load({ argv: ['--mcp-config', '{"mcpServers":{"inline":{"command":"node"}}}'], userServers, projectEntry: { mcpServers: local } });
    expect(names(plain.policy)).toEqual(['inline', 'local', 'user']);
    const strict = await load({ argv: ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{"inline":{"command":"node"}}}'], userServers, projectEntry: { mcpServers: local } });
    expect(names(strict.policy)).toEqual(['inline']);
  });

  it('starts a server with its command, arguments, ${VAR} expansion, the session environment and Claude\'s directory', async () => {
    const { policy, project } = await load({
      env: { PATH: '/usr/bin', TOKEN: 'secret-1' },
      argv: ['--mcp-config', JSON.stringify({ mcpServers: { a: { command: 'node', args: ['${HOME:-/h}/srv.js'], env: { API: '${TOKEN}' } } } })],
    });
    const spec = policy.mcp?.servers[0];
    expect(spec).toMatchObject({ name: 'a', command: 'node', args: ['/h/srv.js'], cwd: project, env: { PATH: '/usr/bin', TOKEN: 'secret-1', API: 'secret-1' } });
    expect(spec?.startupTimeoutMs).toBe(30_000);
  });

  it('leaves out a server whose ${VAR} is unset, naming the variable and no value', async () => {
    const { policy } = await load({ argv: ['--mcp-config', JSON.stringify({ mcpServers: { a: { command: 'node', env: { API: '${MISSING}' } } } })] });
    expect(names(policy)).toEqual([]);
    expect(policy.mcp?.notes.join()).toContain('${MISSING} is not set');
  });

  it('leaves out remote servers, entries with keys it does not apply, and names that would make mcp__ ambiguous', async () => {
    const servers = { remote: { type: 'http', url: 'https://x' }, odd: { command: 'node', cwd: '/x' }, 'a__b': server(), 'end_': server(), ok: server() };
    const { policy } = await load({ argv: ['--mcp-config', JSON.stringify({ mcpServers: servers })] });
    expect(names(policy)).toEqual(['ok']);
    expect(policy.mcp?.notes).toHaveLength(4);
  });

  it.each([
    ['an untrusted project', { trusted: false, local: { enabledMcpjsonServers: ['proj'] } }, false],
    ['no approval', {}, false],
    ['approval by the project\'s own settings', { project: { enableAllProjectMcpServers: true } }, false],
    ['approval in local settings', { local: { enabledMcpjsonServers: ['proj'] } }, true],
    ['approval of every project server in user settings', { user: { enableAllProjectMcpServers: true } }, true],
    ['approval in the .claude.json project entry', { projectEntry: { enabledMcpjsonServers: ['proj'] } }, true],
    ['approval refused by disabledMcpjsonServers anywhere', { local: { enableAllProjectMcpServers: true }, project: { disabledMcpjsonServers: ['proj'] } }, false],
  ] as const)('.mcp.json servers need trust and approval: %s', async (_name, o, reachable) => {
    const { policy } = await load({ ...o, mcpJson: { proj: server() } });
    expect(names(policy).includes('proj')).toBe(reachable);
  });

  it('leaves out a server disabled for the project and a name defined differently in two scopes', async () => {
    const { policy } = await load({
      argv: ['--mcp-config', JSON.stringify({ mcpServers: { dup: server('a'), same: server() } })],
      userServers: { dup: server('b'), same: server(), off: server() },
      projectEntry: { disabledMcpServers: ['off'] },
    });
    expect(names(policy)).toEqual(['same']);
    expect(policy.mcp?.notes.join(' ')).toMatch(/"dup": defined differently/);
  });

  it('refuses every mcpCall under managed MCP restrictions, and reaches no server without the Claude process', async () => {
    const managed = await load({ managed: { 'managed-mcp.json': '{"mcpServers":{}}' }, userServers: { u: server() } });
    expect(managed.policy.mcp?.unsupported).toMatch(/restricts MCP servers/);
    const listed = await load({ user: { deniedMcpServers: [{ serverName: 'x' }] }, userServers: { u: server() } });
    expect(listed.policy.mcp?.unsupported).toMatch(/deniedMcpServers/);
    const orphan = await load({ noParent: true, userServers: { u: server() } });
    expect(names(orphan.policy)).toEqual([]);
  });

  it('starts with the session only a server some rule or the mode can allow without asking', async () => {
    const argv = ['--mcp-config', JSON.stringify({ mcpServers: { a: server(), b: server(), c: server() } })];
    const autostart = (p: PolicySnapshot<ClaudePolicy>) => Object.fromEntries((p.mcp?.servers ?? []).map((s) => [s.name, s.autostart]));
    expect(autostart((await load({ argv, local: { permissions: { allow: ['mcp__a', 'mcp__b__one', 'mcp__*'] } } })).policy)).toEqual({ a: true, b: true, c: false });
    expect(autostart((await load({ argv, mode: 'bypassPermissions' })).policy)).toEqual({ a: true, b: true, c: true });
  });

  it('starts no server in plan mode, under a deny or ask rule for the whole server, or with an unknown mode', async () => {
    const argv = ['--mcp-config', JSON.stringify({ mcpServers: { a: server(), b: server(), c: server(), d: server() } })];
    const autostart = (p: PolicySnapshot<ClaudePolicy>) => Object.fromEntries((p.mcp?.servers ?? []).map((s) => [s.name, s.autostart]));
    const allow = ['mcp__a', 'mcp__b', 'mcp__c', 'mcp__d'];
    expect(autostart((await load({ argv, mode: 'plan', local: { permissions: { allow } } })).policy)).toEqual({ a: false, b: false, c: false, d: false });
    expect(autostart((await load({ argv, local: { permissions: { allow, deny: ['mcp__a', 'mcp__b__*', 'mcp__d__one'], ask: ['mcp__c'] } } })).policy)).toEqual({ a: false, b: false, c: false, d: true });
    expect(autostart((await load({ argv, mode: 'bypassPermissions', local: { permissions: { deny: ['mcp__*'] } } })).policy)).toEqual({ a: false, b: false, c: false, d: false });
  });

  it('refuses every mcpCall under strictPluginOnlyCustomization', async () => {
    const { policy } = await load({ user: { strictPluginOnlyCustomization: ['mcp'] }, userServers: { u: server() } });
    expect(policy.mcp?.unsupported).toMatch(/strictPluginOnlyCustomization/);
  });

  it('refuses a name whose later definition is invalid, not only that definition', async () => {
    const { policy } = await load({ argv: ['--mcp-config', JSON.stringify({ mcpServers: { a: server() } })], userServers: { a: { type: 'http', url: 'https://x' } } });
    expect(names(policy)).toEqual([]);
  });

  it('protects and watches the session\'s --mcp-config files', async () => {
    const { policy, project } = await load({ argv: ['--mcp-config', 'cfg/servers.json', '{"mcpServers":{}}'] });
    const file = path.join(project, 'cfg', 'servers.json');
    expect(policy.protectedPaths).toContain(file);
    expect(policy.watchedPaths).toContain(file);
  });

  it('collects the config values that may be credentials: env, expanded arguments and credential flags', async () => {
    const entry = { command: 'node', args: ['--token', 'tok-aaaa', '${KEY}', '--name', 'plain'], env: { API: 'api-bbbb' } };
    const { policy } = await load({ env: { PATH: '/usr/bin', KEY: 'key-cccc' }, argv: ['--mcp-config', JSON.stringify({ mcpServers: { a: entry } })] });
    expect([...(policy.mcp?.servers[0]?.secrets ?? [])].sort()).toEqual(['api-bbbb', 'key-cccc', 'tok-aaaa']);
  });

  it('expands ${VAR} and ${VAR:-default} like Claude Code', () => {
    expect(expandVars('a${X}b${Y:-d}', { X: '1' })).toBe('a1bd');
    expect(expandVars('${Z}', {})).toEqual({ missing: 'Z' });
  });
});

describe('Claude MCP permission rules', () => {
  const decide = async (o: Options, call = mcp('srv', 'tool')) => {
    const { adapter, policy, ctx } = await load(o);
    return adapter.checkStatic(call, ctx, policy);
  };
  it.each([
    ['an exact allow rule', { allow: ['mcp__srv__tool'] }, undefined, 'allow'],
    ['a server allow rule', { allow: ['mcp__srv'] }, undefined, 'allow'],
    ['an anchored tool glob', { allow: ['mcp__srv__*'] }, undefined, 'allow'],
    ['an unanchored allow glob, which Claude Code skips', { allow: ['mcp__*'] }, undefined, 'ask'],
    ['an allow rule for another server', { allow: ['mcp__srv2'] }, undefined, 'ask'],
    ['no rule', {}, undefined, 'ask'],
    ['deny over allow', { allow: ['mcp__srv'], deny: ['mcp__srv__tool'] }, undefined, 'deny'],
    ['a deny glob', { allow: ['mcp__srv'], deny: ['mcp__*'] }, undefined, 'deny'],
    ['ask over allow', { allow: ['mcp__srv'], ask: ['mcp__srv__tool'] }, undefined, 'ask'],
    ['bypassPermissions without a rule', {}, 'bypassPermissions', 'allow'],
    ['bypassPermissions under an ask rule', { ask: ['mcp__srv'] }, 'bypassPermissions', 'ask'],
    ['plan mode over an allow rule', { allow: ['mcp__srv'] }, 'plan', 'deny'],
    ['dontAsk without a rule', {}, 'dontAsk', 'deny'],
    ['acceptEdits without a rule', {}, 'acceptEdits', 'ask'],
    ['auto mode without a rule', {}, 'auto', 'ask'],
  ] as const)('%s', async (_name, permissions, mode, kind) => {
    expect((await decide({ local: { permissions }, ...(mode === undefined ? {} : { mode }) })).kind).toBe(kind);
  });

  it('refuses the whole policy over an MCP rule with a parameter, from settings or --disallowedTools, so no call runs', async () => {
    for (const o of [{ argv: ['--allowedTools', 'mcp__srv', '--disallowedTools', 'mcp__srv__tool(x)'] }, { local: { permissions: { allow: ['mcp__srv'], deny: ['mcp__srv__tool(x)'] } } }]) {
      await expect(load(o)).rejects.toThrow(/is not a valid `Tool` or `Tool\(specifier\)` rule/);
    }
  });

  it('applies the parent --allowedTools and --disallowedTools', async () => {
    expect((await decide({ argv: ['--allowedTools', 'mcp__srv'] })).kind).toBe('allow');
    expect((await decide({ argv: ['--allowedTools', 'mcp__srv', '--disallowedTools', 'mcp__srv__tool'] })).kind).toBe('deny');
  });

  it('runs PreToolUse hooks whose matcher names the tool, with the MCP tool input', async () => {
    const hook = (mode: string, arg?: string) => ({ type: 'command', command: process.execPath, args: [HOOK, mode, ...(arg === undefined ? [] : [arg])] });
    const withHook = (matcher: string, h: Record<string, unknown>) => ({ local: { permissions: { allow: ['mcp__srv'] }, hooks: { PreToolUse: [{ matcher, hooks: [h] }] } } });
    const authorize = async (o: Options) => {
      const { adapter, policy, ctx } = await load(o);
      return adapter.authorize(mcp('srv', 'tool', { a: 1 }), ctx, policy, new AbortController().signal);
    };
    expect(await authorize(withHook('Bash', hook('exit2')))).toEqual({ kind: 'allow' });
    if (process.platform === 'win32') {
      // Command hooks are refused on Windows (the hook shell cannot be selected), so a matching one denies the call.
      expect(await authorize(withHook('mcp__srv__tool', hook('exit2')))).toMatchObject({ kind: 'deny', source: 'unsupported-config' });
      return;
    }
    expect(await authorize(withHook('mcp__srv__tool', hook('exit2')))).toMatchObject({ kind: 'deny', source: 'hook' });
    expect(await authorize(withHook('mcp__srv__.*', hook('deny')))).toMatchObject({ kind: 'deny' });
    expect(await authorize(withHook('mcp__srv__tool', hook('update', '{"a":2}')))).toMatchObject({ kind: 'allow', updatedArgs: { server: 'srv', tool: 'tool', args: { a: 2 } } });
  });
});
