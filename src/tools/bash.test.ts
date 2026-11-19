import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolError } from '../core/errors.js';
import type { BashContainment, BashResult, PolicySnapshot, SessionContext } from '../core/types.js';
import { planGlobExpansion } from '../hosts/claude/expand.js';
import { makeContext } from '../testing/context.js';
import { type BashVersion, OUTPUT_TAIL_BYTES, bashVersion, expandBashGlobs, findBash, globEnvironment } from './bash.js';
import { Jail } from './jail.js';
import { NodeToolRuntime } from './runtime.js';
import { containmentUnavailableReason } from './sandbox.js';

const IS_WINDOWS = process.platform === 'win32';

let base: string;
let ws: string;
let ctx: SessionContext;
let seq = 0;

function policyWith(bashContainment: BashContainment): PolicySnapshot {
  return { host: 'generic', bashContainment, protectedPaths: [], payload: null };
}

async function bash(
  command: string,
  opts: { timeoutMs?: number; signal?: AbortSignal; containment?: BashContainment; capBytes?: number } = {},
): Promise<BashResult> {
  const rt = new NodeToolRuntime({ stateDir: path.join(base, 'state'), ...(opts.capBytes ? { bashOutputCapBytes: opts.capBytes } : {}) });
  const prepared = await rt.prepare(
    { id: `c${++seq}`, tool: 'bash', args: { command, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) } },
    ctx,
    policyWith(opts.containment ?? { mode: 'none' }),
  );
  const result = await rt.commit(prepared, opts.signal ?? new AbortController().signal);
  if (!('exitCode' in result)) throw new Error('not a bash result');
  return result;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function eventually(check: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'acm-bash-')));
  ws = path.join(base, 'ws');
  mkdirSync(ws);
  ctx = makeContext(ws);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe.skipIf(IS_WINDOWS)('bash', () => {
  it('returns exit code and output; a non-zero exit is a result', async () => {
    const r = await bash('echo out; echo err >&2; exit 3');
    expect(r).toMatchObject({ exitCode: 3, signal: null, stdout: 'out\n', stderr: 'err\n', truncated: false, timedOut: false });
  });

  it('kills the whole process group on timeout, grandchildren included', async () => {
    const started = Date.now();
    const r = await bash('sleep 100 & echo $! > bg.pid; sleep 100', { timeoutMs: 500 });
    expect(r.timedOut).toBe(true);
    expect(r.signal).toBe('SIGKILL');
    expect(Date.now() - started).toBeLessThan(5000);
    const pid = Number(readFileSync(path.join(ws, 'bg.pid'), 'utf8'));
    expect(await eventually(() => !alive(pid))).toBe(true);
  });

  it('does not leave background processes behind after a normal exit', async () => {
    const started = Date.now();
    const r = await bash('sleep 100 & echo $!');
    expect(Date.now() - started).toBeLessThan(5000);
    const pid = Number(r.stdout.trim());
    expect(await eventually(() => !alive(pid))).toBe(true);
  });

  it('never starts when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(bash('touch spawned.txt', { signal: ac.signal })).rejects.toMatchObject({ code: 'cancelled' });
    expect(existsSync(path.join(ws, 'spawned.txt'))).toBe(false);
  });

  it('stops a running command on abort', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const started = Date.now();
    await expect(bash('sleep 30', { signal: ac.signal })).rejects.toBeInstanceOf(ToolError);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('caps stdout and stderr', async () => {
    const r = await bash("head -c 5000 /dev/zero | tr '\\0' a; head -c 3000 /dev/zero | tr '\\0' b >&2", { capBytes: 1000 });
    expect(r.stdout).toBe('a'.repeat(1000));
    expect(r.stderr).toBe('b'.repeat(1000));
    expect(r.truncated).toBe(true);
  });

  it('keeps the end of a stream that was cut, and only of that stream', async () => {
    const r = await bash("head -c 5000 /dev/zero | tr '\\0' a; printf THE-END; printf short >&2", { capBytes: 100 });
    expect(r.truncated).toBe(true);
    expect(r.stdout).toHaveLength(100);
    expect(r.stdoutTail?.endsWith('THE-END')).toBe(true);
    expect(r.stderr).toBe('short');
    expect(r).not.toHaveProperty('stderrTail');
  });

  it('neither cut splits a character, and start and end join exactly when nothing was lost between them', async () => {
    const r = await bash("printf 'xxx😀yyy'", { capBytes: 5 });
    expect(r.stdout).toBe('xxx');
    expect(r.stdoutTail).toBe('😀yyy');
    expect(r.stdoutOmitted).toBe(0);
  });

  it('says how many bytes were lost between the start and the end', async () => {
    const r = await bash(`head -c ${OUTPUT_TAIL_BYTES + 1000} /dev/zero | tr '\\0' a`, { capBytes: 100 });
    expect(r.stdoutTail).toHaveLength(OUTPUT_TAIL_BYTES);
    expect(r.stdoutOmitted).toBe(900);
  });

  it('keeps the order of both streams together', async () => {
    const r = await bash('printf OLD >&2; sleep 0.2; printf FINAL');
    expect(r.outputTail).toBe('OLDFINAL');
  });

  it('adds no combined tail when only one stream has output', async () => {
    expect(await bash('printf only')).not.toHaveProperty('outputTail');
  });

  it('adds no tail when nothing was cut', async () => {
    const r = await bash('echo fine');
    expect(r).not.toHaveProperty('stdoutTail');
    expect(r).not.toHaveProperty('stderrTail');
  });

  it('the tail is bounded and starts at a character boundary', async () => {
    const r = await bash(`for i in 1 2 3 4 5 6 7 8; do head -c 20000 /dev/zero | sed 's/\\x00/é/g'; done; yes é | head -c ${OUTPUT_TAIL_BYTES * 2} | tr -d '\\n'`, { capBytes: 10 });
    expect(Buffer.byteLength(r.stdoutTail ?? '')).toBeLessThanOrEqual(OUTPUT_TAIL_BYTES);
    expect(r.stdoutTail).not.toContain('�');
  });

  it('refuses a containment with a relative writable root', async () => {
    await expect(bash('true', { containment: { mode: 'sandbox', readOnly: false, writableRoots: ['rel'], network: false } })).rejects.toMatchObject({
      code: 'containment-unavailable',
    });
  });
});

const unavailable = await containmentUnavailableReason();
if (unavailable !== null) {
  // Logged so a CI run shows why the containment tests were skipped.
  console.log(`bash containment tests skipped: ${unavailable}`);
}

// CI sets ACM_REQUIRE_CONTAINMENT=1 where the dependencies are installed, so a silent skip there is a failure.
it.runIf(process.env['ACM_REQUIRE_CONTAINMENT'] === '1')('bash containment is available where it is required', () => {
  expect(unavailable).toBeNull();
});

describe.skipIf(unavailable !== null)('bash containment (OS sandbox)', () => {
  const readOnly: BashContainment = { mode: 'sandbox', readOnly: true, writableRoots: [], network: false };

  it('blocks writes under a read-only sandbox', async () => {
    const r = await bash('touch x', { containment: readOnly });
    expect(r.exitCode).not.toBe(0);
    expect(existsSync(path.join(ws, 'x'))).toBe(false);
  });

  it('allows writes only under the writable roots', async () => {
    const r = await bash(`touch y && touch ${JSON.stringify(path.join(base, 'z'))}`, {
      containment: { mode: 'sandbox', readOnly: false, writableRoots: [ws], network: false },
    });
    expect(existsSync(path.join(ws, 'y')), `sandboxed bash failed: exit ${r.exitCode} stderr ${r.stderr}`).toBe(true);
    expect(r.exitCode).not.toBe(0);
    expect(existsSync(path.join(base, 'z'))).toBe(false);
  });

  it('blocks the network when network is off', async () => {
    const r = await bash("exec 3<>/dev/tcp/1.1.1.1/80 && echo connected", { containment: readOnly, timeoutMs: 15_000 });
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).not.toContain('connected');
  });

  it('kills the sandboxed command on timeout', async () => {
    const started = Date.now();
    const r = await bash('sleep 100', { containment: readOnly, timeoutMs: 1000 });
    expect(r.timedOut, `sandboxed bash failed: exit ${r.exitCode} stderr ${r.stderr}`).toBe(true);
    expect(Date.now() - started).toBeLessThan(8000);
  });
});

/**
 * The glob expansion runs before authorization, so it must not run code
 * whatever environment the server inherited. Property: for each environment
 * that changes how bash behaves, preparing `cat *.txt` writes nothing and
 * gives the same command as in a clean environment, or leaves the command
 * as written (not expanded). And when the environment changes globbing in a
 * way the expansion reproduces (glob options, `GLOBIGNORE`), it matches what
 * the bash that runs the command would glob.
 */
describe.skipIf(IS_WINDOWS)('bash glob expansion environment', () => {
  const GLOB_VARS = ['BASHOPTS', 'SHELLOPTS', 'PS4', 'IFS', 'PROMPT_COMMAND', 'BASH_XTRACEFD', 'CDPATH', 'BASH_ENV', 'ENV', 'GLOBIGNORE', 'GLOBSORT', 'BASH_COMPAT', 'POSIXLY_CORRECT', 'LOCPATH'];

  async function prepareCat(env: Record<string, string>, command = 'cat *.txt'): Promise<string> {
    const saved = { ...process.env };
    for (const name of [...GLOB_VARS, ...Object.keys(process.env).filter((n) => n.startsWith('BASH_FUNC_'))]) delete process.env[name];
    Object.assign(process.env, env);
    try {
      const rt = new NodeToolRuntime({ stateDir: path.join(base, 'state') });
      const policy: PolicySnapshot = { ...policyWith({ mode: 'none' }), planBashExpansion: planGlobExpansion };
      const prepared = await rt.prepare({ id: `c${++seq}`, tool: 'bash', args: { command } }, ctx, policy);
      if (prepared.tool !== 'bash') throw new Error('not a bash call');
      return prepared.effect.command;
    } finally {
      for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
      Object.assign(process.env, saved);
    }
  }

  function seed(): void {
    for (const name of ['a.txt', 'b.txt', 'c d.txt', '.hidden.txt']) writeFileSync(path.join(ws, name), `${name}\n`);
  }

  it('runs no code and changes nothing for any environment that alters bash', async () => {
    seed();
    const clean = await prepareCat({});
    expect(clean).toBe("cat -- 'a.txt' 'b.txt' 'c d.txt'");
    const hit = path.join(base, 'hit');
    const run = `echo EXECUTED >> ${hit}`;
    const script = path.join(base, 'startup.sh');
    writeFileSync(script, `${run}\n`);
    const fn = (body: string): string => `() { ${run}; ${body}; }`;
    const hostile: Record<string, Record<string, string>> = {
      'function shopt': { 'BASH_FUNC_shopt%%': fn('builtin shopt "$@"') },
      'function printf': { 'BASH_FUNC_printf%%': fn('builtin printf "$@"') },
      'function builtin': { 'BASH_FUNC_builtin%%': fn('command builtin "$@"') },
      'function for': { 'BASH_FUNC_for%%': fn('true') },
      'function echo': { 'BASH_FUNC_echo%%': fn('true') },
      'xtrace PS4': { SHELLOPTS: 'xtrace', PS4: `$(${run})` },
      'verbose': { SHELLOPTS: 'verbose' },
      'errexit': { SHELLOPTS: 'errexit' },
      'xtrace verbose errexit': { SHELLOPTS: 'braceexpand:errexit:hashall:verbose:xtrace', PS4: `$(${run})+ ` },
      'PS4 alone': { PS4: `$(${run})` },
      'extdebug': { BASHOPTS: 'extdebug' },
      'extdebug with a function': { BASHOPTS: 'extdebug:extglob', 'BASH_FUNC_shopt%%': fn('builtin shopt "$@"') },
      'IFS dot': { IFS: '.' },
      'IFS t': { IFS: 't' },
      'PROMPT_COMMAND': { PROMPT_COMMAND: run },
      'xtrace to stdout': { SHELLOPTS: 'xtrace', BASH_XTRACEFD: '1' },
      'CDPATH': { CDPATH: base },
      'BASH_ENV and ENV': { BASH_ENV: script, ENV: script },
    };
    hostile['all at once'] = Object.assign({}, ...Object.values(hostile));
    const before = readdirSync(ws).sort();
    for (const [label, env] of Object.entries(hostile)) {
      const command = await prepareCat(env);
      expect(existsSync(hit), label).toBe(false);
      expect(readdirSync(ws).sort(), label).toEqual(before);
      expect([clean, 'cat *.txt'], label).toContain(command);
    }
  });

  /** What the bash that runs the command globs, in the server's environment plus `env`. */
  function oracle(env: Record<string, string>, word: string): string[] {
    const shell = findBash() ?? 'bash';
    const out = spawnSync(shell, ['-c', `for f in ${word}; do printf '%s\\0' "$f"; done`], { cwd: ws, env: { ...process.env, ...env }, encoding: 'utf8' }).stdout;
    return out.split('\0').slice(0, -1);
  }

  const quoted = (names: string[]): string => `cat -- ${names.map((n) => `'${n}'`).join(' ')}`;

  it('globs as the bash running the command would under glob options and GLOBIGNORE from the environment', async () => {
    seed();
    const cases: Record<string, string>[] = [
      { BASHOPTS: 'dotglob' },
      { BASHOPTS: 'checkwinsize:cmdhist:complete_fullquote:dotglob:expand_aliases:extglob:globskipdots:progcomp:promptvars:sourcepath' },
      { GLOBIGNORE: 'b*' },
      { BASHOPTS: 'nocaseglob', GLOBIGNORE: '*d*' },
    ];
    for (const env of cases) {
      const expected = oracle(env, '*.txt');
      expect(expected.length, JSON.stringify(env)).toBeGreaterThan(0);
      expect(await prepareCat(env), JSON.stringify(env)).toBe(quoted(expected));
    }
    // dotglob reaches the expansion exactly when the command's bash reads it from BASHOPTS (bash 4.1 and later).
    const dot = await prepareCat({ BASHOPTS: 'dotglob' });
    if (oracle({ BASHOPTS: 'dotglob' }, '*.txt').includes('.hidden.txt')) expect(dot).toContain("'.hidden.txt'");
    else expect(dot).not.toContain('.hidden.txt');
  });

  it('does not expand when the environment changes globbing in a way the expansion would not reproduce', async () => {
    seed();
    const diverging: Record<string, string>[] = [
      { BASHOPTS: 'compat42' },
      { BASHOPTS: 'dotglob:some_future_option' },
      { SHELLOPTS: 'noglob' },
      { SHELLOPTS: 'braceexpand:posix' },
      { GLOBSORT: '-name' },
      { BASH_COMPAT: '4.2' },
      { POSIXLY_CORRECT: '1' },
      { LOCPATH: base },
    ];
    // On the bash that runs the commands: refused, or (a variable that bash does not read) the same list as that bash.
    const real = await realVersion();
    for (const env of diverging) {
      if (globEnvironment(env, real) === undefined) expect(await prepareCat(env), JSON.stringify(env)).toBe('cat *.txt');
      else expect(await prepareCat(env), JSON.stringify(env)).toBe(quoted(oracle(env, '*.txt')));
    }
    // On a bash that reads them all, every one is refused.
    for (const env of diverging) expect(globEnvironment(env, { major: 5, minor: 3 }), JSON.stringify(env)).toBeUndefined();
    // `noglob` shows why: the command's bash would not glob at all.
    expect(oracle({ SHELLOPTS: 'noglob' }, '*.txt')).toEqual(['*.txt']);
  });

  it('passes the expanding bash only the locale, GLOBIGNORE and explicit glob options', () => {
    const glob = globEnvironment({
      LANG: 'C', LC_ALL: 'C', LC_COLLATE: 'C', LC_CTYPE: 'C', LC_MESSAGES: 'C', GLOBIGNORE: 'x*',
      BASHOPTS: 'dotglob:extdebug:nullglob', SHELLOPTS: 'xtrace', PS4: '$(x)', 'BASH_FUNC_f%%': '() { :; }', IFS: '.', PATH: '/bin', HOME: '/', CDPATH: '/',
    }, { major: 5, minor: 3 });
    expect(glob).toEqual({ env: { LANG: 'C', LC_ALL: 'C', LC_COLLATE: 'C', LC_CTYPE: 'C', GLOBIGNORE: 'x*' }, shopts: ['dotglob', 'nullglob'] });
  });

  /** The version of the bash the commands run with. */
  async function realVersion(): Promise<BashVersion> {
    const v = await bashVersion(findBash() ?? 'bash');
    if (v === null) throw new Error('bash version unknown');
    return v;
  }

  it('applies what each bash version reads from the environment, and only that', () => {
    const v = (major: number, minor: number): BashVersion => ({ major, minor });
    // BASHOPTS is read from the environment from bash 4.1 (macOS ships 3.2): before, its options are not set.
    expect(globEnvironment({ BASHOPTS: 'dotglob:extglob' }, v(3, 2))).toEqual({ env: {}, shopts: [] });
    expect(globEnvironment({ BASHOPTS: 'dotglob:extglob' }, v(4, 0))).toEqual({ env: {}, shopts: [] });
    expect(globEnvironment({ BASHOPTS: 'dotglob:extglob' }, v(4, 1))).toEqual({ env: {}, shopts: ['dotglob', 'extglob'] });
    // An option unknown to this table is harmless where BASHOPTS is ignored, refused where it is read.
    expect(globEnvironment({ BASHOPTS: 'compat42' }, v(3, 2))).toBeDefined();
    expect(globEnvironment({ BASHOPTS: 'compat42' }, v(4, 1))).toBeUndefined();
    // GLOBIGNORE and SHELLOPTS are read in every version.
    expect(globEnvironment({ GLOBIGNORE: 'b*' }, v(3, 2))).toEqual({ env: { GLOBIGNORE: 'b*' }, shopts: [] });
    expect(globEnvironment({ SHELLOPTS: 'noglob' }, v(3, 2))).toBeUndefined();
    // GLOBSORT exists from 5.3, BASH_COMPAT from 4.3.
    expect(globEnvironment({ GLOBSORT: '-name' }, v(5, 2))).toBeDefined();
    expect(globEnvironment({ GLOBSORT: '-name' }, v(5, 3))).toBeUndefined();
    expect(globEnvironment({ BASH_COMPAT: '4.2' }, v(4, 2))).toBeDefined();
    expect(globEnvironment({ BASH_COMPAT: '4.2' }, v(4, 3))).toBeUndefined();
    expect(globEnvironment({ POSIXLY_CORRECT: '1' }, v(3, 2))).toBeUndefined();
  });

  it('asks bash its version with an empty environment, and gives null when it cannot tell', async () => {
    const shell = findBash() ?? 'bash';
    const told = spawnSync(shell, ['-c', 'echo "${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}"'], { env: {}, encoding: 'utf8' }).stdout.trim();
    const saved = process.env['BASH_FUNC_builtin%%'];
    process.env['BASH_FUNC_builtin%%'] = '() { echo 9.9; }';
    try {
      const v = await bashVersion(shell);
      expect(v && `${v.major}.${v.minor}`).toBe(told);
    } finally {
      if (saved === undefined) delete process.env['BASH_FUNC_builtin%%'];
      else process.env['BASH_FUNC_builtin%%'] = saved;
    }
    expect(await bashVersion(path.join(base, 'no-such-bash'))).toBeNull();
    expect(await bashVersion(process.execPath)).toBeNull(); // runs, but does not answer as bash
  });

  it('does not expand when BASH_ENV is set: bash -c runs it before the command, and it may set glob options', async () => {
    seed();
    const startup = path.join(base, 'startup.sh');
    writeFileSync(startup, 'shopt -s dotglob\n');
    // The command's bash does see the hidden file: expanding without BASH_ENV would give it fewer files.
    expect(oracle({ BASH_ENV: startup }, '*.txt')).toContain('.hidden.txt');
    expect(await prepareCat({ BASH_ENV: startup })).toBe('cat *.txt');
    // Empty, it is not read; ENV is read only by interactive shells, so the list is that of bash -c.
    expect(await prepareCat({ BASH_ENV: '' })).toBe(quoted(oracle({ BASH_ENV: '' }, '*.txt')));
    writeFileSync(path.join(base, 'env.sh'), 'shopt -s dotglob\n');
    expect(await prepareCat({ ENV: path.join(base, 'env.sh') })).toBe(quoted(oracle({ ENV: path.join(base, 'env.sh') }, '*.txt')));
    expect(globEnvironment({ BASH_ENV: startup }, { major: 3, minor: 2 })).toBeUndefined();
  });
});

/**
 * The expansion runs before authorization, so bash must not open anything
 * outside the workspace, and a refusal must not name what is there.
 */
describe.skipIf(IS_WINDOWS)('bash glob expansion and the workspace', () => {
  let outside: string;
  beforeEach(() => {
    outside = path.join(base, 'outside');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'secret.txt'), 'SECRET\n');
    writeFileSync(path.join(outside, 'x.txt'), 'X\n');
    symlinkSync(outside, path.join(ws, 'link'));
  });

  async function expand(command: string) {
    const plan = planGlobExpansion(command);
    if (!plan) throw new Error(`no plan for ${command}`);
    const jail = await Jail.create({ cwd: ws, roots: [ws], protectedPaths: [] });
    return expandBashGlobs(plan, ws, jail, undefined);
  }

  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  it.skipIf(asRoot)('refuses a glob in a directory link to outside without opening it', async () => {
    // Unreadable: bash could not list it, so a refusal can only come from the check made before bash runs.
    chmodSync(outside, 0o311);
    try {
      const err = await expand('cat link/*.txt').then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(ToolError);
      expect(err).toMatchObject({ code: 'outside-workspace' });
    } finally {
      chmodSync(outside, 0o755);
    }
  });

  it('never names a file outside the workspace in the refusal', async () => {
    writeFileSync(path.join(ws, 'a.txt'), 'A\n');
    symlinkSync(path.join(outside, 'secret.txt'), path.join(ws, 'b.txt'));
    for (const command of ['cat link/*.txt', 'cat *.txt', 'cat link/s*']) {
      const err = await expand(command).then(() => null, (e: unknown) => e);
      expect(err, command).toMatchObject({ code: 'outside-workspace' });
      const message = err instanceof Error ? err.message : '';
      expect(message, command).not.toContain('secret');
      expect(message, command).not.toContain(outside);
    }
  });

  it('does not expand a glob before the last slash: bash would follow a directory link', async () => {
    mkdirSync(path.join(ws, 'a1', 'b'), { recursive: true });
    writeFileSync(path.join(ws, 'a1', 'b', 'c.js'), 'C\n');
    for (const command of ['cat */x.txt', 'cat l*/x.txt', 'cat a*/b/*.js', 'cat ?ink/*.txt', 'cat [l]ink/secret.txt']) {
      expect(await expand(command), command).toBeUndefined();
    }
  });

  it('still expands in a literal directory inside the workspace, quoted or through a link that stays inside', async () => {
    mkdirSync(path.join(ws, 'da ta'));
    mkdirSync(path.join(ws, 'd*'));
    writeFileSync(path.join(ws, 'da ta', 'a.txt'), 'A\n');
    writeFileSync(path.join(ws, 'd*', 'b.txt'), 'B\n');
    symlinkSync(path.join(ws, 'da ta'), path.join(ws, 'inner'));
    expect((await expand(`cat "da ta"/*.txt`))?.command).toBe("cat -- 'da ta/a.txt'");
    expect((await expand(`cat da\\ ta/*.txt`))?.command).toBe("cat -- 'da ta/a.txt'");
    expect((await expand(`cat 'd*'/*.txt`))?.command).toBe("cat -- 'd*/b.txt'");
    expect((await expand('cat inner/*.txt'))?.command).toBe("cat -- 'inner/a.txt'");
    // A directory that does not exist: nothing matches, the command stays as written.
    expect(await expand('cat nowhere/*.txt')).toBeUndefined();
  });
});
