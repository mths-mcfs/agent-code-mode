import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../core/dispatcher.js';
import type { GlobResult, GrepResult, PolicySnapshot, PreparedCall, SessionContext } from '../../core/types.js';
import { MemoryToolRuntime, makeContext } from '../../testing/index.js';
import { ClaudeHostAdapter, type ClaudePolicy } from './adapter.js';
import { runContextHook } from './context-hook.js';
import { FileHookContextStore } from './context.js';

const posix = process.platform !== 'win32';

interface Setup {
  readonly adapter: ClaudeHostAdapter;
  readonly ctx: SessionContext;
  readonly policy: PolicySnapshot<ClaudePolicy>;
  readonly project: string;
  readonly home: string;
}

async function setup(user: Record<string, unknown>, mode: string, argv?: readonly string[], project0?: Record<string, unknown>): Promise<Setup> {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'acm-regress-')));
  const home = path.join(base, 'home');
  const project = path.join(base, 'project');
  await mkdir(path.join(home, '.claude'), { recursive: true });
  await mkdir(path.join(project, '.claude'), { recursive: true });
  await writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify(user));
  if (project0) await writeFile(path.join(project, '.claude', 'settings.json'), JSON.stringify(project0));
  const adapter = new ClaudeHostAdapter({
    env: {},
    home,
    managedDir: null,
    stateDir: path.join(base, 'state'),
    readParent: async () => (argv ? { argv: ['claude', ...argv], cwd: project } : undefined),
  });
  const ctx = makeContext(project, { host: 'claude', permissionMode: mode, sources: { cwd: 'roots', permissionMode: 'ctx-file' } });
  const policy = await adapter.loadPolicy(ctx);
  if ('error' in policy) throw new Error(policy.error);
  return { adapter, ctx, policy, project, home };
}

function bash(command: string, cwd: string): PreparedCall {
  return { id: 'c1', tool: 'bash', args: { command, cwd, timeoutMs: 1000 }, effect: { command, shell: { path: '/bin/bash', args: ['-c'] }, cwd, timeoutMs: 1000, containment: { mode: 'none' } } };
}
function read(p: string): PreparedCall {
  return { id: 'c1', tool: 'read', args: { path: p, offset: 1, limit: 10 }, effect: { absPath: p, offset: 1, limit: 10 } };
}
function write(p: string): PreparedCall {
  return { id: 'c1', tool: 'write', args: { path: p, content: 'x' }, effect: { absPath: p, beforeHash: null, afterContent: 'x', diff: '' } };
}
const check = (s: Setup, p: PreparedCall): string => s.adapter.checkStatic(p, s.ctx, s.policy).kind;

const SANDBOX = { sandbox: { enabled: true } };

describe('auto mode has no classifier verdict for the script', () => {
  it('only step 2 applies, even with an allow rule for the run tool', async () => {
    const s = await setup({ permissions: { allow: ['mcp__agent-code-mode__run'] } }, 'auto');
    expect(check(s, bash('git push --force origin main', s.project))).toBe('ask');
    expect(check(s, bash('git reset --hard', s.project))).toBe('ask');
    expect(check(s, read(path.join(s.project, 'a')))).toBe('allow');
    expect(check(s, write(path.join(s.project, 'a')))).toBe('allow');
    expect(check(s, write(path.join(s.home, 'b')))).toBe('ask');
    expect(check(s, read(path.join(s.home, 'b')))).toBe('ask');
  });

  it('drops broad shell allow rules and keeps exact ones', async () => {
    const s = await setup({ permissions: { allow: ['Bash', 'Bash(git *)', 'Bash(npm test)'], deny: ['Bash(npm test --bail)'] } }, 'auto');
    expect(check(s, bash('git status', s.project))).toBe('ask');
    expect(check(s, bash('npm test', s.project))).toBe('allow');
    expect(check(s, bash('npm test --bail', s.project))).toBe('deny');
  });
});

describe('critical-path removals are never auto-approved', () => {
  it.each([
    ['rm -rf ~', 'bypassPermissions'],
    ['rm -rf /', 'bypassPermissions'],
    ['rm -rf /usr', 'bypassPermissions'],
    ['rm -rf .', 'bypassPermissions'],
    ['rm -rf ..', 'bypassPermissions'],
    ['rm -rf ./*', 'bypassPermissions'],
    ['rm -rf "$DIR"/*', 'bypassPermissions'],
    ['rm -rf "$(pwd)"', 'bypassPermissions'],
    ['rm -rf logs/*/*', 'bypassPermissions'],
    ['echo "$(rm -rf ~)"', 'bypassPermissions'],
    ["bash -c 'rm -rf ~'", 'bypassPermissions'],
    ['rm -rf ~', 'auto'],
    ['rmdir /tmp', 'bypassPermissions'],
  ])('%j in %s → ask', async (command, mode) => {
    const s = await setup({ ...SANDBOX, permissions: { allow: [`Bash(${command})`] } }, mode);
    expect(check(s, bash(command, s.project))).toBe('ask');
  });

  it('dontAsk denies it; ordinary removals stay allowed', async () => {
    const d = await setup(SANDBOX, 'dontAsk');
    expect(check(d, bash('rm -rf ~', d.project))).toBe('deny');
    const s = await setup(SANDBOX, 'bypassPermissions');
    expect(check(s, bash('rm -rf build', s.project))).toBe('allow');
    expect(check(s, bash('rm *.log', s.project))).toBe('allow');
    expect(check(s, bash('rm "$f"', s.project))).toBe('allow');
  });
});

describe('Bash rule bypasses', () => {
  it.each([
    "env -S 'rm victim'",
    "env --split-string='rm victim'",
    "env -S'rm victim'",
    "bash -O extglob -c 'rm victim'",
    "bash +O extglob -c 'rm victim'",
    "bash --rcfile /dev/null -c 'rm victim'",
    `${'command '.repeat(18)}rm victim`,
    `${'command '.repeat(80)}rm victim`,
    "env -S 'git push origin main'",
    "bash -O extglob -c 'git push origin main'",
    `${'command '.repeat(18)}git push origin main`,
    'alias remove=rm; remove victim',
    'hash -p /bin/rm ls; ls victim',
    'env git "$OP" origin main',
    '/usr/bin/git "$OP" origin main',
    'git "$OP" origin main',
    'timeout 1 A=1 git push origin main',
  ])('%j is not allowed', async (command) => {
    const s = await setup({ ...SANDBOX, permissions: { deny: ['Bash(rm:*)', 'Bash(git push:*)'] } }, 'default');
    expect(check(s, bash(command, s.project))).not.toBe('allow');
  });
});

describe('recursive grep and glob', () => {
  it.skipIf(!posix)('the policy readFilter lets the tools layer drop denied files from results', async () => {
    const s = await setup({ permissions: { deny: ['Read(./.env)'] } }, 'bypassPermissions');
    const tools = new MemoryToolRuntime({ root: s.project, files: { '.env': 'SECRET=fixture\n', 'a.txt': 'SECRET mention\n' } });
    const dispatcher = new Dispatcher({ adapter: s.adapter, tools, ctx: s.ctx, policy: s.policy });
    const grep = await dispatcher.dispatch('grep', { pattern: 'SECRET', path: '.' });
    const glob = await dispatcher.dispatch('glob', { pattern: '**/*', path: '.' });
    if (!grep.ok || !glob.ok) throw new Error('search failed');
    const keep = (file: string): boolean => s.policy.readFilter?.(file) ?? true;
    const grepFiles = ('matches' in grep.value ? (grep.value as GrepResult).matches : []).map((m) => m.file);
    const globFiles = 'files' in glob.value ? (glob.value as GlobResult).files : [];
    expect(grepFiles).toContain(path.join(s.project, '.env'));
    expect(grepFiles.filter(keep)).toEqual([path.join(s.project, 'a.txt')]);
    expect(globFiles.filter(keep)).not.toContain(path.join(s.project, '.env'));
    expect(keep(path.join(s.project, 'sub', '.env'))).toBe(true);
  });
});

describe('hook deduplication', () => {
  it.skipIf(!posix)('the same command on PreToolUse and PostToolUse still runs as a PreToolUse hook', async () => {
    const hook = { matcher: 'Read', hooks: [{ type: 'command', command: 'exit 2' }] };
    const s = await setup({ hooks: { PreToolUse: [hook] } }, 'default', undefined, { hooks: { PostToolUse: [hook] } });
    expect((await s.adapter.authorize(read(path.join(s.project, 'a')), s.ctx, s.policy, new AbortController().signal)).kind).toBe('deny');
  });
});

describe('context records', () => {
  it.skipIf(!posix)('exactly one of two concurrent lookups gets the record', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'acm-regress-ctx-'));
    for (let round = 0; round < 20; round++) {
      const id = `toolu_race${round}`;
      await runContextHook(JSON.stringify({ tool_use_id: id, session_id: 's', permission_mode: 'plan' }), { stateDir: dir });
      const store = new FileHookContextStore(dir);
      const results = await Promise.all([store.lookup(id), store.lookup(id), store.lookup(id)]);
      expect(results.filter((r) => r !== undefined)).toHaveLength(1);
    }
  });
});

describe('malformed permission rules fail the policy load', () => {
  it.each([
    ['deny', 'Bash[rm]'],
    ['deny', 'Read[./.env]'],
    ['deny', 'Bash(rm'],
    ['deny', 'B*(x)'],
    ['ask', 'mcp__srv__*(x)'],
    ['allow', 'Ba-sh*'],
    ['ask', 'Bash rm'],
    ['allow', 'Read[x]'],
    ['deny', 'mcp__srv__tool(arg)'],
  ])('%s %j → every call denied unsupported-config, naming the rule and file', async (kind, raw) => {
    const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'acm-regress-')));
    const home = path.join(base, 'home');
    const settingsFile = path.join(home, '.claude', 'settings.json');
    await mkdir(path.dirname(settingsFile), { recursive: true });
    await writeFile(settingsFile, JSON.stringify({ permissions: { [kind]: [raw] } }));
    const adapter = new ClaudeHostAdapter({ env: {}, home, managedDir: null, stateDir: path.join(base, 'state'), readParent: async () => undefined });
    const ctx = makeContext(path.join(base, 'project'), { host: 'claude' });
    const policy = await adapter.loadPolicy(ctx);
    expect('error' in policy && policy.error).toContain(JSON.stringify(raw));
    expect('error' in policy && policy.error).toContain(settingsFile);
    const tools = new MemoryToolRuntime({ root: ctx.cwd, files: { 'a.txt': 'x' } });
    const reply = await new Dispatcher({ adapter, tools, ctx, policy }).dispatch('read', { path: 'a.txt' });
    expect(reply).toMatchObject({ ok: false, error: { name: 'PermissionDenied', source: 'unsupported-config' } });
  });

  it('a malformed rule from the parent --disallowedTools fails the load too', async () => {
    const s = setup({}, 'default', ['--disallowedTools', 'Bash[rm]']);
    await expect(s).rejects.toThrow(/Bash\[rm\].*cli settings/);
  });

  it.each(['mcp__agent-code-mode', 'mcp__srv__*', 'mcp__srv__tool_name', 'Bash(rm:*)', 'Read(./x (1).txt)', 'WebFetch(domain:example.com)', 'NotebookEdit'])(
    '%j is a valid rule',
    async (raw) => {
      await expect(setup({ permissions: { deny: [raw] } }, 'default')).resolves.toBeDefined();
    },
  );
});

describe('tool-name globs (documented in "Tool name wildcards")', () => {
  const decide = async (list: 'deny' | 'ask' | 'allow', rule: string, mode: string): Promise<{ bash: string; read: string }> => {
    const s = await setup({ permissions: { [list]: [rule], allow: ['Bash(ls)'] } }, mode);
    return { bash: check(s, bash('ls', s.project)), read: check(s, read(path.join(s.project, 'a'))) };
  };

  it.each([
    // deny: the pattern must match the full tool name.
    ['deny', '*', { bash: 'deny', read: 'deny' }],
    ['deny', 'B*', { bash: 'deny', read: 'allow' }],
    ['deny', 'R*d', { bash: 'allow', read: 'deny' }],
    ['deny', 'mcp__*', { bash: 'allow', read: 'allow' }],
    ['deny', 'mcp__agent-code-mode__*', { bash: 'allow', read: 'allow' }],
    ['ask', '*', { bash: 'ask', read: 'ask' }],
    ['ask', 'B*', { bash: 'ask', read: 'allow' }],
    ['ask', 'mcp__*', { bash: 'allow', read: 'allow' }],
    ['ask', 'mcp__srv__*', { bash: 'allow', read: 'allow' }],
  ])('%s %j in bypassPermissions', async (list, rule, expected) => {
    expect(await decide(list as 'deny' | 'ask', rule, 'bypassPermissions')).toMatchObject(expected);
  });

  it.each([
    // Unanchored allow globs are skipped: they approve nothing.
    ['*', { read: 'ask' }],
    ['R*', { read: 'ask' }],
  ])('allow %j', async (rule, expected) => {
    const s = await setup({ permissions: { allow: [rule] } }, 'default');
    expect({ read: check(s, read(path.join(s.home, 'a'))) }).toMatchObject(expected);
  });
});

describe('limits no allow rule or mode lifts', () => {
  it('applies blockReadsOutsideWorkingDirectories and blockWritesOutsideWorkingDirectories in every mode', async () => {
    const s = await setup({ permissions: { allow: ['Bash(cat ~/a)', 'Read', 'Edit'], blockReadsOutsideWorkingDirectories: true, blockWritesOutsideWorkingDirectories: true } }, 'bypassPermissions');
    expect(check(s, read(path.join(s.home, 'a')))).toBe('deny');
    expect(check(s, write(path.join(s.home, 'a')))).toBe('deny');
    expect(check(s, bash('cat ~/a', s.project))).toBe('ask');
    expect(check(s, read(path.join(s.project, 'a')))).toBe('allow');
  });

  it('blockWritesOutsideWorkingDirectories needs the sandbox for bash and narrows its write grants', async () => {
    const outside = { permissions: { allow: ['Bash(touch a)'], blockWritesOutsideWorkingDirectories: true } };
    const bare = await setup(outside, 'default');
    expect(check(bare, bash('touch a', bare.project))).toBe('ask');
    const s = await setup({ ...outside, sandbox: { enabled: true, filesystem: { allowWrite: ['//opt/cache', './build'] } } }, 'default');
    expect(check(s, bash('touch a', s.project))).toBe('allow');
    const roots = s.policy.bashContainment.mode === 'sandbox' ? s.policy.bashContainment.writableRoots : [];
    expect(roots).not.toContain(path.resolve('/opt/cache'));
  });

  it('plan mode refuses changes before allow rules', async () => {
    const s = await setup({ permissions: { allow: ['Edit', 'Bash(touch *)'] } }, 'plan');
    expect(check(s, write(path.join(s.project, 'a')))).toBe('deny');
    expect(check(s, bash('touch a', s.project))).toBe('deny');
    expect(check(s, read(path.join(s.project, 'a')))).toBe('allow');
  });

});

describe('outside the sandbox, only an exact allow rule approves bash', () => {
  it.each([
    ['Bash', 'ls', 'ask'],
    ['Bash(*)', 'ls', 'ask'],
    ['Bash(ls *)', 'ls -la', 'ask'],
    ['Bash(npm run test:*)', 'npm run test', 'ask'],
    ['Bash(git push origin)', "git 'push origin'", 'ask'],
    ['Bash(git push origin)', 'git push origin && rm -rf x', 'ask'],
    ['Bash(find . -name x -delete)', 'find . -name x -delete', 'allow'],
    ['Bash(npm test)', 'npm test', 'allow'],
  ])('%s with %j → %s', async (rule, command, expected) => {
    const s = await setup({ permissions: { allow: [rule] } }, 'default');
    expect(check(s, bash(command, s.project))).toBe(expected);
  });
});

describe('permission mode provenance', () => {
  it.each(['bypassPermissions', 'auto'])('project settings cannot start %s', async (defaultMode) => {
    const s = await setup({}, 'default', undefined, { permissions: { defaultMode } });
    expect(await s.adapter.loadPolicy({ ...s.ctx, sources: { cwd: 'roots' } })).toMatchObject({ payload: { mode: 'default' } });
  });

  it.each([{ disableBypassPermissionsMode: 'yes' }, { defaultMode: 'acceptAll' }])('refuses %j', async (permissions) => {
    await expect(setup({ permissions }, 'default')).rejects.toThrow();
  });

  it('disableAutoMode turns auto into default', async () => {
    const s = await setup({ permissions: { disableAutoMode: 'disable' } }, 'auto');
    expect(s.policy.payload.mode).toBe('default');
  });
});

describe('sandbox settings the containment cannot express', () => {
  it('denies bash when filesystem exclusions are set', async () => {
    const s = await setup({ sandbox: { enabled: true, filesystem: { denyWrite: ['~/.ssh'] } } }, 'bypassPermissions');
    expect(s.adapter.checkStatic(bash('ls', s.project), s.ctx, s.policy)).toMatchObject({ kind: 'deny', source: 'unsupported-config' });
    expect(check(s, read(path.join(s.project, 'a')))).toBe('allow');
  });

  const on = { enabled: true };
  it.each([
    [{ permissions: { deny: ['Read(./.env)'] }, sandbox: on }, 'deny'],
    [{ permissions: { blockReadsOutsideWorkingDirectories: true }, sandbox: on }, 'deny'],
    // Without filesystem isolation the sandbox is no containment: only an exact rule approves.
    [{ permissions: { deny: ['Read(./.env)'] }, sandbox: { ...on, filesystem: { disabled: true } } }, 'ask'],
    [{ permissions: { deny: ['Read(./.env)'], allow: ['Bash(ls)'] }, sandbox: { ...on, filesystem: { disabled: true } } }, 'allow'],
  ])('with the sandbox on, the exclusions Claude projects into it from %j → bash %s', async (settings, expected) => {
    const s = await setup(settings, 'bypassPermissions');
    expect(check(s, bash('ls', s.project))).toBe(expected);
  });
});

describe('second review round', () => {
  it.skipIf(!posix)('protects the canonical location of a policy directory reached through a link', async () => {
    const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'acm-regress-')));
    const realHome = path.join(base, 'real-home');
    await mkdir(path.join(realHome, '.claude'), { recursive: true });
    await writeFile(path.join(realHome, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash'] } }));
    await symlink(realHome, path.join(base, 'home'));
    const project = path.join(base, 'project');
    await mkdir(project);
    const adapter = new ClaudeHostAdapter({ env: {}, home: path.join(base, 'home'), managedDir: null, stateDir: path.join(base, 'state'), readParent: async () => undefined });
    const ctx = makeContext(project, { host: 'claude', permissionMode: 'bypassPermissions', sources: { cwd: 'roots', permissionMode: 'ctx-file' } });
    const policy = await adapter.loadPolicy(ctx);
    if ('error' in policy) throw new Error(policy.error);
    expect(policy.protectedPaths).toContain(path.join(realHome, '.claude', '**'));
  });

  it.skipIf(!posix)('a malformed hook matcher with a wildcard denies instead of running', async () => {
    const s = await setup({ hooks: { PreToolUse: [{ matcher: '**', hooks: [{ type: 'command', command: 'exit 0' }] }] } }, 'bypassPermissions');
    expect(await s.adapter.authorize(bash('ls', s.project), s.ctx, s.policy, new AbortController().signal)).toMatchObject({ kind: 'deny', source: 'unsupported-config' });
  });

  it.skipIf(!posix)('hook failures report the outcome without the hook output', async () => {
    const s = await setup({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo diagnostic-text >&2; exit 1' }] }] } }, 'bypassPermissions');
    const decision = await s.adapter.authorize(bash('ls', s.project), s.ctx, s.policy, new AbortController().signal);
    expect(decision).toMatchObject({ kind: 'deny', source: 'hook-error' });
    expect(decision.kind === 'deny' ? decision.reason : '').not.toContain('diagnostic-text');
  });
});
