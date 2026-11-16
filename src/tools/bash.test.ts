import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolError } from '../core/errors.js';
import type { BashContainment, BashResult, PolicySnapshot, SessionContext } from '../core/types.js';
import { planGlobExpansion } from '../hosts/claude/expand.js';
import { makeContext } from '../testing/context.js';
import { findBash, globEnvironment } from './bash.js';
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
    expect(r).toEqual({ exitCode: 3, signal: null, stdout: 'out\n', stderr: 'err\n', truncated: false, timedOut: false });
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
    // dotglob really reached the expansion: the hidden file is named.
    expect(await prepareCat({ BASHOPTS: 'dotglob' })).toContain("'.hidden.txt'");
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
    for (const env of diverging) {
      expect(globEnvironment(env), JSON.stringify(env)).toBeUndefined();
      expect(await prepareCat(env), JSON.stringify(env)).toBe('cat *.txt');
    }
    // `noglob` shows why: the command's bash would not glob at all.
    expect(oracle({ SHELLOPTS: 'noglob' }, '*.txt')).toEqual(['*.txt']);
  });

  it('passes the expanding bash only the locale, GLOBIGNORE and explicit glob options', () => {
    const glob = globEnvironment({
      LANG: 'C', LC_ALL: 'C', LC_COLLATE: 'C', LC_CTYPE: 'C', LC_MESSAGES: 'C', GLOBIGNORE: 'x*',
      BASHOPTS: 'dotglob:extdebug:nullglob', SHELLOPTS: 'xtrace', PS4: '$(x)', 'BASH_FUNC_f%%': '() { :; }', IFS: '.', PATH: '/bin', HOME: '/', CDPATH: '/',
    });
    expect(glob).toEqual({ env: { LANG: 'C', LC_ALL: 'C', LC_COLLATE: 'C', LC_CTYPE: 'C', GLOBIGNORE: 'x*' }, shopts: ['dotglob', 'nullglob'] });
  });
});
