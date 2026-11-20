import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { Dispatcher } from '../../core/dispatcher.js';
import type { Decision, PolicySnapshot, PreparedCall, SessionContext } from '../../core/types.js';
import { MemoryToolRuntime, makeContext } from '../../testing/index.js';
import { ClaudeHostAdapter, type ClaudePolicy } from './adapter.js';

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
    effect: { absPath: p, beforeHash: 'h', afterContent: newString, diff: '', matchedOldString: matched, matchStrategy: 'line-trimmed', replacements: 1 },
  };
}
function grep(root: string): PreparedCall {
  return { id: 'c1', tool: 'grep', args: { pattern: 'x', path: root }, effect: { absRoot: root, pattern: 'x', glob: '*.ts', ignoreCase: true, maxResults: 50 } };
}
function glob(root: string): PreparedCall {
  return { id: 'c1', tool: 'glob', args: { pattern: '**/*.ts', path: root }, effect: { absRoot: root, pattern: '**/*.ts', maxResults: 50 } };
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
    const s = await setup({ user: { permissions: { allow: ['Bash(npm run *)', 'Bash(git status)'] } }, mode: 'default' });
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
    const s = await setup({ user: { permissions: { allow: ['Read(//opt/shared/**)'] } }, mode: 'default' });
    expect(check(s, read('/opt/shared/a'))).toBe('allow');
    expect(check(s, read('/opt/shared/link', '/etc/passwd'))).toBe('ask');
  });
});

describe('permission modes (no rule matches)', () => {
  const cases: Record<string, Record<string, Decision['kind']>> = {
    default: { readIn: 'allow', readOut: 'ask', writeIn: 'ask', writeOut: 'ask', editIn: 'ask', bash: 'ask', grepIn: 'allow', globIn: 'allow' },
    acceptEdits: { readIn: 'allow', readOut: 'ask', writeIn: 'allow', writeOut: 'ask', editIn: 'allow', bash: 'ask', grepIn: 'allow', globIn: 'allow' },
    plan: { readIn: 'allow', readOut: 'ask', writeIn: 'deny', writeOut: 'deny', editIn: 'deny', bash: 'deny', grepIn: 'allow', globIn: 'allow' },
    dontAsk: { readIn: 'allow', readOut: 'deny', writeIn: 'deny', writeOut: 'deny', editIn: 'deny', bash: 'deny', grepIn: 'allow', globIn: 'allow' },
    auto: { readIn: 'allow', readOut: 'ask', writeIn: 'allow', writeOut: 'ask', editIn: 'allow', bash: 'ask', grepIn: 'allow', globIn: 'allow' },
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
      // On Windows no trusted record carries an unreadable mode: only what every mode allows runs.
      const unknown = !posix && mode === 'not-a-mode';
      expect(got).toEqual(unknown ? Object.fromEntries(Object.entries(expected).map(([k, v]) => [k, v === 'allow' ? v : 'deny'])) : expected);
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
    // Windows has no trusted live mode, so neither the flag nor settings authorize a write there.
    expect(check(fromFlag, write(path.join(fromFlag.project, 'a.ts')))).toBe(posix ? 'allow' : 'deny');
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

  it('a PreToolUse failure still denies with onFailure: continue', async () => {
    const s = await setup({ user: preHooks('Bash', exampleHook('crash', undefined, { onFailure: 'continue' })) });
    expect(await authorize(s, anyBash(s))).toMatchObject({ kind: 'deny', source: 'hook-error' });
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

  it('treats a non-2xx status or a non-JSON body as a failure (deny), even with onFailure: continue', async () => {
    await start();
    reply = { status: 500, body: 'oops' };
    const s = await setup({ user: preHooks('Bash', { type: 'http', url }) });
    expect(await authorize(s, bash('ls', s.project))).toMatchObject({ kind: 'deny', source: 'hook-error' });
    reply = { status: 200, body: 'plain text' };
    expect(await authorize(s, bash('ls', s.project))).toMatchObject({ kind: 'deny', source: 'hook-error' });
    reply = { status: 200, body: '' };
    expect(await authorize(s, bash('ls', s.project))).toEqual({ kind: 'allow' });
    reply = { status: 503, body: '' };
    const lenient = await setup({ user: preHooks('Bash', { type: 'http', url, onFailure: 'continue', async: true }) });
    expect(await authorize(lenient, bash('ls', lenient.project))).toMatchObject({ kind: 'deny', source: 'hook-error' });
  });

  it('enforces allowedHttpHookUrls before sending and limits header variables to httpHookAllowedEnvVars', async () => {
    await start();
    reply = { status: 200, body: '' };
    lastBody = '';
    const blocked = await setup({ user: { allowedHttpHookUrls: ['https://hooks.example.com/*'], ...preHooks('Bash', { type: 'http', url }) } });
    expect(await authorize(blocked, bash('ls', blocked.project))).toMatchObject({ kind: 'deny', source: 'unsupported-config' });
    expect(lastBody).toBe('');
    const hook = { type: 'http', url, headers: { Authorization: 'Bearer $HOOK_TOKEN' }, allowedEnvVars: ['HOOK_TOKEN'] };
    const s = await setup({ user: { allowedHttpHookUrls: ['http://127.0.0.1:*'], httpHookAllowedEnvVars: [], ...preHooks('Bash', hook) } });
    process.env['HOOK_TOKEN'] = 'tok';
    try {
      expect(await authorize(s, bash('ls', s.project))).toEqual({ kind: 'allow' });
    } finally {
      delete process.env['HOOK_TOKEN'];
    }
    expect(lastAuth).toBe('Bearer');
  });

  it('names an http hook by its host only in caller-visible errors', async () => {
    const s = await setup({ user: preHooks('Bash', { type: 'http', url: 'http://127.0.0.1:9/hook?label=hidden-value', timeout: 5 }) });
    const decision = await authorize(s, bash('ls', s.project));
    expect(decision.kind).toBe('deny');
    expect(JSON.stringify(decision)).not.toContain('hidden-value');
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
    const signal = new AbortController().signal;
    await expect(s.adapter.postToolUse(bash('ls', s.project), result, s.ctx, s.policy, signal)).rejects.toThrow(/blocked after the call ran.*blocked by example hook/);
    const quiet = await setup({ user: { hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [exampleHook('empty')] }] } } });
    await expect(quiet.adapter.postToolUse(bash('ls', quiet.project), result, quiet.ctx, quiet.policy, signal)).resolves.toBeUndefined();
  });

  it('cancelling the run through the dispatcher kills a running PostToolUse hook', async () => {
    const s0 = await setup();
    const pidFile = path.join(s0.base, 'post.pid');
    const s = await setup({ user: { hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `echo $$ > "${pidFile}"; exec sleep 30` }] }] } }, mode: 'bypassPermissions' });
    const tools = new MemoryToolRuntime({ root: '/workspace' });
    const dispatcher = new Dispatcher({ adapter: s.adapter, tools, ctx: { ...s.ctx, cwd: '/workspace', roots: ['/workspace'] }, policy: s.policy });
    const call = dispatcher.dispatch('bash', { command: 'echo hi' });
    for (let i = 0; i < 100 && !(await readFile(pidFile, 'utf8').catch(() => '')); i++) await new Promise((r) => setTimeout(r, 50));
    const pid = Number(await readFile(pidFile, 'utf8'));
    await dispatcher.stop('cancelled');
    await call;
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(pid, 0)).toThrow();
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

describe('hook selection and execution context', () => {
  it('denies with unsupported-config when a hook matcher is not a valid regular expression', async () => {
    const s = await setup({ user: preHooks('(Bash', exampleHook('allow')) });
    expect(await authorize(s, bash('ls', s.project))).toMatchObject({ kind: 'deny', source: 'unsupported-config' });
  });

  it.skipIf(!posix)('runs `shell: bash` hooks under bash in the session directory, with CLAUDE_PROJECT_DIR at the project', async () => {
    const command = '[ -n "$BASH_VERSION" ] && [ "$(pwd -P)" = "$CLAUDE_PROJECT_DIR/sub" ] || exit 2';
    const s = await setup({ user: preHooks('Bash', { type: 'command', command, shell: 'bash' }) });
    const sub = path.join(s.project, 'sub');
    await mkdir(sub);
    const ctx: SessionContext = { ...s.ctx, cwd: sub };
    const policy = await s.adapter.loadPolicy(ctx);
    if ('error' in policy) throw new Error(policy.error);
    expect(await s.adapter.authorize(bash('ls', sub), ctx, policy, new AbortController().signal)).toEqual({ kind: 'allow' });
  });
});
