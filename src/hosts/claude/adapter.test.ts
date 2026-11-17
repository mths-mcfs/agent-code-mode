import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { Dispatcher } from '../../core/dispatcher.js';
import type { Decision, PolicySnapshot, PreparedCall, SessionContext } from '../../core/types.js';
import { MemoryToolRuntime, makeContext } from '../../testing/index.js';
import { ClaudeHostAdapter, type ClaudePolicy, RUNTIME_FILES_HINT, protectedPathHit } from './adapter.js';
import { findMatchingPattern } from '../../core/paths.js';

const posix = process.platform !== 'win32';
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const HOOK = path.join(FIXTURES, 'example-hook.mjs');

/** A command hook handler running the example hook in `mode`. */
function exampleHook(mode: string, arg?: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'command', command: process.execPath, args: [HOOK, mode, ...(arg === undefined ? [] : [arg])], ...extra };
}

function preHooks(matcher: string, ...hooks: Record<string, unknown>[]): Record<string, unknown> {
  return { hooks: { PreToolUse: [{ matcher, hooks }] } };
}

interface Setup {
  readonly adapter: ClaudeHostAdapter;
  readonly ctx: SessionContext;
  readonly policy: PolicySnapshot<ClaudePolicy>;
  readonly project: string;
  readonly home: string;
  readonly base: string;
}

interface SetupOptions {
  readonly project?: Record<string, unknown>;
  readonly local?: Record<string, unknown>;
  readonly user?: Record<string, unknown>;
  /** Extra Claude CLI args seen on the parent process. */
  readonly argv?: readonly string[];
  readonly trusted?: boolean;
  /** Live permission mode from the companion hook. */
  readonly mode?: string;
  readonly env?: Record<string, string>;
  readonly files?: Record<string, string>;
}

async function setup(o: SetupOptions = {}): Promise<Setup> {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'acm-claude-')));
  const home = path.join(base, 'home');
  const project = path.join(base, 'project');
  await mkdir(path.join(home, '.claude'), { recursive: true });
  await mkdir(path.join(project, '.claude'), { recursive: true });
  if (o.project) await writeFile(path.join(project, '.claude', 'settings.json'), JSON.stringify(o.project));
  if (o.local) await writeFile(path.join(project, '.claude', 'settings.local.json'), JSON.stringify(o.local));
  if (o.user) await writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify(o.user));
  if (o.trusted !== false) await writeFile(path.join(home, '.claude.json'), JSON.stringify({ projects: { [project]: { hasTrustDialogAccepted: true } } }));
  for (const [rel, content] of Object.entries(o.files ?? {})) {
    await mkdir(path.dirname(path.join(project, rel)), { recursive: true });
    await writeFile(path.join(project, rel), content);
  }
  const adapter = new ClaudeHostAdapter({
    env: o.env ?? {},
    home,
    managedDir: null,
    stateDir: path.join(base, 'state'),
    readParent: async () => (o.argv ? { argv: ['claude', ...o.argv], cwd: project } : undefined),
  });
  const ctx = makeContext(project, {
    host: 'claude',
    sessionId: 'session-1',
    toolUseId: 'toolu_1',
    transcriptPath: path.join(base, 't.jsonl'),
    permissionMode: o.mode ?? 'default',
    sources: o.mode === undefined ? { cwd: 'roots' } : { cwd: 'roots', permissionMode: 'ctx-file' },
  });
  const policy = await adapter.loadPolicy(ctx);
  if ('error' in policy) throw new Error(policy.error);
  return { adapter, ctx, policy, project, home, base };
}

const containment = { mode: 'none' } as const;

function bash(command: string, cwd: string): PreparedCall {
  return { id: 'c1', tool: 'bash', args: { command, cwd, timeoutMs: 120_000 }, effect: { command, cwd, timeoutMs: 120_000, containment } };
}
function read(p: string, real = p): PreparedCall {
  return { id: 'c1', tool: 'read', args: { path: p, offset: 1, limit: 2000 }, effect: { absPath: real, offset: 1, limit: 2000 } };
}
function write(p: string, content = 'x'): PreparedCall {
  return { id: 'c1', tool: 'write', args: { path: p, content }, effect: { absPath: p, beforeHash: null, afterContent: content, diff: '' } };
}
function edit(p: string, matched: string, newString: string): PreparedCall {
  return {
    id: 'c1',
    tool: 'edit',
    args: { path: p, oldString: matched.trim(), newString },
    effect: { absPath: p, beforeHash: 'h', afterContent: newString, diff: '', matchedOldString: matched, matchStrategy: 'trailing-whitespace', replacements: 1 },
  };
}
function grep(root: string): PreparedCall {
  return { id: 'c1', tool: 'grep', args: { pattern: 'x', path: root }, effect: { absRoot: root, pattern: 'x', glob: '*.ts', ignoreCase: true, maxResults: 50 } };
}
function glob(root: string): PreparedCall {
  return { id: 'c1', tool: 'glob', args: { pattern: '**/*.ts', path: root }, effect: { absRoot: root, pattern: '**/*.ts', maxResults: 50 } };
}

/** A native path as a bash word: `/` separators (Git Bash reads `C:/x`; an unquoted `C:\x` loses its backslashes). */
function shellPath(p: string): string {
  return p.split(path.sep).join('/');
}

function check(s: Setup, prepared: PreparedCall): Decision['kind'] {
  return s.adapter.checkStatic(prepared, s.ctx, s.policy).kind;
}

function authorize(s: Setup, prepared: PreparedCall, signal = new AbortController().signal): Promise<Decision> {
  return s.adapter.authorize(prepared, s.ctx, s.policy, signal);
}

describe('Bash rules', () => {
  it.each([
    ['echo ok && rm -rf x', 'deny'],
    ['echo $(rm -rf x)', 'deny'],
    ['echo `rm x`', 'deny'],
    ['FOO=1 rm x', 'deny'],
    ['timeout 5 rm x', 'deny'],
    ['sudo rm x', 'deny'],
    ['sudo -u root rm x', 'deny'],
    ["bash -c 'rm x'", 'deny'],
    ['sh -ec "echo a; rm x"', 'deny'],
    ['nice -n 5 nohup rm x', 'deny'],
    ['env A=1 rm x', 'deny'],
    ['/bin/rm -rf build', 'deny'],
    ['ls | xargs rm', 'deny'],
    ['ls | xargs -n1 rm', 'deny'],
    ['find . -name a -exec rm {} \\;', 'deny'],
    ['cat <(rm z)', 'deny'],
    ['(cd sub && rm x)', 'deny'],
    ['for f in a b; do rm "$f"; done', 'deny'],
    ['rm', 'deny'],
    ['rm $TARGET', 'deny'],
    ['echo ok', 'allow'],
    ['rmdir x', 'allow'],
    ['echo rm', 'allow'],
    ['echo "unbalanced', 'ask'],
    ['eval "$X"', 'ask'],
    ['cat <<EOF\n$(id)\nEOF', 'ask'],
    ['$CMD x', 'ask'],
    ['echo rm x | bash', 'ask'],
    ['bash -c "$SCRIPT"', 'ask'],
  ])('deny Bash(rm:*) on %j → %s', async (command, expected) => {
    const s = await setup({ user: { permissions: { deny: ['Bash(rm:*)'] } }, mode: 'bypassPermissions' });
    expect(check(s, bash(command, s.project))).toBe(expected);
  });

  it('applies ask rules after deny rules, in every mode', async () => {
    const s = await setup({ user: { permissions: { deny: ['Bash(git push --force *)'], ask: ['Bash(git push *)'] } }, mode: 'bypassPermissions' });
    expect(check(s, bash('git push --force origin', s.project))).toBe('deny');
    expect(check(s, bash('git push origin main', s.project))).toBe('ask');
    expect(check(s, bash('cd x && echo "$(git push)"', s.project))).toBe('ask');
    expect(check(s, bash('git status', s.project))).toBe('allow');
  });

  it('matches a parameter rule and the ambiguous timeout command', async () => {
    const s = await setup({ user: { permissions: { deny: ['Bash(timeout:*)'] } }, mode: 'bypassPermissions' });
    // `timeout:*` is both a parameter rule (any timeout) and a `timeout` prefix rule: strict reading denies.
    expect(check(s, bash('echo hi', s.project))).toBe('deny');
  });

  it('allow rules approve only when every subcommand is approved', async () => {
    const s = await setup({ user: { permissions: { allow: ['Bash(npm run *)', 'Bash(git status)'] } } });
    expect(check(s, bash('npm run build', s.project))).toBe('allow');
    expect(check(s, bash('npm run build && git status', s.project))).toBe('allow');
    expect(check(s, bash('timeout 30 npm run test', s.project))).toBe('allow');
    expect(check(s, bash('npm run build && rm -rf x', s.project))).toBe('ask');
    expect(check(s, bash('NODE_ENV=x npm run build', s.project))).toBe('ask');
    expect(check(s, bash('sudo npm run build', s.project))).toBe('ask');
    expect(check(s, bash('npm install', s.project))).toBe('ask');
    expect(check(s, bash('npm run build > /tmp/out.log', s.project))).toBe('ask');
    expect(check(s, bash('npm run build > out.log', s.project))).toBe('allow');
  });

  it('says why an allow-all Bash rule did not approve a command that names files at run time', async () => {
    const s = await setup({ user: { permissions: { allow: ['Bash'] } } });
    expect(check(s, bash('wc -l src/a.ts', s.project))).toBe('allow');
    // A glob the rules would approve once its files are named literally gets the hint.
    for (const command of ['wc -l src/*', 'sort src/*.ts']) {
      const decision = s.adapter.checkStatic(bash(command, s.project), s.ctx, s.policy);
      expect(decision).toMatchObject({ kind: 'ask', reason: `Bash needs approval in default mode: ${RUNTIME_FILES_HINT}` });
    }
    // The rule approves literal files outside the working directories too, so a glob there gets the hint.
    const outside = s.adapter.checkStatic(bash('cat /etc/*.conf', s.project), s.ctx, s.policy);
    expect(outside).toMatchObject({ kind: 'ask', reason: `Bash needs approval in default mode: ${RUNTIME_FILES_HINT}` });
    // A substitution, or a glob climbing with `..`: naming the files would not help, so no hint.
    for (const command of ['head -c 9 src/$(ls src | head -1)', 'cat ../*']) {
      const decision = s.adapter.checkStatic(bash(command, s.project), s.ctx, s.policy);
      expect(decision.kind).not.toBe('allow');
      expect('reason' in decision ? decision.reason : '').not.toContain('name each file literally');
    }
    // Without files named at run time the reason stays as it was.
    const none = await setup({});
    expect(none.adapter.checkStatic(bash('wc -l src/a.ts', none.project), none.ctx, none.policy)).toEqual({ kind: 'ask', reason: 'Bash needs approval in default mode' });
    // No rule covers the command: the hint would not help either.
    expect(none.adapter.checkStatic(bash('cat src/*', none.project), none.ctx, none.policy)).toEqual({ kind: 'ask', reason: 'Bash needs approval in default mode' });
    // One subcommand no rule covers: naming the files leaves it denied.
    const catOnly = await setup({ user: { permissions: { allow: ['Bash(cat:*)'] } } });
    const mixed = catOnly.adapter.checkStatic(bash('cat src/* && node -v', catOnly.project), catOnly.ctx, catOnly.policy);
    expect('reason' in mixed ? mixed.reason : '').not.toContain('name each file literally');
    const catGlob = catOnly.adapter.checkStatic(bash('cat src/*', catOnly.project), catOnly.ctx, catOnly.policy);
    expect('reason' in catGlob ? catGlob.reason : '').toContain('name each file literally');
  });

  it('checks redirect and file-reader targets against Read/Edit rules', async () => {
    const s = await setup({ user: { permissions: { deny: ['Read(./.env)', 'Edit(./locked/**)'] } }, mode: 'bypassPermissions' });
    expect(check(s, bash('cat .env', s.project))).toBe('deny');
    expect(check(s, bash('wc -l < .env', s.project))).toBe('deny');
    expect(check(s, bash('echo x > .env', s.project))).toBe('deny'); // a Read deny also blocks writes
    expect(check(s, bash('echo x > locked/a.txt', s.project))).toBe('deny');
    expect(check(s, bash('echo x | tee locked/a.txt', s.project))).toBe('deny');
    expect(check(s, bash('echo x > "$OUT"', s.project))).toBe('ask');
    expect(check(s, bash('cd sub && cat .env', s.project))).toBe('ask');
    expect(check(s, bash('echo x > notes.txt', s.project))).toBe('allow');
    expect(check(s, bash('cat README.md 2>/dev/null', s.project))).toBe('allow');
  });

  it('treats every word after `--` as a file, even one that looks like an option or a count', async () => {
    const s = await setup({ user: { permissions: { deny: ['Read(./5)', 'Read(./-n)'] } }, mode: 'bypassPermissions' });
    expect(check(s, bash("head -n 5 a.txt", s.project))).toBe('allow'); // `5` is the count here
    expect(check(s, bash("cat -- '5'", s.project))).toBe('deny');
    expect(check(s, bash("wc -l -- a.txt '-n'", s.project))).toBe('deny');
  });

  it('matches Bash deny rules against the command as written and without the inserted `--`', async () => {
    const s = await setup({ user: { permissions: { deny: ['Bash(cat secret*)', 'Bash(wc -l [ab].log)'] } }, mode: 'bypassPermissions' });
    expect(check(s, bash("cat -- 'secret.txt'", s.project))).toBe('deny');
    // An expanded call: the expanded form escapes the rule written against the glob, the original does not.
    const expanded: PreparedCall = {
      id: 'c1',
      tool: 'bash',
      args: { command: "wc -l -- 'a.log'", timeoutMs: 120_000 },
      effect: { command: "wc -l -- 'a.log'", cwd: s.project, timeoutMs: 120_000, containment, expansion: { original: 'wc -l [ab].log', entries: [] } },
    };
    expect(check(s, expanded)).toBe('deny');
    expect(check(s, bash("wc -l -- 'a.log'", s.project))).toBe('allow');
  });
});

describe('path rules', () => {
  it('anchors //, ~/, /, ./ and bare patterns like gitignore', async () => {
    const s = await setup({
      project: { permissions: { deny: ['Read(./.env)', 'Edit(/src/generated/**)', 'Read(secrets/**)', 'Read(*.pem)'] } },
      user: { permissions: { deny: ['Read(~/notes/secret.txt)', 'Read(//etc/example-shadow)', 'Read(/private/**)'] } },
      mode: 'bypassPermissions',
    });
    const p = (rel: string): string => path.join(s.project, rel);
    expect(check(s, read(p('.env')))).toBe('deny');
    expect(check(s, read(p('sub/.env')))).toBe('allow'); // ./ is anchored
    expect(check(s, read(path.join(s.home, 'notes', 'secret.txt')))).toBe('deny');
    expect(check(s, read('/etc/example-shadow'))).toBe('deny');
    expect(check(s, write(p('src/generated/a.ts')))).toBe('deny');
    expect(check(s, edit(p('src/generated/deep/b.ts'), 'a', 'b'))).toBe('deny');
    expect(check(s, write(p('src/a.ts')))).toBe('allow');
    expect(check(s, write(p('vendor/src/generated/a.ts')))).toBe('allow');
    expect(check(s, read(p('a/b/secrets/key')))).toBe('deny'); // single-dir deny matches at any depth
    expect(check(s, read(p('certs/x.pem')))).toBe('deny'); // bare name: any depth
    expect(check(s, read(path.join(s.home, '.claude', 'private', 'x')))).toBe('deny'); // `/` in user settings → config dir
    expect(check(s, read(p('private/x')))).toBe('allow');
    expect(check(s, write(p('.env')))).toBe('deny'); // Read deny blocks Write
    expect(check(s, grep(p('a/secrets')))).toBe('deny'); // Read rules govern Grep
    expect(check(s, glob(p('secrets')))).toBe('deny'); // and Glob
    expect(check(s, grep(p('src')))).toBe('allow');
  });

  it.skipIf(!posix)('checks the real path, so a symlink cannot dodge a deny', async () => {
    const s = await setup({ project: { permissions: { deny: ['Read(./.env)'] } }, mode: 'bypassPermissions', files: { '.env': 'SECRET=1' } });
    await symlink(path.join(s.project, '.env'), path.join(s.project, 'innocent.txt'));
    const real = await realpath(path.join(s.project, 'innocent.txt'));
    expect(check(s, read(path.join(s.project, 'innocent.txt'), real))).toBe('deny');
  });

  it.skipIf(!posix)('applies a rule written through a symlinked directory to the real location', async () => {
    const s0 = await setup();
    const realDir = path.join(s0.base, 'real-secrets');
    await mkdir(realDir);
    await symlink(realDir, path.join(s0.base, 'alias'));
    const s = await setup({ user: { permissions: { deny: [`Read(/${path.join(s0.base, 'alias')}/**)`] } }, mode: 'bypassPermissions' });
    expect(check(s, read(path.join(realDir, 'k')))).toBe('deny');
  });

  it('allow rules need both the requested and the real path to match', async () => {
    const s = await setup({ user: { permissions: { allow: ['Read(//opt/shared/**)'] } } });
    expect(check(s, read('/opt/shared/a'))).toBe('allow');
    expect(check(s, read('/opt/shared/link', '/etc/passwd'))).toBe('ask');
  });
});

/**
 * Bash commands that name files outside the working directories. Each
 * expectation is a row measured against Claude Code 2.1.326 (`claude -p`,
 * default mode unless stated, no interactive channel).
 */
describe('Bash files outside the working directories (measured on the host)', () => {
  const outsideCommands = (out: string): string[] => [
    `mkdir -p ${out}/sub`,
    `touch ${out}/f.txt`,
    `echo x > ${out}/f.txt`,
    `cat > ${out}/f.mjs <<'EOF'\nconsole.log(1)\nEOF`,
    `mkdir -p ${out}/q && cat > ${out}/q/check.mjs <<'EOF'\nconsole.log(1)\nEOF`,
    `cp src.txt ${out}/f.txt`,
    `mv src.txt ${out}/f.txt`,
    `rm ${out}/f.txt`,
    `rm -rf ${out}/sub`,
    `sed -i 's/a/b/' ${out}/f.txt`,
    `cat ${out}/f.txt`,
  ];

  it('an allow-all Bash rule approves literal files outside, as the host does', async () => {
    const s = await setup({ user: { permissions: { allow: ['Bash'] } } });
    const out = shellPath(path.join(s.base, 'elsewhere'));
    for (const command of outsideCommands(out)) expect([command, check(s, bash(command, s.project))]).toEqual([command, 'allow']);
  });

  it('prefix rules and no rule still ask for files outside, as the host does', async () => {
    const prefix = await setup({ user: { permissions: { allow: ['mkdir', 'touch', 'echo', 'cat', 'cp', 'mv', 'rm', 'sed'].map((c) => `Bash(${c}:*)`) } } });
    const none = await setup({});
    for (const s of [prefix, none]) {
      for (const command of outsideCommands(path.join(s.base, 'elsewhere'))) expect([command, check(s, bash(command, s.project))]).toEqual([command, 'ask']);
    }
    expect(check(prefix, bash('touch inside.txt', prefix.project))).toBe('allow');
    expect(check(none, bash('touch inside.txt', none.project))).toBe('ask');
  });

  it('a deny rule still wins over the allow-all rule outside', async () => {
    const s = await setup({ user: { permissions: { allow: ['Bash'], deny: ['Bash(rm:*)'] } } });
    const out = shellPath(path.join(s.base, 'elsewhere'));
    expect(check(s, bash(`rm ${out}/f.txt`, s.project))).toBe('deny');
    expect(check(s, bash(`rm -rf ${out}/sub`, s.project))).toBe('deny');
    expect(check(s, bash(`touch ${out}/f.txt`, s.project))).toBe('allow');
  });

  it('stays stricter than the host where the target is only known at run time', async () => {
    // The host allows both; agent-code-mode cannot resolve the target statically.
    const s = await setup({ user: { permissions: { allow: ['Bash'] } } });
    const out = shellPath(path.join(s.base, 'elsewhere'));
    expect(check(s, bash(`d=${out}; touch $d/f.txt`, s.project))).toBe('ask');
    expect(check(s, bash(`cd ${out} && touch f.txt`, s.project))).toBe('ask');
  });

  const sensitive = [
    '.git/config', '.git/hooks/pre-commit', '.git/newfile', '.Git/config', 'sub/.git/config', '.claude/settings.json', '.claude/settings.local.json',
    '.claude/commands/x.md', '.claude/agents/x.md', '.claude/skills/x/SKILL.md', '.claude/hooks/x.sh', '.claude/other.txt', '.vscode/settings.json',
    '.idea/x.xml', '.husky/pre-commit', '.config/git/config', '.gitconfig', '.gitmodules', '.bashrc', 'sub/.bashrc', '.bash_profile', '.bash_login',
    '.bash_logout', '.zshrc', '.zprofile', '.zshenv', '.zlogin', '.profile', '.envrc', '.npmrc', '.ripgreprc', '.mcp.json', '.claude.json',
  ];
  const plain = ['.gitignore', '.gitattributes', '.env', '.ssh/authorized_keys', '.github/workflows/x.yml', '.gitlab-ci.yml', '.claude/worktrees/x',
    '.cursor/x', 'a.git/config', '.gitx/config', '.claude-x/f', '.tcshrc', '.cshrc', '.inputrc', '.config/fish/config.fish'];

  it('writing a sensitive file asks whatever allow rule covers the command, inside or outside', async () => {
    const s = await setup({ user: { permissions: { allow: ['Bash'] } } });
    const out = shellPath(path.join(s.base, 'elsewhere'));
    // The project's own settings, hooks, agents and .mcp.json are also paths agent-code-mode protects: refused.
    const protectedHere = new Set(['.claude/settings.json', '.claude/settings.local.json', '.claude/agents/x.md', '.claude/hooks/x.sh', '.mcp.json']);
    for (const rel of sensitive) {
      expect([rel, check(s, bash(`echo x > ${rel}`, s.project))]).toEqual([rel, protectedHere.has(rel) ? 'deny' : 'ask']);
      expect([rel, check(s, bash(`echo x > ${out}/${rel}`, s.project))]).toEqual([rel, 'ask']);
    }
    expect(check(s, bash(`echo x > ${out}/.git`, s.project))).toBe('ask');
    for (const command of ["sed -i 's/a/b/' .git/config", 'touch .git/x', 'rm .claude/other.txt']) expect([command, check(s, bash(command, s.project))]).toEqual([command, 'ask']);
    expect(check(s, bash('rm .claude/settings.json', s.project))).toBe('deny');
    for (const rel of plain) expect([rel, check(s, bash(`echo x > ${rel}`, s.project))]).toEqual([rel, 'allow']);
    // Reading one is fine.
    expect(check(s, bash('cat .git/config', s.project))).toBe('allow');
    // A prefix rule does not approve it either.
    const prefix = await setup({ user: { permissions: { allow: ['Bash(echo:*)'] } } });
    expect(check(prefix, bash('echo x > .git/config', prefix.project))).toBe('ask');
  });

  it('a path agent-code-mode protects is refused, even outside', async () => {
    const s = await setup({ user: { permissions: { allow: ['Bash'] } } });
    expect(check(s, bash(`touch ${shellPath(path.join(s.base, 'state', 'planted'))}`, s.project))).toBe('deny');
  });

  it('bypassPermissions writes sensitive files; dontAsk denies them', async () => {
    const bypass = await setup({ user: { permissions: { allow: ['Bash'] } }, mode: 'bypassPermissions' });
    expect(check(bypass, bash('echo x > .git/config', bypass.project))).toBe('allow');
    expect(check(bypass, bash(`echo x > ${shellPath(path.join(bypass.base, 'elsewhere'))}/.bashrc`, bypass.project))).toBe('allow');
    const dontAsk = await setup({ user: { permissions: { allow: ['Bash'] } }, mode: 'dontAsk' });
    expect(check(dontAsk, bash('echo x > .git/config', dontAsk.project))).toBe('deny');
  });

  it.skipIf(!posix)('a target named inside that resolves outside through a symlink asks; one named outside does not', async () => {
    const s = await setup({ user: { permissions: { allow: ['Bash'] } } });
    const out = shellPath(path.join(s.base, 'elsewhere'));
    await mkdir(path.join(out, '.claude'), { recursive: true });
    await writeFile(path.join(out, '.claude', 'settings.json'), '{}');
    await symlink(out, path.join(s.project, 'link'));
    await symlink(out, `${out}.lnk`);
    await symlink(path.join(out, '.claude', 'settings.json'), path.join(s.project, 'plain.json'));
    expect(check(s, bash('echo x > link/f.txt', s.project))).toBe('allow');
    expect(await authorize(s, bash('echo x > link/f.txt', s.project))).toMatchObject({ kind: 'ask', reason: expect.stringContaining('resolves through a symlink') });
    expect(await authorize(s, bash('echo x > plain.json', s.project))).toMatchObject({ kind: 'ask' });
    expect(await authorize(s, bash(`echo x > ${out}.lnk/f.txt`, s.project))).toEqual({ kind: 'allow' });
    // A prefix rule: the same symlink asks.
    const prefix = await setup({ user: { permissions: { allow: ['Bash(echo:*)'] } } });
    await symlink(out, path.join(prefix.project, 'link'));
    expect(await authorize(prefix, bash('echo x > link/f.txt', prefix.project))).toMatchObject({ kind: 'ask' });
    // Reading through it: the allow-all rule approves, a prefix rule asks.
    await writeFile(path.join(out, 'r.txt'), 'r');
    expect(await authorize(s, bash('cat link/r.txt', s.project))).toEqual({ kind: 'allow' });
    const catOnly = await setup({ user: { permissions: { allow: ['Bash(cat:*)'] } } });
    await symlink(out, path.join(catOnly.project, 'link'));
    expect(check(catOnly, bash('cat link/r.txt', catOnly.project))).toBe('allow');
    expect(await authorize(catOnly, bash('cat link/r.txt', catOnly.project))).toMatchObject({ kind: 'ask', reason: expect.stringContaining('resolves through a symlink') });
    // bypassPermissions follows the symlink without asking.
    const bypass = await setup({ user: { permissions: { allow: ['Bash'] } }, mode: 'bypassPermissions' });
    await symlink(out, path.join(bypass.project, 'link'));
    expect(await authorize(bypass, bash('echo x > link/f.txt', bypass.project))).toEqual({ kind: 'allow' });
  });
});

describe('which operands a bash command writes (review findings)', () => {
  it('a destination given with -t or --target-directory is a write', async () => {
    const s = await setup({ user: { permissions: { allow: ['Bash'] } } });
    for (const command of [
      'cp -t.git src.txt', 'cp --target-directory=.git src.txt', 'cp --target-directory .git src.txt', 'cp -t .git src.txt', 'cp -rt.git src.txt',
      'mv -t.git src.txt', 'mv -t .git src.txt', 'install -t.git src.txt', 'install -t .git src.txt', 'ln -s -t.git src.txt', 'ln -st .git src.txt',
    ]) {
      expect([command, check(s, bash(command, s.project))]).toEqual([command, 'ask']);
    }
  });

  it('every operand of cp, mv, install and ln counts as written, as the host checks them', async () => {
    // Measured: the host asks for `cp .git/config /tmp/x` (".git/config ... is a sensitive file").
    const s = await setup({ user: { permissions: { allow: ['Bash'] } } });
    const out = shellPath(path.join(s.base, 'elsewhere'));
    for (const command of [`cp .git/config ${out}/x`, `mv .git/config ${out}/x`, `cp ${out}/x .git/config`, `cp -t ${out} .git/config`, `ln .git/config ${out}/l`]) {
      expect([command, check(s, bash(command, s.project))]).toEqual([command, 'ask']);
    }
    // An option value that is not a target directory is not a file.
    expect(check(s, bash(`cp --suffix=.git src.txt ${out}/x`, s.project))).toBe('allow');
    expect(check(s, bash(`install -m 644 src.txt ${out}/x`, s.project))).toBe('allow');
  });

  it('dd writes only of=, and the sed script is not a file it writes', async () => {
    const s = await setup({ user: { permissions: { allow: ['Bash'] } } });
    expect(check(s, bash('dd if=.git/config of=copy.txt', s.project))).toBe('allow');
    expect(check(s, bash('dd if=src.txt of=.git/x', s.project))).toBe('ask');
    expect(check(s, bash("sed -i 's/.git/x/' src.txt", s.project))).toBe('allow');
    expect(check(s, bash("sed -i.bak 's/a/b/' .git/config", s.project))).toBe('ask');
    expect(check(s, bash("sed -i -e 's/a/b/' .git/config", s.project))).toBe('ask');
    expect(check(s, bash("sed -i -e 's/.git/x/' src.txt", s.project))).toBe('allow');
    expect(check(s, bash('echo x | tee -a .git/x', s.project))).toBe('ask');
  });

  it.skipIf(!posix)('a write through a symlink whose target misses several parents resolves outside and asks', async () => {
    const s = await setup({ user: { permissions: { allow: ['Bash'] } } });
    const out = shellPath(path.join(s.base, 'elsewhere'));
    await mkdir(out, { recursive: true });
    await symlink(path.join(out, 'a', 'b', 'c'), path.join(s.project, 'deep'));
    for (const command of ['echo x > deep/f', 'mkdir -p deep/x/y', 'touch deep/x/y/z']) {
      expect([command, check(s, bash(command, s.project))]).toEqual([command, 'allow']);
      expect([command, await authorize(s, bash(command, s.project))]).toMatchObject([command, { kind: 'ask', reason: expect.stringContaining('resolves through a symlink') }]);
    }
    // A sensitive directory reached through a symlinked parent several levels down.
    await symlink(path.join(out, 'repo'), path.join(s.project, 'repo-link'));
    expect(await authorize(s, bash('mkdir -p repo-link/.git/hooks', s.project))).toMatchObject({ kind: 'ask' });
    await mkdir(path.join(s.project, '.git'), { recursive: true });
    await symlink(path.join(s.project, '.git'), path.join(s.project, 'gitlink'));
    expect(await authorize(s, bash('echo x > gitlink/new/deeper/f', s.project))).toMatchObject({ kind: 'ask', reason: expect.stringContaining('sensitive') });
  });
});

describe('second review findings (oracle: the host truth table)', () => {
  it('sed in-place with a script file whose name looks like a number still writes its operands', async () => {
    const s = await setup({ user: { permissions: { allow: ['Bash'] } } });
    for (const command of ['sed -i -f 1 .git/config', 'sed -i -l 5 -e s/a/b/ .git/config', 'sed -n -i -e s/a/b/ .git/config', 'sed --in-pl s/a/b/ .git/config',
      'sed --in-place=.bak -e s/a/b/ .git/config', 'sed -i --expr=s/a/b/ .git/config', 'sed -i --fi script.sed .git/config', 'sed -i -fscript.sed .git/config', 'sed -i -e s/a/b/ -- .git/config']) {
      expect([command, check(s, bash(command, s.project))]).toEqual([command, 'ask']);
    }
    // The script itself, given by option or first, is not written; a line length is not a file.
    for (const command of ["sed -i --expr='s/.git/x/' src.txt", 'sed -i -l 5 s/.git/x/ src.txt', 'sed -i -f .git/script.sed src.txt']) {
      expect([command, check(s, bash(command, s.project))]).toEqual([command, 'allow']);
    }
  });

  it.skipIf(!posix)('`..` after a symlink climbs from where the link points, as the kernel does', async () => {
    const s = await setup({ user: { permissions: { allow: ['Bash'] } } });
    const out = shellPath(path.join(s.base, 'elsewhere'));
    await mkdir(path.join(out, 'child'), { recursive: true });
    await symlink(path.join(out, 'child'), path.join(s.project, 'link'));
    // Host rows rDotDot1 and rDotDot3: named inside (lexically), real path outside.
    await mkdir(path.join(out, 'a', 'child'), { recursive: true });
    await symlink(path.join(out, 'a', 'child'), path.join(s.project, 'link2'));
    for (const command of ['echo x > link/../f', 'echo x > link2/../../project/f2', 'mkdir -p link/../new/dir']) {
      expect([command, await authorize(s, bash(command, s.project))]).toMatchObject([command, { kind: 'ask', reason: expect.stringContaining('resolves through a symlink') }]);
    }
    // Host row rDotDot2: named outside already, so allowed like any literal path outside.
    expect(await authorize(s, bash('echo x > link/../../elsewhere/f', s.project))).toEqual({ kind: 'allow' });
    // Without a symlink, `..` stays where it is written.
    await mkdir(path.join(s.project, 'plain'));
    expect(await authorize(s, bash('echo x > plain/../f', s.project))).toEqual({ kind: 'allow' });
  });

  it('a unique prefix of --target-directory is the destination (acm keeps asking for writes the host parser misses)', async () => {
    const s = await setup({ user: { permissions: { allow: ['Bash'] } } });
    for (const command of ['cp --target-dir=.git src.txt', 'cp --target=.git src.txt', 'cp --t=.git src.txt', 'mv --target-dir=.git src.txt', 'install --target-dir .git src.txt',
      'ln -s --target-dir=.git src.txt']) {
      expect([command, check(s, bash(command, s.project))]).toEqual([command, 'ask']);
    }
  });

  it('a path agent-code-mode protects is refused in every mode, as write and edit are', async () => {
    for (const mode of ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'dontAsk', 'plan']) {
      const s = await setup({ user: { permissions: { allow: ['Bash'] } }, mode });
      const state = shellPath(path.join(s.base, 'state'));
      for (const command of [`touch ${state}/planted`, `echo x > ${state}/planted`, `echo '{}' > ${shellPath(path.join(s.home, '.claude', 'settings.json'))}`, 'echo x > .mcp.json']) {
        expect([mode, command, s.adapter.checkStatic(bash(command, s.project), s.ctx, s.policy)]).toMatchObject([mode, command, { kind: 'deny', reason: expect.stringContaining('protected host policy path') }]);
      }
    }
  });

  it.skipIf(!posix)('a protected path reached through a symlink is refused in every mode', async () => {
    for (const mode of ['default', 'bypassPermissions', 'auto']) {
      const s = await setup({ user: { permissions: { allow: ['Bash'] } }, mode });
      await mkdir(path.join(s.base, 'state'), { recursive: true });
      await symlink(path.join(s.base, 'state'), path.join(s.project, 'st'));
      expect([mode, await authorize(s, bash('touch st/planted', s.project))]).toMatchObject([mode, { kind: 'deny' }]);
    }
  });

  it('the target of a symbolic ln is not written; the link name, a hard link and the -t directory are', async () => {
    const s = await setup({ user: { permissions: { allow: ['Bash'] } } });
    // Host row rSymParent: allowed.
    expect(check(s, bash('ln -s .git gitlink && echo x > gitlink/x', s.project))).toBe('allow');
    expect(check(s, bash('ln --symbolic .git/config cfg', s.project))).toBe('allow');
    expect(check(s, bash('ln -sf .git/config cfg', s.project))).toBe('allow');
    // Not measured on the host: kept as before.
    for (const command of ['ln .git/config cfg', 'ln -s src.txt .git/hooks/pre-commit', 'ln -s -t .git src.txt', 'ln -s .git']) {
      expect([command, check(s, bash(command, s.project))]).toEqual([command, 'ask']);
    }
  });
});

describe('third review findings: misread options over-approximate in the safe direction', () => {
  const tools = ['cp', 'mv', 'install', 'ln'];

  it('every -t value is a destination, never last-wins, even after an option of unknown arity', async () => {
    const s = await setup({ user: { permissions: { allow: ['Bash'] } } });
    const state = shellPath(path.join(s.base, 'state'));
    for (const tool of tools) {
      for (const command of [`${tool} -t .git --suffix -tplain src.txt`, `${tool} -t .git -t plain src.txt`, `${tool} --target-dir=.git --target-directory plain src.txt`]) {
        expect([command, check(s, bash(command, s.project))]).toEqual([command, 'ask']);
      }
      const command = `${tool} -t ${state} --suffix -tplain src.txt`;
      expect([command, check(s, bash(command, s.project))]).toEqual([command, 'deny']);
    }
  });

  it('ln is taken as symbolic only when the parse is unambiguous', async () => {
    const s = await setup({ user: { permissions: { allow: ['Bash'], deny: ['Edit(./locked/**)'] } } });
    // `--suffix` takes `-s`: a hard link.
    expect(check(s, bash('ln --suffix -s locked/f copy', s.project))).toBe('deny');
    expect(check(s, bash('ln --suffix -s .git/config copy', s.project))).toBe('ask');
    expect(check(s, bash('ln --suf -s .git/config copy', s.project))).not.toBe('allow');
    expect(check(s, bash('ln --frobnicate -s .git/config copy', s.project))).not.toBe('allow');
    expect(check(s, bash('ln -S -s .git/config copy', s.project))).not.toBe('allow');
    // Unambiguous symbolic links keep the oracle exception (host row rSymParent).
    expect(check(s, bash('ln -s .git/config copy', s.project))).toBe('allow');
    expect(check(s, bash('ln -sf --symbolic .git/config copy', s.project))).toBe('allow');
    expect(check(s, bash('ln --backup=none -s .git/config copy', s.project))).toBe('allow');
    // A numbered backup of `copy`: its name is not known, so no rule approves.
    expect(check(s, bash('ln --backup=numbered -s .git/config copy', s.project))).toBe('ask');
  });

  it('sed -i with a suffix writes the backup GNU sed makes', async () => {
    const s = await setup({ user: { permissions: { allow: ['Bash'] } } });
    for (const command of ["sed -i'.git/*' 's/a/b/' src.txt", "sed --in-place='.git/*' 's/a/b/' src.txt", "sed -i'.git/bak-*' -e 's/a/b/' sub/src.txt", "sed -i'/.bashrc' 's/a/b/' src.txt"]) {
      expect([command, check(s, bash(command, s.project))]).toEqual([command, 'ask']);
    }
    for (const mode of ['default', 'auto', 'bypassPermissions']) {
      const m = await setup({ user: { permissions: { allow: ['Bash'] } }, mode });
      for (const command of [`sed -i'../state/*' 's/a/b/' src.txt`, `sed -i'${shellPath(path.join(m.base, 'state'))}/*' 's/a/b/' src.txt`]) {
        expect([mode, command, check(m, bash(command, m.project))]).toEqual([mode, command, 'deny']);
      }
    }
    // A plain suffix next to the file stays allowed.
    expect(check(s, bash("sed -i.bak 's/a/b/' src.txt", s.project))).toBe('allow');
    expect(check(s, bash("sed -i'bak-*' 's/a/b/' src.txt", s.project))).toBe('allow');
    // GNU sed 4.9 replaces `*` with the name as written: `*` on `<state>/x` renames to `<state>/x` itself.
    expect(check(s, bash("sed -i'.git/*' 's/a/b/' sub/src.txt", s.project))).toBe('ask');
    expect(check(s, bash(`sed -i'*' 's/a/b/' ${shellPath(path.join(s.base, 'state'))}/x`, s.project))).toBe('deny');
  });

  it.skipIf(!posix)('a backslash in a command path or a rule is a file name character on POSIX', async () => {
    const s = await setup({ user: { permissions: { allow: ['Bash'], deny: ['Edit(./locked/**)', 'Edit(./a\\b)'] } } });
    // `locked/x\..\..\f` is one file name inside locked/ on POSIX, not a climb out of it.
    expect(check(s, bash("echo x > 'locked/x\\..\\..\\f'", s.project))).toBe('deny');
    expect(check(s, bash("echo x > 'a\\b'", s.project))).toBe('deny');
    expect(check(s, bash("echo x > 'a\\c'", s.project))).toBe('allow');
  });

  it.skipIf(!posix)('a backslash in a symlink target is a file name character on POSIX', async () => {
    for (const mode of ['default', 'auto', 'bypassPermissions']) {
      const s = await setup({ user: { permissions: { allow: ['Bash'] } }, mode });
      const state = shellPath(path.join(s.base, 'state'));
      await mkdir(state, { recursive: true });
      // As reported: alias -> back\slash -> ../state, both in the workspace.
      await symlink('../state', path.join(s.project, 'back\\slash'));
      await symlink('back\\slash', path.join(s.project, 'alias'));
      expect([mode, await authorize(s, bash('echo x > alias/f', s.project))]).toMatchObject([mode, { kind: 'deny' }]);
    }
  });
});

describe('fourth review findings', () => {
  const kind = (s: Setup, command: string): Decision['kind'] => check(s, bash(command, s.project));

  it('a destination directory makes <dir>/<basename(source)> a written target', async () => {
    for (const mode of ['default', 'auto', 'bypassPermissions']) {
      const s = await setup({ user: { permissions: { allow: ['Bash'] } }, mode });
      for (const command of ['ln -s settings.json .claude/', 'ln -s settings.json .claude', 'cp settings.json .claude', 'mv x/settings.json .claude/', 'install settings.json .claude',
        'cp a.txt settings.json .claude', 'ln -s ../x/settings.json -t .claude', 'cp --target-directory=.claude settings.json']) {
        expect([mode, command, kind(s, command)]).toEqual([mode, command, 'deny']);
      }
    }
    const d = await setup({ user: { permissions: { allow: ['Bash'], deny: ['Edit(./plain/.bashrc)'] } } });
    for (const command of ['ln -s .bashrc plain/', 'ln -s .bashrc plain', 'cp .bashrc plain', 'ln -s a .bashrc plain']) expect([command, kind(d, command)]).toEqual([command, 'deny']);
    // A trailing slash or several sources: certainly a directory, so a sensitive generated name asks.
    const plain = await setup({ user: { permissions: { allow: ['Bash'] } } });
    for (const command of ['ln -s .git plain/', 'ln -s .bashrc plain/', 'ln -s .git .bashrc plain/', 'cp a .bashrc plain']) expect([command, kind(plain, command)]).toEqual([command, 'ask']);
    // Host row rSymParent: `gitlink` is not a directory, so `gitlink/.git` is not written.
    expect(kind(d, 'ln -s .git gitlink && echo x > gitlink/x')).toBe('allow');
    expect(await authorize(d, bash('ln -s .git gitlink && echo x > gitlink/x', d.project))).toEqual({ kind: 'allow' });
  });

  it('an existing directory at check time is a destination directory for the host-sensitive check too', async () => {
    const s = await setup({ user: { permissions: { allow: ['Bash'] } } });
    await mkdir(path.join(s.project, 'plain'));
    expect(kind(s, 'ln -s .bashrc plain')).toBe('allow');
    expect(await authorize(s, bash('ln -s .bashrc plain', s.project))).toMatchObject({ kind: 'ask', reason: expect.stringContaining('sensitive') });
    expect(await authorize(s, bash('ln -s .bashrc notadir', s.project))).toEqual({ kind: 'allow' });
  });

  it('backups (-b, --backup, -S, --suffix) are written targets', async () => {
    for (const mode of ['default', 'auto', 'bypassPermissions']) {
      const s = await setup({ user: { permissions: { allow: ['Bash'] } }, mode });
      for (const command of ['cp --backup=simple --suffix=.json src.txt .claude/settings', 'mv -b -S .json src.txt .claude/settings', 'install --backup=simple -S .json src.txt .claude/settings',
        'ln -f -b --suffix=.json src.txt .claude/settings', 'cp --backup=simple --suffix=.json settings src.txt .claude/', 'cp -S .json src.txt .claude/settings']) {
        expect([mode, command, kind(s, command)]).toEqual([mode, command, 'deny']);
      }
    }
    const s = await setup({ user: { permissions: { allow: ['Bash'] } } });
    // The default `~` suffix, or a numbered backup: the name depends on the environment or on what exists, so no rule approves.
    for (const command of ['cp -b src.txt dst.txt', 'cp --backup=numbered src.txt dst.txt', 'cp --backup src.txt dst.txt', 'mv --backup=existing a b']) {
      expect([command, kind(s, command)]).toEqual([command, 'ask']);
    }
    expect(kind(s, 'cp --backup=simple -S .bak src.txt dst.txt')).toBe('allow');
    // `none`/`off` disable backups even with a suffix (GNU makes none).
    for (const mode of ['default', 'bypassPermissions']) {
      const m = await setup({ user: { permissions: { allow: ['Bash'] } }, mode });
      for (const tool of ['cp', 'mv', 'install', 'ln']) {
        for (const control of ['none', 'off']) {
          const command = `${tool} --backup=${control} --suffix=.json src.txt .claude/settings`;
          expect([mode, command, kind(m, command)]).toEqual([mode, command, mode === 'default' ? 'ask' : 'allow']);
        }
      }
    }
    expect(kind(s, 'cp --backup=none src.txt dst.txt')).toBe('allow');
  });

  it.skipIf(!posix)('a backslash in a written path is a file name character for the protected patterns on POSIX', async () => {
    for (const mode of ['default', 'auto', 'bypassPermissions']) {
      const s = await setup({ user: { permissions: { allow: ['Bash'] } }, mode });
      expect([mode, kind(s, "echo x > '.claude/settings\\extra.json'")]).toEqual([mode, 'deny']);
    }
  });

  it('a protected write is denied before any ask rule, in every mode', async () => {
    for (const mode of ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk']) {
      const s = await setup({ user: { permissions: { allow: ['Bash'], ask: ['Bash'] } }, mode });
      expect([mode, s.adapter.checkStatic(bash('echo x > ../state/f', s.project), s.ctx, s.policy)]).toMatchObject([mode, { kind: 'deny', reason: expect.stringContaining('protected') }]);
    }
  });

  it.skipIf(!posix)('a protected write through a symlink is denied before any ask rule', async () => {
    const s = await setup({ user: { permissions: { allow: ['Bash'], ask: ['Bash(echo:*)'] } } });
    await mkdir(path.join(s.base, 'state'), { recursive: true });
    await symlink(path.join(s.base, 'state'), path.join(s.project, 'alias'));
    expect(s.adapter.checkStatic(bash('echo x > alias/f', s.project), s.ctx, s.policy).kind).toBe('ask');
    // The dispatcher runs checkResolved before checkStatic: the deny wins over the ask rule.
    expect(await s.adapter.checkResolved(bash('echo x > alias/f', s.project), s.ctx, s.policy)).toMatchObject({ kind: 'deny', reason: expect.stringContaining('protected') });
    expect(await authorize(s, bash('echo x > alias/f', s.project))).toMatchObject({ kind: 'deny', reason: expect.stringContaining('protected') });
  });
});

describe('protected paths on Windows (win32 semantics, on any OS)', () => {
  it('a command target in POSIX form matches the native protected patterns', () => {
    const patterns = ['C:\\Users\\a\\state\\**', 'C:\\Users\\a\\proj\\.claude\\settings*.json'];
    for (const target of ['/c/Users/a/state/planted', '/c/users/A/STATE/x', '/c/Users/a/proj/.claude/settings.json', '/c/Users/a/proj/.claude/settings.local.json']) {
      expect([target, protectedPathHit(target, patterns, 'win32')]).toEqual([target, expect.any(String)]);
      // The comparison it replaced never matched: native pattern against a POSIX-form path.
      expect(findMatchingPattern(target, patterns, true)).toBeUndefined();
    }
    expect(protectedPathHit('/c/Users/a/proj/src/x.ts', patterns, 'win32')).toBeUndefined();
    expect(protectedPathHit('/d/Users/a/state/x', patterns, 'win32')).toBeUndefined();
  });
});

describe('permission modes (no rule matches)', () => {
  const cases: Record<string, Record<string, Decision['kind']>> = {
    default: { readIn: 'allow', readOut: 'ask', writeIn: 'ask', writeOut: 'ask', editIn: 'ask', bash: 'ask', grepIn: 'allow', globIn: 'allow' },
    acceptEdits: { readIn: 'allow', readOut: 'ask', writeIn: 'allow', writeOut: 'ask', editIn: 'allow', bash: 'ask', grepIn: 'allow', globIn: 'allow' },
    plan: { readIn: 'allow', readOut: 'ask', writeIn: 'deny', writeOut: 'deny', editIn: 'deny', bash: 'deny', grepIn: 'allow', globIn: 'allow' },
    dontAsk: { readIn: 'allow', readOut: 'deny', writeIn: 'deny', writeOut: 'deny', editIn: 'deny', bash: 'deny', grepIn: 'allow', globIn: 'allow' },
    auto: { readIn: 'allow', readOut: 'allow', writeIn: 'allow', writeOut: 'allow', editIn: 'allow', bash: 'allow', grepIn: 'allow', globIn: 'allow' },
    bypassPermissions: { readIn: 'allow', readOut: 'allow', writeIn: 'allow', writeOut: 'allow', editIn: 'allow', bash: 'allow', grepIn: 'allow', globIn: 'allow' },
    'not-a-mode': { readIn: 'allow', readOut: 'ask', writeIn: 'ask', writeOut: 'ask', editIn: 'ask', bash: 'ask', grepIn: 'allow', globIn: 'allow' },
  };
  for (const [mode, expected] of Object.entries(cases)) {
    it(`${mode}`, async () => {
      const s = await setup({ mode });
      const inside = path.join(s.project, 'a.ts');
      const outside = path.join(s.base, 'elsewhere', 'b.ts');
      const got = {
        readIn: check(s, read(inside)),
        readOut: check(s, read(outside)),
        writeIn: check(s, write(inside)),
        writeOut: check(s, write(outside)),
        editIn: check(s, edit(inside, 'a', 'b')),
        bash: check(s, bash('ls', s.project)),
        grepIn: check(s, grep(s.project)),
        globIn: check(s, glob(s.project)),
      };
      expect(got).toEqual(expected);
    });
  }

  it('ask rules still ask in bypassPermissions and deny in dontAsk', async () => {
    const ask = { user: { permissions: { ask: ['Read(./a.ts)'] } } };
    const bypass = await setup({ ...ask, mode: 'bypassPermissions' });
    expect(check(bypass, read(path.join(bypass.project, 'a.ts')))).toBe('ask');
    const dontAsk = await setup({ ...ask, mode: 'dontAsk' });
    expect(check(dontAsk, read(path.join(dontAsk.project, 'a.ts')))).toBe('deny');
  });

  it('takes the mode from the companion hook, else the CLI flag, else settings defaultMode', async () => {
    const fromFlag = await setup({ argv: ['--permission-mode', 'acceptEdits'], user: { permissions: { defaultMode: 'plan' } } });
    expect(check(fromFlag, write(path.join(fromFlag.project, 'a.ts')))).toBe('allow');
    const fromSettings = await setup({ user: { permissions: { defaultMode: 'plan' } } });
    expect(check(fromSettings, write(path.join(fromSettings.project, 'a.ts')))).toBe('deny');
    const fromCtx = await setup({ mode: 'bypassPermissions', argv: ['--permission-mode', 'plan'] });
    expect(check(fromCtx, bash('ls', fromCtx.project))).toBe('allow');
    const locked = await setup({ mode: 'bypassPermissions', user: { permissions: { disableBypassPermissionsMode: 'disable' } } });
    expect(check(locked, bash('ls', locked.project))).toBe('ask');
  });

  it('additionalDirectories count as working directories', async () => {
    const s = await setup({ user: { permissions: { additionalDirectories: ['~/shared'] } } });
    expect(check(s, read(path.join(s.home, 'shared', 'x')))).toBe('allow');
  });
});

describe.skipIf(!posix)('PreToolUse hooks', () => {
  const anyBash = (s: Setup): PreparedCall => bash('ls -la', s.project);

  it('exit 2 denies with stderr as the reason', async () => {
    const s = await setup({ user: preHooks('Bash', exampleHook('exit2')) });
    expect(await authorize(s, anyBash(s))).toEqual({ kind: 'deny', source: 'hook', reason: 'blocked by example hook' });
  });

  it('a shell-form hook script denies', async () => {
    const s = await setup({ user: preHooks('Bash', { type: 'command', command: `"${path.join(FIXTURES, 'deny-rm.sh')}"` }) });
    expect(await authorize(s, bash('rm -rf build', s.project))).toMatchObject({ kind: 'deny', source: 'hook', reason: 'rm is not allowed' });
    expect(await authorize(s, bash('ls', s.project))).toEqual({ kind: 'allow' });
  });

  it.each([
    ['deny', { kind: 'deny', source: 'hook' }],
    ['legacy-block', { kind: 'deny', source: 'hook', reason: 'legacy block' }],
    ['stop', { kind: 'deny', source: 'hook', reason: 'stop requested' }],
    ['ask', { kind: 'ask' }],
    ['defer', { kind: 'ask' }],
    ['allow', { kind: 'allow' }],
    ['empty', { kind: 'allow' }],
    ['exit1', { kind: 'deny', source: 'hook-error' }],
    ['crash', { kind: 'deny', source: 'hook-error' }],
    ['invalid', { kind: 'deny', source: 'hook-error' }],
    ['bad-decision', { kind: 'deny', source: 'hook-error' }],
  ])('JSON/exit behavior %s', async (mode, expected) => {
    const s = await setup({ user: preHooks('Bash', exampleHook(mode)) });
    expect(await authorize(s, anyBash(s))).toMatchObject(expected);
  });

  it('a hook that cannot start denies', async () => {
    const s = await setup({ user: preHooks('Bash', { type: 'command', command: path.join(s0Dir(), 'missing-hook.sh') }) });
    expect(await authorize(s, anyBash(s))).toMatchObject({ kind: 'deny', source: 'hook-error' });
  });

  it('honors onFailure: continue', async () => {
    const s = await setup({ user: preHooks('Bash', exampleHook('crash', undefined, { onFailure: 'continue' })) });
    expect(await authorize(s, anyBash(s))).toEqual({ kind: 'allow' });
  });

  it('times out, kills the hook and denies with hook-timeout', async () => {
    const pidFile = path.join(os.tmpdir(), `acm-hook-pid-${process.pid}-${Date.now()}`);
    const s = await setup({ user: preHooks('Bash', { type: 'command', command: `echo $$ > "${pidFile}"; exec sleep 30`, timeout: 0.5 }) });
    const started = Date.now();
    const decision = await authorize(s, anyBash(s));
    expect(decision).toMatchObject({ kind: 'deny', source: 'hook-timeout' });
    expect(Date.now() - started).toBeLessThan(5_000);
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    await new Promise((r) => setTimeout(r, 100));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('rewrites the call with updatedInput (mapped back to binding args)', async () => {
    const s = await setup({ user: preHooks('Bash', exampleHook('update', JSON.stringify({ command: 'echo safe', timeout: 5000 }))) });
    expect(await authorize(s, anyBash(s))).toEqual({
      kind: 'allow',
      reason: 'example allow',
      updatedArgs: { command: 'echo safe', cwd: s.project, timeoutMs: 5000 },
    });
    const w = await setup({ user: preHooks('Write', exampleHook('update-only', JSON.stringify({ file_path: '/x/y', content: 'clean' }))) });
    expect(await authorize(w, write(path.join(w.project, 'a')))).toMatchObject({ kind: 'allow', updatedArgs: { path: '/x/y', content: 'clean' } });
    const bad = await setup({ user: preHooks('Bash', exampleHook('update', JSON.stringify({ command: 'ls', run_in_background: true }))) });
    expect(await authorize(bad, anyBash(bad))).toMatchObject({ kind: 'deny', source: 'hook' });
  });

  it('matches tool names exactly or by regex', async () => {
    const exact = await setup({ user: preHooks('Edit|Write', exampleHook('deny')) });
    expect((await authorize(exact, write(path.join(exact.project, 'a')))).kind).toBe('deny');
    expect((await authorize(exact, read(path.join(exact.project, 'a')))).kind).toBe('allow');
    const partial = await setup({ user: preHooks('Bas', exampleHook('deny')) });
    expect((await authorize(partial, anyBash(partial))).kind).toBe('allow');
    const regex = await setup({ user: preHooks('^(Bash|Read)$', exampleHook('deny')) });
    expect((await authorize(regex, read(path.join(regex.project, 'a')))).kind).toBe('deny');
    expect((await authorize(regex, glob(regex.project))).kind).toBe('allow');
    const all = await setup({ user: preHooks('*', exampleHook('deny')) });
    expect((await authorize(all, grep(all.project))).kind).toBe('deny');
  });

  it('combines parallel hooks: deny > ask > allow; two updatedInputs are refused', async () => {
    const denyWins = await setup({ user: preHooks('Bash', exampleHook('allow'), exampleHook('deny'), exampleHook('ask')) });
    expect((await authorize(denyWins, anyBash(denyWins))).kind).toBe('deny');
    const askWins = await setup({ user: preHooks('Bash', exampleHook('allow'), exampleHook('ask')) });
    expect((await authorize(askWins, anyBash(askWins))).kind).toBe('ask');
    const twoUpdates = await setup({
      user: preHooks('Bash', exampleHook('update', JSON.stringify({ command: 'a' })), exampleHook('update', JSON.stringify({ command: 'b' }))),
    });
    expect(await authorize(twoUpdates, anyBash(twoUpdates))).toMatchObject({ kind: 'deny', source: 'unsupported-config' });
    const started = Date.now();
    const slow = await setup({ user: preHooks('Bash', exampleHook('sleep', '600'), exampleHook('sleep', '600'), exampleHook('sleep', '600')) });
    expect((await authorize(slow, anyBash(slow))).kind).toBe('allow');
    expect(Date.now() - started).toBeLessThan(1_700); // ran in parallel, not 1.8 s in sequence
  });

  it('merges hooks from every source and runs a duplicate once', async () => {
    const record = path.join(os.tmpdir(), `acm-dup-${process.pid}-${Date.now()}`);
    const hook = { type: 'command', command: `echo run >> "${record}"` };
    const s = await setup({ user: preHooks('Bash', hook), project: preHooks('Bash', hook) });
    await authorize(s, anyBash(s));
    expect((await readFile(record, 'utf8')).trim().split('\n')).toEqual(['run']);
  });

  it('disableAllHooks turns hooks off', async () => {
    const s = await setup({ user: preHooks('Bash', exampleHook('deny')), project: { disableAllHooks: true } });
    expect((await authorize(s, anyBash(s))).kind).toBe('allow');
  });

  it('a hook type it cannot evaluate denies matching calls with unsupported-config', async () => {
    const s = await setup({ user: preHooks('Bash', { type: 'prompt', prompt: 'Is this safe? $ARGUMENTS' }) });
    expect(await authorize(s, anyBash(s))).toMatchObject({ kind: 'deny', source: 'unsupported-config' });
    expect((await authorize(s, read(path.join(s.project, 'a')))).kind).toBe('allow'); // matcher does not match
    const weird = await setup({ user: preHooks('Bash', { type: 'teleport' }) });
    expect(await authorize(weird, anyBash(weird))).toMatchObject({ kind: 'deny', source: 'unsupported-config' });
  });

  it('honors the `if` filter', async () => {
    const s = await setup({ user: preHooks('Bash', exampleHook('deny', undefined, { if: 'Bash(git push *)' })) });
    expect((await authorize(s, bash('git status', s.project))).kind).toBe('allow');
    expect((await authorize(s, bash('npm test && git push origin', s.project))).kind).toBe('deny');
    expect((await authorize(s, bash('echo $(date)', s.project))).kind).toBe('deny'); // dynamic: runs anyway
  });

  it('exec form substitutes ${CLAUDE_PROJECT_DIR} and exports it', async () => {
    const s = await setup({ files: { '.claude/hooks/check.mjs': "process.stderr.write(process.env.CLAUDE_PROJECT_DIR + '|' + process.argv[2]); process.exit(2);" } });
    const s2 = await setup({ user: preHooks('Bash', { type: 'command', command: process.execPath, args: [`${s.project}/.claude/hooks/check.mjs`, '${CLAUDE_PROJECT_DIR}'] }) });
    const d = await authorize(s2, anyBash(s2));
    expect(d).toEqual({ kind: 'deny', source: 'hook', reason: `${s2.project}|${s2.project}` });
  });

  it('runs hooks of enabled plugins', async () => {
    const s0 = await setup();
    const pluginRoot = path.join(s0.base, 'plugin');
    await mkdir(path.join(pluginRoot, 'hooks'), { recursive: true });
    await writeFile(path.join(pluginRoot, 'hooks', 'hooks.json'), JSON.stringify(preHooks('Bash', exampleHook('deny'))));
    const configDir = path.join(s0.base, 'config');
    await mkdir(path.join(configDir, 'plugins'), { recursive: true });
    await writeFile(path.join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'guard@example': [{ installPath: pluginRoot }] } }));
    await writeFile(path.join(configDir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'guard@example': true } }));
    const s = await setup({ env: { CLAUDE_CONFIG_DIR: configDir } });
    expect(await authorize(s, anyBash(s))).toMatchObject({ kind: 'deny', source: 'hook' });
  });

  it('sends the exact native payload (byte-identical command)', async () => {
    const out = path.join(os.tmpdir(), `acm-payload-${process.pid}-${Date.now()}.json`);
    const s = await setup({ user: preHooks('*', exampleHook('record', out)) });
    const command = 'printf "%s" \'héllo "wörld"\' && echo ✓\nline two\t$HOME \\n';
    expect((await authorize(s, bash(command, path.join(s.project, 'sub')))).kind).toBe('allow');
    const payload: unknown = JSON.parse(await readFile(out, 'utf8'));
    expect(payload).toEqual({
      session_id: 'session-1',
      transcript_path: path.join(s.base, 't.jsonl'),
      cwd: path.join(s.project, 'sub'),
      permission_mode: 'default',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command, timeout: 120_000, description: 'agent-code-mode script call c1', run_in_background: false },
      tool_use_id: 'toolu_1/c1',
    });

    await authorize(s, edit(path.join(s.project, 'a.ts'), '  const a = 1;', 'const a = 2;'));
    expect(JSON.parse(await readFile(out, 'utf8'))).toMatchObject({
      tool_name: 'Edit',
      tool_input: { file_path: path.join(s.project, 'a.ts'), old_string: '  const a = 1;', new_string: 'const a = 2;', replace_all: false },
    });
    await authorize(s, grep(s.project));
    expect(JSON.parse(await readFile(out, 'utf8'))).toMatchObject({
      tool_name: 'Grep',
      tool_input: { pattern: 'x', path: s.project, glob: '*.ts', '-i': true, output_mode: 'content', '-n': true, head_limit: 50 },
    });
  });

  it('kills running hooks when the signal aborts', async () => {
    const s = await setup({ user: preHooks('Bash', exampleHook('sleep', '30000')) });
    const controller = new AbortController();
    const started = Date.now();
    const pending = authorize(s, anyBash(s), controller.signal);
    setTimeout(() => controller.abort(), 200);
    expect((await pending).kind).toBe('deny');
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

function s0Dir(): string {
  return os.tmpdir();
}

describe('HTTP hooks', () => {
  let server: Server | undefined;
  let url = '';
  let reply: { status: number; body: string } = { status: 200, body: '' };
  let lastBody = '';
  let lastAuth: string | undefined;

  async function start(): Promise<void> {
    if (server) return;
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        lastBody = Buffer.concat(chunks).toString('utf8');
        lastAuth = req.headers['authorization'];
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(reply.body);
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    url = `http://127.0.0.1:${address.port}/hook`;
  }

  afterAll(async () => {
    await new Promise((r) => server?.close(r));
  });

  it('POSTs the input and applies the JSON decision', async () => {
    await start();
    reply = { status: 200, body: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'http says no' } }) };
    const s = await setup({
      user: preHooks('Bash', { type: 'http', url, headers: { Authorization: 'Bearer $HOOK_TOKEN', 'X-Other': '$NOT_ALLOWED' }, allowedEnvVars: ['HOOK_TOKEN'] }),
    });
    process.env['HOOK_TOKEN'] = 'tok';
    try {
      expect(await authorize(s, bash('ls', s.project))).toEqual({ kind: 'deny', source: 'hook', reason: 'http says no' });
    } finally {
      delete process.env['HOOK_TOKEN'];
    }
    expect(JSON.parse(lastBody)).toMatchObject({ tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect(lastAuth).toBe('Bearer tok');
  });

  it('treats a non-2xx status or a non-JSON body as a failure (deny) unless onFailure is continue', async () => {
    await start();
    reply = { status: 500, body: 'oops' };
    const s = await setup({ user: preHooks('Bash', { type: 'http', url }) });
    expect(await authorize(s, bash('ls', s.project))).toMatchObject({ kind: 'deny', source: 'hook-error' });
    reply = { status: 200, body: 'plain text' };
    expect(await authorize(s, bash('ls', s.project))).toMatchObject({ kind: 'deny', source: 'hook-error' });
    reply = { status: 200, body: '' };
    expect(await authorize(s, bash('ls', s.project))).toEqual({ kind: 'allow' });
    reply = { status: 503, body: '' };
    const lenient = await setup({ user: preHooks('Bash', { type: 'http', url, onFailure: 'continue' }) });
    expect(await authorize(lenient, bash('ls', lenient.project))).toEqual({ kind: 'allow' });
  });

  it('times out', async () => {
    const hang = createServer(() => undefined);
    await new Promise<void>((resolve) => hang.listen(0, '127.0.0.1', resolve));
    const address = hang.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    const s = await setup({ user: preHooks('Bash', { type: 'http', url: `http://127.0.0.1:${address.port}/`, timeout: 0.3 }) });
    expect(await authorize(s, bash('ls', s.project))).toMatchObject({ kind: 'deny', source: 'hook-timeout' });
    hang.closeAllConnections();
    await new Promise((r) => hang.close(r));
  });
});

describe.skipIf(!posix)('PostToolUse hooks', () => {
  it('reports a block as an error the dispatcher turns into a warning', async () => {
    const s = await setup({ user: { hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [exampleHook('exit2')] }] } } });
    const result = { exitCode: 0, signal: null, stdout: 'ok', stderr: '', truncated: false, timedOut: false };
    await expect(s.adapter.postToolUse(bash('ls', s.project), result, s.ctx, s.policy)).rejects.toThrow(/blocked after the call ran.*blocked by example hook/);
    const quiet = await setup({ user: { hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [exampleHook('empty')] }] } } });
    await expect(quiet.adapter.postToolUse(bash('ls', quiet.project), result, quiet.ctx, quiet.policy)).resolves.toBeUndefined();
  });
});

describe('policy snapshot', () => {
  it('lists protected paths and no containment without the sandbox', async () => {
    const s = await setup();
    expect(s.policy.bashContainment).toEqual({ mode: 'none' });
    expect(s.policy.protectedPaths).toEqual(
      expect.arrayContaining([
        path.join(s.project, '.claude', 'settings*.json'),
        path.join(s.project, '.claude', 'hooks', '**'),
        path.join(s.project, '.claude', 'agents', '**'),
        path.join(s.project, '.mcp.json'),
        path.join(s.home, '.claude', '**'),
        path.join(s.base, 'state', '**'),
      ]),
    );
  });

  it('returns a sandbox containment when Claude sandboxing is enabled', async () => {
    const s = await setup({ user: { sandbox: { enabled: true, filesystem: { allowWrite: ['~/.cache/tool', '/opt/build'] } }, permissions: { additionalDirectories: ['/opt/extra'] } } });
    expect(s.policy.bashContainment).toEqual({
      mode: 'sandbox',
      readOnly: false,
      writableRoots: [s.project, path.resolve(s.project, '/opt/extra'), path.join(s.home, '.cache', 'tool'), path.resolve(s.project, '/opt/build')],
      network: false,
    });
  });
});

describe.skipIf(!posix)('with the dispatcher', () => {
  it('re-prepares and re-checks a hook rewrite; a rewrite into a denied command is refused', async () => {
    const s = await setup({
      user: {
        permissions: { deny: ['Bash(rm:*)'] },
        hooks: {
          PreToolUse: [
            { matcher: 'Write', hooks: [exampleHook('update', JSON.stringify({ file_path: '/workspace/a.txt', content: 'sanitized' }))] },
            { matcher: 'Bash', hooks: [exampleHook('update', JSON.stringify({ command: 'rm -rf /workspace' }))] },
          ],
        },
      },
      mode: 'bypassPermissions',
    });
    const tools = new MemoryToolRuntime({ root: '/workspace' });
    const ctx: SessionContext = { ...s.ctx, cwd: '/workspace', roots: ['/workspace'] };
    const dispatcher = new Dispatcher({ adapter: s.adapter, tools, ctx, policy: s.policy });
    const wrote = await dispatcher.dispatch('write', { path: 'a.txt', content: 'secret' });
    expect(wrote.ok).toBe(true);
    expect(tools.read('a.txt')).toBe('sanitized');
    const ran = await dispatcher.dispatch('bash', { command: 'echo hi' });
    expect(ran).toMatchObject({ ok: false, error: { name: 'PermissionDenied', source: 'rule' } });
  });
});
