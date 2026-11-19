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

// Regression tests for defects found by the correctness review of the first version.

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
  return { id: 'c1', tool: 'bash', args: { command, cwd, timeoutMs: 1000 }, effect: { command, cwd, timeoutMs: 1000, containment: { mode: 'none' } } };
}
function read(p: string): PreparedCall {
  return { id: 'c1', tool: 'read', args: { path: p, offset: 1, limit: 10 }, effect: { absPath: p, offset: 1, limit: 10 } };
}
function write(p: string): PreparedCall {
  return { id: 'c1', tool: 'write', args: { path: p, content: 'x' }, effect: { absPath: p, beforeHash: null, afterContent: 'x', diff: '' } };
}
const check = (s: Setup, p: PreparedCall): string => s.adapter.checkStatic(p, s.ctx, s.policy).kind;

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
    const manual = await setup({ permissions: { allow: ['Bash(git *)'] } }, 'default');
    expect(check(manual, bash('git status', manual.project))).toBe('allow');
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
    const s = await setup({ permissions: { allow: ['Bash'] } }, mode);
    expect(check(s, bash(command, s.project))).toBe('ask');
  });

  it('dontAsk denies it; ordinary removals stay allowed', async () => {
    const d = await setup({ permissions: { allow: ['Bash'] } }, 'dontAsk');
    expect(check(d, bash('rm -rf ~', d.project))).toBe('deny');
    const s = await setup({ permissions: { allow: ['Bash'] } }, 'bypassPermissions');
    expect(check(s, bash('rm -rf build', s.project))).toBe('allow');
    expect(check(s, bash('rm *.log', s.project))).toBe('ask');
    expect(check(s, bash('rm "$f"', s.project))).toBe('ask');
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
    const s = await setup({ permissions: { deny: ['Bash(rm:*)', 'Bash(git push:*)'], allow: ['Bash'] } }, 'default');
    expect(check(s, bash(command, s.project))).not.toBe('allow');
  });
});

describe('Bash file targets', () => {
  it.each(["sed -n '1p' .env", 'grep SECRET .env', "awk '{print}' .env", 'tail -n 1 .env', 'less .env', 'cp .env out.txt', 'dd if=.env of=out', 'sort -o x .env'])(
    '%j is denied by Read(./.env)',
    async (command) => {
      const s = await setup({ permissions: { deny: ['Read(./.env)'], allow: ['Bash'] } }, 'default');
      expect(check(s, bash(command, s.project))).toBe('deny');
    },
  );

  it.skipIf(!posix)('resolves symlinked operands before matching (in authorize, which may do I/O)', async () => {
    const s = await setup({ permissions: { deny: ['Read(./.env)'], allow: ['Bash'] } }, 'default');
    await writeFile(path.join(s.project, '.env'), 'SECRET=1');
    await symlink(path.join(s.project, '.env'), path.join(s.project, 'alias'));
    const call = bash('cat alias', s.project);
    expect(check(s, call)).toBe('allow');
    expect(await s.adapter.authorize(call, s.ctx, s.policy, new AbortController().signal)).toMatchObject({ kind: 'deny', source: 'rule' });
  });
});

describe('recursive grep and glob', () => {
  // MemoryToolRuntime is a POSIX virtual file system.
  it.skipIf(!posix)('the policy exposes isReadDenied so the tools layer can drop denied files from results', async () => {
    const s = await setup({ permissions: { deny: ['Read(./.env)'] } }, 'bypassPermissions');
    const tools = new MemoryToolRuntime({ root: s.project, files: { '.env': 'SECRET=fixture\n', 'a.txt': 'SECRET mention\n' } });
    const dispatcher = new Dispatcher({ adapter: s.adapter, tools, ctx: s.ctx, policy: s.policy });
    const grep = await dispatcher.dispatch('grep', { pattern: 'SECRET', path: '.' });
    const glob = await dispatcher.dispatch('glob', { pattern: '**/*', path: '.' });
    if (!grep.ok || !glob.ok) throw new Error('search failed');
    const keep = (file: string): boolean => !s.policy.payload.isReadDenied(file);
    const grepFiles = ('matches' in grep.value ? (grep.value as GrepResult).matches : []).map((m) => m.file);
    const globFiles = 'files' in glob.value ? (glob.value as GlobResult).files : [];
    expect(grepFiles).toContain(path.join(s.project, '.env')); // unfiltered, the secret leaks
    expect(grepFiles.filter(keep)).toEqual([path.join(s.project, 'a.txt')]);
    expect(globFiles.filter(keep)).not.toContain(path.join(s.project, '.env'));
    expect(s.policy.payload.isReadDenied(path.join(s.project, 'sub', '.env'))).toBe(false);
  });
});

describe('hook deduplication', () => {
  it.skipIf(!posix)('the same command on PreToolUse and PostToolUse still runs as a PreToolUse hook', async () => {
    const hook = { matcher: 'Read', hooks: [{ type: 'command', command: 'exit 2' }] };
    // Project settings (read first) register it for PostToolUse, user settings for PreToolUse.
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
    const s = await setup({ permissions: { [list]: [rule] } }, mode);
    return { bash: check(s, bash('ls', s.project)), read: check(s, read(path.join(s.project, 'a'))) };
  };

  it.each([
    // deny: the pattern must match the full tool name.
    ['deny', '*', { bash: 'deny', read: 'deny' }],
    ['deny', 'B*', { bash: 'deny', read: 'allow' }],
    ['deny', 'R*d', { bash: 'allow', read: 'deny' }],
    ['deny', 'mcp__*', { bash: 'allow', read: 'allow' }],
    ['deny', 'mcp__agent-code-mode__*', { bash: 'allow', read: 'allow' }],
    // ask: same matching, the result is ask.
    ['ask', '*', { bash: 'ask', read: 'ask' }],
    ['ask', 'B*', { bash: 'ask', read: 'allow' }],
    ['ask', 'mcp__*', { bash: 'allow', read: 'allow' }],
    ['ask', 'mcp__srv__*', { bash: 'allow', read: 'allow' }],
  ])('%s %j in bypassPermissions', async (list, rule, expected) => {
    expect(await decide(list as 'deny' | 'ask', rule, 'bypassPermissions')).toMatchObject(expected);
  });

  it.each([
    // Unanchored allow globs are skipped: they approve nothing.
    ['*', { bash: 'ask' }],
    ['B*', { bash: 'ask' }],
  ])('allow %j', async (rule, expected) => {
    expect(await decide('allow', rule, 'default')).toMatchObject(expected);
  });
});

describe('limits no allow rule or mode lifts', () => {
  it('denies bash writes to protected paths and asks for a write target only known at run time', async () => {
    const s = await setup({ permissions: { allow: ['Bash'] } }, 'bypassPermissions');
    expect(check(s, bash('echo x > .claude/settings.json', s.project))).toBe('deny');
    expect(check(s, bash('cp a.json ~/.claude/settings.json', s.project))).toBe('deny');
    expect(check(s, bash('echo x > "$OUT"', s.project))).toBe('ask');
    expect(check(s, bash('echo x > out.txt', s.project))).toBe('allow');
  });

  it('applies blockReadsOutsideWorkingDirectories and blockWritesOutsideWorkingDirectories in every mode', async () => {
    const s = await setup({ permissions: { allow: ['Bash', 'Read', 'Edit'], blockReadsOutsideWorkingDirectories: true, blockWritesOutsideWorkingDirectories: true } }, 'bypassPermissions');
    expect(check(s, read(path.join(s.home, 'a')))).toBe('deny');
    expect(check(s, write(path.join(s.home, 'a')))).toBe('deny');
    expect(check(s, bash('cat ~/a', s.project))).toBe('deny');
    expect(check(s, read(path.join(s.project, 'a')))).toBe('allow');
  });

  it('plan mode refuses changes before allow rules', async () => {
    const s = await setup({ permissions: { allow: ['Edit', 'Bash(touch *)'] } }, 'plan');
    expect(check(s, write(path.join(s.project, 'a')))).toBe('deny');
    expect(check(s, bash('touch a', s.project))).toBe('deny');
    expect(check(s, read(path.join(s.project, 'a')))).toBe('allow');
  });

  it.skipIf(!posix)('re-checks the working-directory boundary after resolving links', async () => {
    const s = await setup({ permissions: { allow: ['Bash(cat *)'] } }, 'default');
    await symlink(s.home, path.join(s.project, 'outside'));
    const call = bash('cat outside/notes.txt', s.project);
    expect(check(s, call)).toBe('allow');
    expect((await s.adapter.authorize(call, s.ctx, s.policy, new AbortController().signal)).kind).toBe('ask');
  });
});

describe('Bash allow rules keep word boundaries and exact approvals', () => {
  it.each([
    ['Bash(git push origin)', "git 'push origin'", 'ask'],
    ['Bash(find *)', 'find . -name x -delete', 'ask'],
    ['Bash(find . -name x -delete)', 'find . -name x -delete', 'allow'],
    ['Bash(env *)', 'env A=1 make', 'ask'],
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
});
