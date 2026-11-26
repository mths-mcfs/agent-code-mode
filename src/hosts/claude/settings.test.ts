import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PreparedCall } from '../../core/types.js';
import { makeContext } from '../../testing/index.js';
import { ClaudeHostAdapter } from './adapter.js';
import { findClaudeAncestor, findClaudeFromSelf, macProcess, parseClaudeFlags, processTableReader, splitWindowsCommandLine, windowsPowerShellInvocation, windowsProcessTable, type ProcessInfo } from './parent-args.js';

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

function adapterFor(l: Layout, argv?: readonly string[], parent?: { readonly cwd?: string }): ClaudeHostAdapter {
  return new ClaudeHostAdapter({
    env: {},
    home: l.home,
    managedDir: l.managed,
    stateDir: path.join(l.base, 'state'),
    readParent: async () => (argv || parent ? { argv: ['claude', ...(argv ?? [])], cwd: l.project, ...parent } : undefined),
  });
}

function bash(command: string, cwd: string): PreparedCall {
  return { id: 'c1', tool: 'bash', args: { command, cwd, timeoutMs: 1000 }, effect: { command, shell: { path: '/bin/bash', args: ['-c'] }, cwd, timeoutMs: 1000, containment: { mode: 'none' } } };
}

async function decide(l: Layout, command: string, argv?: readonly string[], mode = 'bypassPermissions', contained = true): Promise<string> {
  const adapter = adapterFor(l, argv);
  const ctx = makeContext(l.project, { host: 'claude', permissionMode: mode, sources: { cwd: 'roots', permissionMode: 'ctx-file' } });
  const policy = await adapter.loadPolicy(ctx);
  if ('error' in policy) return `error: ${policy.error}`;
  const sandbox = { mode: 'sandbox', readOnly: false, writableRoots: [l.project], network: false } as const;
  const snapshot = contained ? { ...policy, bashContainment: sandbox, payload: { ...policy.payload, sandboxLimitsWrites: true } } : policy;
  return adapter.checkStatic(bash(command, l.project), ctx, snapshot).kind;
}

describe('settings sources', () => {
  it('fails the policy load on invalid JSON or wrong types', async () => {
    expect(await decide(await layout({ 'project/.claude/settings.json': '{ nope' }), 'ls')).toMatch(/^error: .*not valid JSON/);
    expect(await decide(await layout({ 'home/.claude/settings.json': { permissions: { deny: 'Bash(rm:*)' } } }), 'ls')).toMatch(/^error: .*permissions\.deny/);
    expect(await decide(await layout({ 'project/.claude/settings.local.json': { hooks: { PreToolUse: [{ hooks: 'x' }] } } }), 'ls')).toMatch(/^error/);
    expect(await decide(await layout({ 'managed/managed-settings.json': '[' }), 'ls')).toMatch(/^error/);
    expect(await decide(await layout({ 'home/.claude/settings.json': { permissions: { deny: ['Bash(rm'] } } }), 'ls')).toMatch(/^error: .*not a valid/);
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
    const files = { 'project/.claude/settings.json': { permissions: { allow: ['Bash(make build)'], deny: ['Bash(rm *)'] } } };
    const untrusted = await layout(files, false);
    expect(await decide(untrusted, 'make build', undefined, 'default', false)).toBe('ask');
    expect(await decide(untrusted, 'rm x')).toBe('deny');
    const trusted = await layout(files, true);
    expect(await decide(trusted, 'make build', undefined, 'default', false)).toBe('allow');
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
    expect(await decide(l, 'git status', ['--allowedTools=Bash(git status)'], 'default', false)).toBe('allow');
    expect(await decide(l, 'nc x', ['--setting-sources', 'user'])).toBe('allow');
    expect(await decide(l, 'ls', ['--settings', path.join(l.base, 'missing.json')])).toMatch(/^error/);
  });

  it('allowManagedPermissionRulesOnly drops rules from other sources', async () => {
    const l = await layout({
      'managed/managed-settings.json': { allowManagedPermissionRulesOnly: true },
      'home/.claude/settings.json': { permissions: { allow: ['Bash(make x)'] } },
    });
    expect(await decide(l, 'make x', undefined, 'default', false)).toBe('ask');
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

describe('settings boundaries', () => {
  const policyOf = async (l: Layout, argv: readonly string[] = [], parent: { readonly cwd?: string } = {}) => {
    const [adapter, ctx] = [adapterFor(l, argv, parent), makeContext(l.project, { host: 'claude' })];
    return { adapter, ctx, policy: await adapter.loadPolicy(ctx) };
  };

  it('rejects non-boolean plugin values, a settings path that is not a regular file, and oversized settings', async () => {
    expect(await decide(await layout({ 'home/.claude/settings.json': { enabledPlugins: { 'p@m': 'yes' } } }), 'ls')).toMatch(/^error: .*enabledPlugins/);
    const dir = await layout({});
    await mkdir(path.join(dir.project, '.claude', 'settings.json'), { recursive: true });
    expect(await decide(dir, 'ls')).toMatch(/^error: .*not a regular file/);
    expect(await decide(await layout({ 'project/.claude/settings.json': `{"x":"${'a'.repeat(4 * 1024 * 1024)}"}` }), 'ls')).toMatch(/^error: .*larger than/);
  });

  // Claude keeps the local file in the starting directory on Windows.
  it.skipIf(process.platform === 'win32')('reads project and local settings where Claude runs; the repository root local file wins a scalar key', async () => {
    const l = await layout({
      'project/.claude/settings.json': { permissions: { deny: ['Bash(ls:*)'] } },
      'repo/.git/HEAD': 'x',
      'repo/.claude/settings.local.json': { permissions: { defaultMode: 'default', deny: ['Bash(rm:*)'] } },
      'repo/sub/.claude/settings.local.json': { permissions: { defaultMode: 'dontAsk', deny: ['Bash(curl:*)'] } },
      'repo/sub/.claude/settings.json': { permissions: { deny: ['Read(/secret.txt)'] } },
    });
    const { adapter, ctx, policy } = await policyOf(l, [], { cwd: path.join(l.base, 'repo', 'sub') });
    if ('error' in policy) throw new Error(policy.error);
    const read = (p: string): PreparedCall => ({ id: 'c1', tool: 'read', args: { path: p, offset: 1, limit: 1 }, effect: { absPath: p, offset: 1, limit: 1 } });
    const kinds = [bash('ls', l.project), bash('rm x', l.project), bash('curl x', l.project), read(path.join(l.project, 'secret.txt'))].map((c) => adapter.checkStatic(c, ctx, policy).kind);
    expect([policy.payload.mode, ...kinds]).toEqual(['default', 'ask', 'deny', 'deny', 'allow']);
    expect(adapter.checkStatic(read(path.join(l.base, 'repo', 'sub', 'secret.txt')), ctx, policy).kind).toBe('deny');
  });

  it('a linked worktree does not inherit its main checkout trust, even when git metadata points both ways', async () => {
    const l = await layout({ 'main/.git/worktrees/wt/HEAD': 'x', 'project/.claude/settings.json': { permissions: { allow: ['Bash(make x)'] } } }, false);
    const main = path.join(l.base, 'main');
    await writeFile(path.join(l.home, '.claude.json'), JSON.stringify({ projects: { [main]: { hasTrustDialogAccepted: true } } }));
    await writeFile(path.join(l.project, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'wt')}\n`);
    await writeFile(path.join(main, '.git', 'worktrees', 'wt', 'gitdir'), `${path.join(l.project, '.git')}\n`);
    expect(await decide(l, 'make x', undefined, 'default', false)).toBe('ask');
    await writeFile(path.join(l.home, '.claude.json'), JSON.stringify({ projects: { [l.project]: { hasTrustDialogAccepted: true } } }));
    expect(await decide(l, 'make x', undefined, 'default', false)).toBe('allow');
  });

  it('keeps hooks of managed-enabled plugins under allowManagedHooksOnly and refuses before reading an unverifiable plugin', async () => {
    const l = await layout({
      'managed/managed-settings.json': { allowManagedHooksOnly: true, enabledPlugins: { 'guard@m': true } },
      'home/.claude/settings.json': { enabledPlugins: { 'other@m': true } },
      'guard/hooks/hooks.json': { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'exit 2' }] }] } },
      'other/hooks/hooks.json': '{ not json',
      'home/.claude/plugins/installed_plugins.json': { plugins: {} },
    });
    const plugins = { 'guard@m': [{ installPath: path.join(l.base, 'guard') }], 'other@m': [{ installPath: path.join(l.base, 'other') }] };
    await writeFile(path.join(l.home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins }));
    await rm(path.join(l.base, 'guard'), { recursive: true });
    const { policy } = await policyOf(l);
    expect('error' in policy ? policy.error : '').toMatch(/guard@m .*source cannot be verified/);
    await mkdir(path.join(l.base, 'guard', 'hooks'), { recursive: true });
    await writeFile(path.join(l.base, 'guard', 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'exit 2' }] }] } }));
    await writeFile(path.join(l.managed, 'managed-settings.json'), JSON.stringify({ allowManagedHooksOnly: true, disableCommandPluginSources: false, enabledPlugins: { 'guard@m': true } }));
    const allowed = (await policyOf(l)).policy;
    if ('error' in allowed) throw new Error(allowed.error);
    expect(allowed.payload.preHooks.map((h) => h.origin)).toEqual(['plugin guard@m']);
    expect(allowed.payload.preHooks[0]?.unsupported).toEqual(process.platform === 'win32' ? expect.stringMatching(/not supported on Windows/) : undefined);
  });

  it('a rejected repository default mode starts default instead of falling through to the user default', async () => {
    const l = await layout({ 'home/.claude/settings.json': { permissions: { defaultMode: 'acceptEdits' } }, 'project/.claude/settings.json': { permissions: { defaultMode: 'bypassPermissions' } } });
    const { policy } = await policyOf(l);
    expect('error' in policy ? policy.error : policy.payload.mode).toBe('default');
  });

  it('anchors sandbox write grants at their settings source and skips grants without a documented anchor', async () => {
    const sub = 'project/sub';
    // A fully qualified absolute path: a drive-less `/abs` resolves against different drives on Windows.
    const abs = path.join(path.parse(os.tmpdir()).root, 'abs', 'dir');
    const l = await layout({ [`${sub}/.claude/settings.json`]: { sandbox: { enabled: true, filesystem: { allowWrite: ['./out', '~/cache', `${abs}${path.sep}`] } } } });
    const flag = JSON.stringify({ sandbox: { filesystem: { allowWrite: ['./flag-out'] } } });
    const { policy } = await policyOf(l, ['--settings', flag], { cwd: path.join(l.base, sub) });
    if ('error' in policy) throw new Error(policy.error);
    const roots = policy.bashContainment.mode === 'sandbox' ? policy.bashContainment.writableRoots : [];
    expect(roots).toEqual(expect.arrayContaining([path.join(l.base, sub, 'out'), path.join(l.home, 'cache'), abs]));
    expect(roots.filter((r) => r.endsWith('flag-out'))).toEqual([]);
  });

  it('reads settings at the current directory the companion record reports and runs hooks there', async () => {
    const sub = path.join('project', 'sub');
    const l = await layout({ [`${sub}/.claude/settings.json`]: { permissions: { deny: ['Read(/secret.txt)'] } } });
    const adapter = adapterFor(l);
    const ctx = makeContext(path.join(l.base, sub), { host: 'claude', roots: [l.project], sources: { cwd: 'ctx-file' } });
    const policy = await adapter.loadPolicy(ctx);
    if ('error' in policy) throw new Error(policy.error);
    const secret = path.join(l.base, sub, 'secret.txt');
    const read: PreparedCall = { id: 'c1', tool: 'read', args: { path: secret, offset: 1, limit: 1 }, effect: { absPath: secret, offset: 1, limit: 1 } };
    expect(adapter.checkStatic(read, ctx, policy).kind).toBe('deny');
    expect(policy.payload.cwd).toBe(path.join(l.base, sub));
    const elsewhere = path.join(l.base, 'elsewhere');
    const fromParent = await adapterFor(l, [], { cwd: elsewhere }).loadPolicy(makeContext(l.project, { host: 'claude' }));
    if ('error' in fromParent) throw new Error(fromParent.error);
    expect(fromParent.payload.cwd).toBe(elsewhere);
    expect(fromParent.payload.workingDirs).toContain(elsewhere);
    expect(fromParent.payload.hookEnv['CLAUDE_PROJECT_DIR']).toBe(l.project);
  });

  it('keeps the launch directory settings after the session moves into a subdirectory with its own', async () => {
    const sub = path.join('project', 'sub');
    const l = await layout({ 'project/.claude/settings.json': { permissions: { deny: ['Bash(curl:*)'] } }, [`${sub}/.claude/settings.json`]: { permissions: { deny: ['Bash(wget:*)'] } } });
    const adapter = adapterFor(l, [], { cwd: l.project });
    const ctx = makeContext(path.join(l.base, sub), { host: 'claude', roots: [l.project], permissionMode: 'bypassPermissions', sources: { cwd: 'ctx-file', permissionMode: 'ctx-file' } });
    const policy = await adapter.loadPolicy(ctx);
    if ('error' in policy) throw new Error(policy.error);
    expect(['curl x', 'wget x'].map((c) => adapter.checkStatic(bash(c, l.project), ctx, policy).kind)).toEqual(['deny', 'deny']);
  });

  it('directories only repository settings add do not pass the read block', async () => {
    const l = await layout({
      'home/.claude/settings.json': { permissions: { blockReadsOutsideWorkingDirectories: true, additionalDirectories: ['~/user-extra'] } },
      'project/.claude/settings.json': { permissions: { additionalDirectories: ['../repo-extra'] } },
    });
    const [extra, userExtra] = [path.join(l.base, 'repo-extra'), path.join(l.home, 'user-extra')];
    const { adapter, ctx, policy } = await policyOf(l);
    if ('error' in policy) throw new Error(policy.error);
    const read = (p: string): PreparedCall => ({ id: 'c1', tool: 'read', args: { path: p, offset: 1, limit: 1 }, effect: { absPath: p, offset: 1, limit: 1 } });
    expect(policy.payload.workingDirs).toContain(extra);
    expect(adapter.checkStatic(read(path.join(extra, 'a')), ctx, policy).kind).toBe('deny');
    expect(adapter.checkStatic(read(path.join(userExtra, 'a')), ctx, policy).kind).toBe('allow');
  });

  it('matches allowedHttpHookUrls against the URL fetch requests, and fetches that URL', async () => {
    const hook = (url: string) => ({ allowedHttpHookUrls: ['https://hooks.example.com/allowed/*', 'https://bare.example.com'], hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'http', url }] }] } });
    const urls = ['https://hooks.example.com/allowed/../other', 'https://bare.example.com'];
    const compiled = [];
    for (const url of urls) {
      const { policy } = await policyOf(await layout({ 'home/.claude/settings.json': hook(url) }));
      if ('error' in policy) throw new Error(policy.error);
      compiled.push(policy.payload.preHooks.map((h) => [h.handler.url, h.unsupported === undefined]));
    }
    expect(compiled).toEqual([
      [['https://hooks.example.com/other', false]],
      [['https://bare.example.com/', true]],
    ]);
  });

  it('managed filesystem settings lock the filesystem sandbox switch', async () => {
    const l = await layout({
      'managed/managed-settings.json': { sandbox: { enabled: true, filesystem: { allowWrite: [] } } },
      'home/.claude/settings.json': { sandbox: { filesystem: { disabled: true } } },
    });
    const { policy } = await policyOf(l);
    if ('error' in policy) throw new Error(policy.error);
    expect(policy.bashContainment).toMatchObject({ mode: 'sandbox', writableRoots: [l.project] });
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
      agents: [],
    });
    expect(parseClaudeFlags(['claude', '--dangerously-skip-permissions']).permissionMode).toBe('bypassPermissions');
    expect(parseClaudeFlags(['claude', '--permission-mode', 'plan', '--dangerously-skip-permissions']).permissionMode).toBe('plan');
  });
});

describe('scopes and launches the policy cannot see', () => {
  const errorOf = async (l: Layout, argv?: readonly string[], parent?: { readonly cwd?: string }): Promise<string> => {
    const policy = await adapterFor(l, argv, parent).loadPolicy(makeContext(l.project, { host: 'claude' }));
    return 'error' in policy ? policy.error : '';
  };
  const withHooks = '---\nname: x\nhooks:\n  PreToolUse:\n    - matcher: Bash\n---\nbody\n';
  const withoutHooks = '---\nname: x\ndescription: no hooks here\n---\nhooks: mentioned in the body only\n';

  it.each([
    ['project/.claude/skills/review/SKILL.md'],
    ['project/.claude/agents/team/checker.md'],
    ['project/.claude/commands/ship.md'],
    ['home/.claude/agents/checker.md'],
    ['managed/.claude/skills/policy/SKILL.md'],
  ])('refuses to run when %s defines frontmatter hooks', async (file) => {
    expect(await errorOf(await layout({ [file]: withHooks }))).toMatch(/defines hooks in its frontmatter/);
  });

  it.skipIf(process.platform === 'win32')('follows a linked skill directory and refuses one whose target cannot be read', async () => {
    const l = await layout({ 'shared/review/SKILL.md': withHooks });
    await mkdir(path.join(l.project, '.claude', 'skills'), { recursive: true });
    await symlink(path.join(l.base, 'shared', 'review'), path.join(l.project, '.claude', 'skills', 'review'));
    expect(await errorOf(l)).toMatch(/review.SKILL\.md defines hooks/);
    await rm(path.join(l.base, 'shared'), { recursive: true });
    expect(await errorOf(l)).toMatch(/cannot read .*review/);
  });

  it('refuses the policy instead of approving reads when the Claude launch flags cannot be read', async () => {
    const l = await layout({});
    const loadOn = (platform: NodeJS.Platform) =>
      new ClaudeHostAdapter({ env: {}, home: l.home, managedDir: null, stateDir: path.join(l.base, 'state'), platform }).loadPolicy(makeContext(l.project, { host: 'claude' }));
    expect(await loadOn('freebsd')).toEqual({ error: expect.stringMatching(/launch flags cannot be read on freebsd/) });
    // Outside Windows there is no powershell.exe, so the process table read fails.
    if (process.platform !== 'win32') expect(await loadOn('win32')).toEqual({ error: expect.stringMatching(/Windows process table cannot be read/) });
  });

  it('refuses frontmatter hooks of skills in parent directories up to the repository root and in nested directories', async () => {
    const nested = await layout({ 'project/packages/web/.claude/skills/deploy/SKILL.md': withHooks });
    expect(await errorOf(nested)).toMatch(/packages.web.\.claude.skills.deploy.SKILL\.md defines hooks/);
    const ignored = await layout({ 'project/node_modules/pkg/.claude/skills/x/SKILL.md': withHooks });
    expect(await errorOf(ignored)).toBe('');
    for (const sub of ['app', '..app']) {
      const parent = await layout({ 'repo/.git/HEAD': 'x', 'repo/.claude/skills/root/SKILL.md': withHooks, [`repo/${sub}/.claude/settings.json`]: {} });
      const start = path.join(parent.base, 'repo', sub);
      const policy = await adapterFor(parent, [], { cwd: start }).loadPolicy(makeContext(start, { host: 'claude' }));
      expect('error' in policy ? policy.error : '', sub).toMatch(/repo.\.claude.skills.root.SKILL\.md defines hooks/);
    }
  });

  it('ignores hooks outside the frontmatter and skill files that are not SKILL.md', async () => {
    const l = await layout({ 'project/.claude/skills/review/SKILL.md': withoutHooks, 'project/.claude/skills/review/notes.md': withHooks, 'project/.claude/agents/a.md': withoutHooks });
    expect(await errorOf(l)).toBe('');
  });

  it('refuses frontmatter hooks of an enabled plugin and of a directory added at launch', async () => {
    const l = await layout({
      'home/.claude/settings.json': { enabledPlugins: { 'p@m': true } },
      'plugin/agents/a.md': withHooks,
      'extra/.claude/skills/s/SKILL.md': withHooks,
    });
    await mkdir(path.join(l.home, '.claude', 'plugins'), { recursive: true });
    await writeFile(path.join(l.home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'p@m': [{ installPath: path.join(l.base, 'plugin') }] } }));
    expect(await errorOf(l)).toMatch(/plugin.*agents.*a\.md defines hooks/);
    await rm(path.join(l.base, 'plugin', 'agents'), { recursive: true });
    expect(await errorOf(l, ['--add-dir', path.join(l.base, 'extra')])).toMatch(/extra.*SKILL\.md defines hooks/);
  });

  it('refuses --agents with subagent hooks or that cannot be read', async () => {
    const l = await layout({});
    expect(await errorOf(l, ['--agents', JSON.stringify({ checker: { description: 'x', prompt: 'y' } })])).toBe('');
    expect(await errorOf(l, ['--agents', JSON.stringify({ checker: { description: 'x', prompt: 'y', hooks: {} } })])).toMatch(/--agents/);
    expect(await errorOf(l, ['--agents', '{not json'])).toMatch(/--agents/);
  });

  it('refuses the policy when the Claude process chain cannot be read', async () => {
    const l = await layout({});
    const adapter = new ClaudeHostAdapter({
      env: {},
      home: l.home,
      managedDir: null,
      stateDir: path.join(l.base, 'state'),
      readParent: async () => {
        throw new Error('ancestor process 4242 cannot be read');
      },
    });
    expect(await adapter.loadPolicy(makeContext(l.project, { host: 'claude' }))).toEqual({ error: 'ancestor process 4242 cannot be read' });
  });

  it('tells a chain with no Claude process from one it cannot read', async () => {
    const chain = (table: Record<number, ProcessInfo | undefined>) => (pid: number) => Promise.resolve(table[pid]);
    const shell = { argv: ['bash'], ppid: 1 };
    expect(await findClaudeAncestor(30, chain({ 30: { argv: ['node', 'server.js'], ppid: 20 }, 20: shell }))).toBeUndefined();
    expect(await findClaudeAncestor(30, chain({ 30: { argv: ['claude', '-p'], ppid: 20, cwd: '/w' } }))).toEqual({ argv: ['claude', '-p'], cwd: '/w' });
    await expect(findClaudeAncestor(30, chain({ 30: { argv: ['node'], ppid: 20 } }))).rejects.toThrow(/process 20 cannot be read/);
    await expect(findClaudeAncestor(99, (pid) => Promise.resolve({ argv: ['sh'], ppid: pid + 1 }))).rejects.toThrow(/no Claude Code process within/);
  });

  it.skipIf(process.platform === 'win32')('protects where a linked settings file points', async () => {
    const l = await layout({ 'dotfiles/claude-local.json': { permissions: {} } });
    await mkdir(path.join(l.project, '.claude'), { recursive: true });
    await symlink(path.join(l.base, 'dotfiles', 'claude-local.json'), path.join(l.project, '.claude', 'settings.local.json'));
    const policy = await adapterFor(l, ['--settings', path.join(l.project, '.claude', 'settings.local.json')]).loadPolicy(makeContext(l.project, { host: 'claude' }));
    if ('error' in policy) throw new Error(policy.error);
    expect(policy.protectedPaths).toContain(path.join(l.base, 'dotfiles', 'claude-local.json'));
  });

  it('matches allowedHttpHookUrls hostnames without case and without a trailing dot', async () => {
    const settings = { allowedHttpHookUrls: ['https://Hooks.Example.COM./Path/*'], hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'http', url: 'https://HOOKS.example.com/Path/x' }, { type: 'http', url: 'https://hooks.example.com/path/x' }] }] } };
    const l = await layout({ 'home/.claude/settings.json': settings });
    const policy = await adapterFor(l).loadPolicy(makeContext(l.project, { host: 'claude' }));
    if ('error' in policy) throw new Error(policy.error);
    expect(policy.payload.preHooks.map((h) => h.unsupported === undefined)).toEqual([true, false]);
  });
});

describe('Windows launch flags', () => {
  // https://learn.microsoft.com/en-us/cpp/c-language/parsing-c-command-line-arguments, after a program name.
  it.each([
    ['"abc" d e', ['abc', 'd', 'e']],
    ['a\\\\b d"e f"g h', ['a\\\\b', 'de fg', 'h']],
    ['a\\\\\\"b c d', ['a\\"b', 'c', 'd']],
    ['a\\\\\\\\"b c" d e', ['a\\\\b c', 'd', 'e']],
    ['a"b"" c d', ['ab" c d']],
    ['"" x', ['', 'x']],
    ['"C:\\dir with space\\\\"  --x', ['C:\\dir with space\\', '--x']],
  ])('splits %j', (args, expected) => {
    expect(splitWindowsCommandLine(`"C:\\Program Files\\claude\\claude.exe" ${args}`)).toEqual(['C:\\Program Files\\claude\\claude.exe', ...expected]);
  });

  it('keeps backslashes in the program name and stops it at whitespace outside quotes', () => {
    expect(splitWindowsCommandLine('C:\\a\\"b c"\\claude.exe -p')).toEqual(['C:\\a\\b c\\claude.exe', '-p']);
  });

  it('runs the system PowerShell by absolute path, in System32, without PowerShell variables and with the system module path', () => {
    const run = windowsPowerShellInvocation({ SYSTEMROOT: 'C:\\Windows', TEMP: 'C:\\t', PATH: '.', PSModulePath: 'C:\\work\\modules', PSExecutionPolicyPreference: 'Unrestricted', psmoduleanalysiscachepath: 'C:\\work\\cache', __PSLockdownPolicy: '0' });
    expect(run).toMatchObject({
      file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      cwd: 'C:\\Windows\\System32',
      env: { SystemRoot: 'C:\\Windows', PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules' },
    });
    expect(Object.keys(run.env).sort()).toEqual(['PATH', 'PSModulePath', 'SystemRoot', 'TEMP']);
    expect(run.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    for (const env of [{}, { SystemRoot: 'Windows' }, { SystemRoot: '\\Windows' }]) expect(() => windowsPowerShellInvocation(env)).toThrow(/SystemRoot/);
  });

  it('refuses when any link from this server up, its immediate parent included, has a reused pid', async () => {
    const row = (ProcessId: number, ParentProcessId: number, CommandLine: string, Created: number) => ({ ProcessId, ParentProcessId, CommandLine, Created });
    const server = row(10, 20, 'node server.js', 500);
    expect(await findClaudeFromSelf(10, processTableReader([server, row(20, 1, 'claude.exe --disallowedTools Bash', 100)]))).toMatchObject({ argv: ['claude.exe', '--disallowedTools', 'Bash'] });
    // The immediate parent's pid now belongs to a process started after this server.
    await expect(findClaudeFromSelf(10, processTableReader([server, row(20, 1, 'notepad.exe', 900)]))).rejects.toThrow(/reused/);
    await expect(findClaudeFromSelf(10, processTableReader([server, row(20, 30, 'cmd.exe', 100), row(30, 1, 'explorer.exe', 300)]))).rejects.toThrow(/reused/);
    await expect(findClaudeFromSelf(10, processTableReader([row(10, 20, '', 500)]))).rejects.toThrow(/server process cannot be read/);
  });

  it.skipIf(process.platform !== 'win32')('reads the exact argv of a real parent process through CIM', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'acm-win-'));
    const cli = path.join(dir, 'claude-code', 'cli.js');
    await mkdir(path.dirname(cli), { recursive: true });
    await writeFile(cli, 'setTimeout(() => {}, 60_000);\n');
    const args = ['--disallowedTools', 'Bash(rm:*)', '--settings', '{"permissions": {"deny": ["Read(./two words.txt)"]}}', '--add-dir', 'C:\\dir with space\\'];
    const child = spawn(process.execPath, [cli, ...args], { stdio: 'ignore', windowsHide: true });
    try {
      await new Promise((resolve) => child.once('spawn', resolve));
      const pid = child.pid ?? 0;
      const found = await findClaudeAncestor(pid, await windowsProcessTable());
      expect(found?.argv.slice(2)).toEqual(args);
      expect(parseClaudeFlags(found?.argv ?? [])).toMatchObject({ disallowedTools: ['Bash(rm:*)'], addDirs: ['C:\\dir with space\\'] });
    } finally {
      child.kill();
    }
  }, 60_000);
});

describe('macOS launch flags', () => {
  it.runIf(process.platform === 'darwin')('reads the exact argv and cwd of a real parent process from the kernel', async () => {
    const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'acm-mac-')));
    const cli = path.join(dir, 'claude-code', 'cli.js');
    const cwd = path.join(dir, 'start "here" now');
    await mkdir(path.dirname(cli), { recursive: true });
    await mkdir(cwd);
    await writeFile(cli, 'setTimeout(() => {}, 60_000);\n');
    const settings = '{"permissions": {"deny": ["Read(./two words.txt)"]}}';
    const args = ['--disallowedTools', 'Bash(rm:*)', '--settings', settings, '--add-dir', '/dir with space/', '--permission-mode', 'plan', '-p', '', 'say "hi" it\'s'];
    const child = spawn(process.execPath, [cli, ...args], { cwd, stdio: 'ignore' });
    try {
      await new Promise((resolve) => child.once('spawn', resolve));
      const found = await findClaudeAncestor(child.pid ?? 0, macProcess);
      expect(found?.argv.slice(2)).toEqual(args);
      expect(found?.cwd).toBe(cwd);
      expect(parseClaudeFlags(found?.argv ?? [])).toMatchObject({ disallowedTools: ['Bash(rm:*)'], settings: [settings], addDirs: ['/dir with space/'], permissionMode: 'plan' });
    } finally {
      child.kill();
    }
  });

  it.runIf(process.platform === 'darwin')('refuses a process of another user, so its launch flags cannot be ruled out', async () => {
    await expect(macProcess(1)).rejects.toThrow(/process 1 cannot be read on macOS.*cannot be ruled out/);
  });
});
