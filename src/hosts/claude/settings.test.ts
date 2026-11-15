import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PreparedCall } from '../../core/types.js';
import { makeContext } from '../../testing/index.js';
import { ClaudeHostAdapter } from './adapter.js';
import { parseClaudeFlags } from './parent-args.js';

interface Layout {
  readonly base: string;
  readonly home: string;
  readonly project: string;
  readonly managed: string;
}

async function layout(files: Record<string, unknown>, trusted = true): Promise<Layout> {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'acm-settings-')));
  const l = { base, home: path.join(base, 'home'), project: path.join(base, 'project'), managed: path.join(base, 'managed') };
  for (const dir of [l.home, l.project, l.managed]) await mkdir(dir, { recursive: true });
  if (trusted) await writeFile(path.join(l.home, '.claude.json'), JSON.stringify({ projects: { [l.project]: { hasTrustDialogAccepted: true } } }));
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(base, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return l;
}

function adapterFor(l: Layout, argv?: readonly string[]): ClaudeHostAdapter {
  return new ClaudeHostAdapter({
    env: {},
    home: l.home,
    managedDir: l.managed,
    stateDir: path.join(l.base, 'state'),
    readParent: async () => (argv ? { argv: ['claude', ...argv], cwd: l.project } : undefined),
  });
}

function bash(command: string, cwd: string): PreparedCall {
  return { id: 'c1', tool: 'bash', args: { command, cwd, timeoutMs: 1000 }, effect: { command, cwd, timeoutMs: 1000, containment: { mode: 'none' } } };
}

async function decide(l: Layout, command: string, argv?: readonly string[], mode = 'bypassPermissions'): Promise<string> {
  const adapter = adapterFor(l, argv);
  const ctx = makeContext(l.project, { host: 'claude', permissionMode: mode, sources: { cwd: 'roots', permissionMode: 'ctx-file' } });
  const policy = await adapter.loadPolicy(ctx);
  if ('error' in policy) return `error: ${policy.error}`;
  return adapter.checkStatic(bash(command, l.project), ctx, policy).kind;
}

describe('settings sources', () => {
  it('fails the policy load on invalid JSON or wrong types', async () => {
    expect(await decide(await layout({ 'project/.claude/settings.json': '{ nope' }), 'ls')).toMatch(/^error: .*not valid JSON/);
    expect(await decide(await layout({ 'home/.claude/settings.json': { permissions: { deny: 'Bash(rm:*)' } } }), 'ls')).toMatch(/^error: .*permissions\.deny/);
    expect(await decide(await layout({ 'project/.claude/settings.local.json': { hooks: { PreToolUse: [{ hooks: 'x' }] } } }), 'ls')).toMatch(/^error/);
    expect(await decide(await layout({ 'managed/managed-settings.json': '[' }), 'ls')).toMatch(/^error/);
    expect(await decide(await layout({ 'home/.claude/settings.json': { permissions: { deny: ['Bash(rm'] } } }), 'ls')).toMatch(/^error: .*cannot be parsed/);
  });

  it('combines deny rules from every source', async () => {
    const l = await layout({
      'managed/managed-settings.json': { permissions: { deny: ['Bash(curl:*)'] } },
      'managed/managed-settings.d/10-extra.json': { permissions: { deny: ['Bash(wget:*)'] } },
      'home/.claude/settings.json': { permissions: { deny: ['Bash(scp:*)'], allow: ['Bash(curl:*)'] } },
      'project/.claude/settings.json': { permissions: { deny: ['Bash(nc:*)'] } },
      'project/.claude/settings.local.json': { permissions: { deny: ['Bash(ssh:*)'] } },
    });
    for (const c of ['curl x', 'wget x', 'scp x', 'nc x', 'ssh x']) expect(await decide(l, c), c).toBe('deny');
    expect(await decide(l, 'ls')).toBe('allow');
  });

  it('ignores project allow rules until the workspace is trusted; deny rules always apply', async () => {
    const files = { 'project/.claude/settings.json': { permissions: { allow: ['Bash(make *)'], deny: ['Bash(rm *)'] } } };
    const untrusted = await layout(files, false);
    expect(await decide(untrusted, 'make build', undefined, 'default')).toBe('ask');
    expect(await decide(untrusted, 'rm x')).toBe('deny');
    const trusted = await layout(files, true);
    expect(await decide(trusted, 'make build', undefined, 'default')).toBe('allow');
  });

  it('reads --settings (JSON or file), --allowedTools, --disallowedTools and --setting-sources from the parent process', async () => {
    const l = await layout({
      'project/.claude/settings.json': { permissions: { deny: ['Bash(nc:*)'] } },
      'extra.json': { permissions: { deny: ['Bash(dd:*)'] } },
    });
    expect(await decide(l, 'curl x', ['--settings', '{"permissions":{"deny":["Bash(curl:*)"]}}'])).toBe('deny');
    expect(await decide(l, 'dd x', ['--settings', path.join(l.base, 'extra.json')])).toBe('deny');
    expect(await decide(l, 'dd x', ['--settings', '../extra.json'])).toBe('deny'); // relative to the Claude process cwd
    expect(await decide(l, 'wget x', ['-p', '--disallowedTools', 'Bash(wget:*)', 'Read'])).toBe('deny');
    expect(await decide(l, 'git status', ['--allowedTools=Bash(git status)'], 'default')).toBe('allow');
    expect(await decide(l, 'nc x', ['--setting-sources', 'user'])).toBe('allow');
    expect(await decide(l, 'ls', ['--settings', path.join(l.base, 'missing.json')])).toMatch(/^error/);
  });

  it('allowManagedPermissionRulesOnly drops rules from other sources', async () => {
    const l = await layout({
      'managed/managed-settings.json': { allowManagedPermissionRulesOnly: true },
      'home/.claude/settings.json': { permissions: { allow: ['Bash(make *)'] } },
    });
    expect(await decide(l, 'make x', undefined, 'default')).toBe('ask');
  });

  it('allowManagedHooksOnly and managed disableAllHooks', async () => {
    const denyHook = { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'exit 2' }] }] } };
    const l = await layout({ 'managed/managed-settings.json': { allowManagedHooksOnly: true }, 'home/.claude/settings.json': denyHook });
    const adapter = adapterFor(l);
    const ctx = makeContext(l.project, { host: 'claude' });
    const policy = await adapter.loadPolicy(ctx);
    if ('error' in policy) throw new Error(policy.error);
    expect(policy.payload.preHooks).toEqual([]);
    const m = await layout({ 'managed/managed-settings.json': { ...denyHook, disableAllHooks: false }, 'home/.claude/settings.json': { disableAllHooks: true } });
    const p2 = await adapterFor(m).loadPolicy(makeContext(m.project, { host: 'claude' }));
    if ('error' in p2) throw new Error(p2.error);
    expect(p2.payload.preHooks).toHaveLength(1); // user-level disableAllHooks cannot disable managed hooks
  });

  it('refuses a plugin that declares hooks in its manifest', async () => {
    const l = await layout({
      'home/.claude/settings.json': { enabledPlugins: { 'p@m': true } },
      'home/.claude/plugins/installed_plugins.json': { plugins: { 'p@m': [{ installPath: 'PLUGIN' }] } },
    });
    const pluginRoot = path.join(l.base, 'plugin');
    await mkdir(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
    await writeFile(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'p', hooks: './more-hooks.json' }));
    await writeFile(path.join(l.home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'p@m': [{ installPath: pluginRoot }] } }));
    expect(await decide(l, 'ls')).toMatch(/^error: .*manifest/);
  });
});

describe('parseClaudeFlags', () => {
  it('parses single and variadic flags in both spellings', () => {
    expect(
      parseClaudeFlags([
        'claude',
        '-p',
        '--settings',
        '{"a":1}',
        '--settings=/x.json',
        '--permission-mode=plan',
        '--allowedTools',
        'Bash(git log:*)',
        'Read',
        '--disallowed-tools=Bash(rm:*)',
        '--add-dir',
        '/a',
        '/b',
        '--setting-sources',
        'user,project',
        'prompt text',
      ]),
    ).toEqual({
      settings: ['{"a":1}', '/x.json'],
      permissionMode: 'plan',
      allowedTools: ['Bash(git log:*)', 'Read'],
      disallowedTools: ['Bash(rm:*)'],
      settingSources: ['user', 'project'],
      addDirs: ['/a', '/b'],
    });
    expect(parseClaudeFlags(['claude', '--dangerously-skip-permissions']).permissionMode).toBe('bypassPermissions');
    expect(parseClaudeFlags(['claude', '--permission-mode', 'plan', '--dangerously-skip-permissions']).permissionMode).toBe('plan');
  });
});
