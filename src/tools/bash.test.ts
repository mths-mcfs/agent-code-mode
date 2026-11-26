import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolError } from '../core/errors.js';
import type { BashContainment, BashResult, PolicySnapshot, SessionContext } from '../core/types.js';
import { makeContext } from '../testing/context.js';
import { bootstrapEnv, findBash, spawnAndWait, type CallTree } from './bash.js';
import { NodeToolRuntime } from './runtime.js';
import { windowsJobHelperPid } from './process-tree.js';
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

  it('on cancel kills children that left the process group or the session', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 1000);
    const command = [
      `perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' sleep 100 & echo $! > setsid.pid`,
      'set -m',
      'sleep 100 & echo $! > job.pid',
      'set +m',
      'sleep 30',
    ].join('\n');
    await expect(bash(command, { signal: ac.signal })).rejects.toMatchObject({ code: 'cancelled' });
    for (const file of ['setsid.pid', 'job.pid']) {
      const pid = Number(readFileSync(path.join(ws, file), 'utf8'));
      expect(await eventually(() => !alive(pid)), file).toBe(true);
    }
  });

  it.runIf(process.platform === 'linux')('after a normal exit kills background jobs in their own process group', async () => {
    const r = await bash('set -m; sleep 100 & echo $!');
    const pid = Number(r.stdout.trim());
    expect(await eventually(() => !alive(pid))).toBe(true);
  });

  it('kills at once on timeout, even while the shell still runs its startup file', async () => {
    const script = path.join(base, 'slow-startup.sh');
    writeFileSync(script, 'sleep 0.8\n');
    const saved = process.env['BASH_ENV'];
    process.env['BASH_ENV'] = script;
    try {
      const started = Date.now();
      const r = await bash('true', { timeoutMs: 100 });
      expect([r.timedOut, r.signal]).toEqual([true, 'SIGKILL']);
      expect(Date.now() - started).toBeLessThan(500);
    } finally {
      if (saved === undefined) delete process.env['BASH_ENV'];
      else process.env['BASH_ENV'] = saved;
    }
  });

  it('arms no kill watchdog when the kill confirms only after bash exited and closed', async () => {
    const ac = new AbortController();
    const timers = vi.spyOn(globalThis, 'setTimeout');
    let confirmed: Promise<readonly number[]> | undefined;
    const tree: CallTree = {
      kill: () =>
        (confirmed ??= new Promise((resolve) => {
          try {
            process.kill(-Number(readFileSync(path.join(ws, 'leader.pid'), 'utf8')), 'SIGKILL');
          } catch {
            // Already gone.
          }
          setTimeout(() => resolve([]), 300);
        })),
      exited: () => undefined,
    };
    const call = spawnAndWait(findBash() ?? 'bash', 'echo $$ > leader.pid; sleep 30', process.env, ws, 60_000, ac.signal, 1024, { tree: () => tree, killWaitMs: 1234 });
    expect(await eventually(() => existsSync(path.join(ws, 'leader.pid')))).toBe(true);
    ac.abort();
    await expect(call).rejects.toMatchObject({ code: 'cancelled' });
    await new Promise((r) => setTimeout(r, 50));
    expect(timers.mock.calls.filter(([, ms]) => ms === 1234)).toEqual([]);
    timers.mockRestore();
  });

  describe('when the processes cannot be confirmed dead', () => {
    const run = (tree: CallTree, opts: { timeoutMs?: number; signal?: AbortSignal } = {}) =>
      spawnAndWait(findBash() ?? 'bash', 'echo $$ > leader.pid; sleep 30', process.env, ws, opts.timeoutMs ?? 60_000, opts.signal ?? new AbortController().signal, 1024, { tree: () => tree, killWaitMs: 300 });
    const reap = async (): Promise<void> => {
      await eventually(() => existsSync(path.join(ws, 'leader.pid')));
      try {
        process.kill(-Number(readFileSync(path.join(ws, 'leader.pid'), 'utf8')), 'SIGKILL');
      } catch {
        // Already gone.
      }
    };

    it('ends a timed-out call with an error when the kill fails, instead of waiting for an exit', async () => {
      const call = run({ kill: () => Promise.reject(new Error('the job could not be terminated')), exited: () => undefined }, { timeoutMs: 300 });
      await expect(call).rejects.toMatchObject({ code: 'tool-error', message: expect.stringMatching(/may still be running.*could not be terminated/) });
      await reap();
    });

    it('ends a cancelled call with an error when bash does not exit after the kill', async () => {
      const ac = new AbortController();
      const call = run({ kill: async () => [], exited: () => undefined }, { signal: ac.signal });
      setTimeout(() => ac.abort(), 300);
      await expect(call).rejects.toMatchObject({ code: 'tool-error', message: expect.stringMatching(/did not exit within 300 ms/) });
      await reap();
    });
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

  it('does not report a timeout when the shell exited and only its output was draining', async () => {
    const r = await bash('sleep 5 & exit 0', { timeoutMs: 100 });
    expect([r.exitCode, r.timedOut]).toEqual([0, false]);
  });

  it('gives the sandbox bootstrap shell no startup files, exported functions or shell options', () => {
    const env = bootstrapEnv({ PATH: '/bin', BASH_ENV: '/x', ENV: '/y', SHELLOPTS: 'xtrace', BASHOPTS: 'extglob', 'BASH_FUNC_example%%': 'unused' });
    expect(env).toEqual({ PATH: '/bin' });
  });

  it('cuts capped output on a character boundary, within the cap', async () => {
    const r = await bash("printf 'abé'; printf 'cdé' >&2", { capBytes: 3 });
    expect(r.truncated).toBe(true);
    expect([r.stdout, r.stderr]).toEqual(['ab', 'cd']);
  });

  it('refuses a containment with a relative writable root', async () => {
    await expect(bash('true', { containment: { mode: 'sandbox', readOnly: false, writableRoots: ['rel'], network: false } })).rejects.toMatchObject({
      code: 'containment-unavailable',
    });
  });
});

/** The Windows pid of the MSYS process `$!`, once it has exec'd. */
const WINPID = 'sleep 1; cat /proc/$!/winpid';

describe.runIf(IS_WINDOWS)('bash on Windows', { timeout: 60_000 }, () => {
  it('runs the command as bash -c with stdin closed', async () => {
    const r = await bash('echo "[$#][$1]"; cat; echo done; exit 3');
    expect([r.exitCode, r.stdout]).toEqual([3, '[0][]\ndone\n']);
  });

  it('on cancel kills every process of the call, orphaned grandchildren included', async () => {
    const ac = new AbortController();
    const command = `sleep 100 & ${WINPID} > child.pid\n(sleep 100 & ${WINPID} > orphan.pid)\nsleep 100`;
    const call = bash(command, { signal: ac.signal, timeoutMs: 60_000 });
    const pidOf = (file: string): number => (existsSync(path.join(ws, file)) ? Number(readFileSync(path.join(ws, file), 'utf8')) : 0);
    // Both are running before the cancel, so their absence after it is the kill's doing.
    expect(await eventually(() => ['child.pid', 'orphan.pid'].every((f) => pidOf(f) > 0 && alive(pidOf(f))), 20_000)).toBe(true);
    ac.abort();
    await expect(call).rejects.toMatchObject({ code: 'cancelled' });
    for (const file of ['child.pid', 'orphan.pid']) expect(alive(pidOf(file)), file).toBe(false);
  });

  it('runs nothing from BASH_ENV or ENV, so no process starts before the call has its job', async () => {
    const script = path.join(base, 'startup.sh');
    writeFileSync(script, `echo ran > ${JSON.stringify(path.join(ws, 'startup.ran').replace(/\\/g, '/'))}\nsleep 100 &\n`);
    const saved = { BASH_ENV: process.env['BASH_ENV'], ENV: process.env['ENV'] };
    process.env['BASH_ENV'] = script.replace(/\\/g, '/');
    process.env['ENV'] = script.replace(/\\/g, '/');
    try {
      const r = await bash('echo "[${BASH_ENV-unset}]"');
      expect(r.stdout).toBe('[unset]\n');
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect(existsSync(path.join(ws, 'startup.ran'))).toBe(false);
  });

  it('after the job helper dies, its calls are killed with it and the next call gets a job from a new helper', async () => {
    const first = bash(`(sleep 100 & ${WINPID} > orphan.pid); sleep 100`, { timeoutMs: 60_000 });
    const pidOf = (file: string): number => (existsSync(path.join(ws, file)) ? Number(readFileSync(path.join(ws, file), 'utf8')) : 0);
    expect(await eventually(() => pidOf('orphan.pid') > 0 && alive(pidOf('orphan.pid')), 20_000)).toBe(true);
    const helperPid = windowsJobHelperPid();
    expect(helperPid).toBeGreaterThan(0);
    process.kill(helperPid ?? 0);
    const r = await first;
    expect(r.timedOut).toBe(false);
    expect(alive(pidOf('orphan.pid'))).toBe(false);
    rmSync(path.join(ws, 'orphan.pid'));
    const ac = new AbortController();
    const second = bash(`(sleep 100 & ${WINPID} > orphan.pid); sleep 100`, { signal: ac.signal, timeoutMs: 60_000 });
    expect(await eventually(() => pidOf('orphan.pid') > 0 && alive(pidOf('orphan.pid')), 30_000)).toBe(true);
    expect(windowsJobHelperPid()).not.toBe(helperPid);
    ac.abort();
    await expect(second).rejects.toMatchObject({ code: 'cancelled' });
    expect(alive(pidOf('orphan.pid'))).toBe(false);
  });

  it('refuses bash when the job helper cannot list the processes to put in the job', async () => {
    const restartHelper = async (): Promise<void> => {
      const pid = windowsJobHelperPid();
      if (pid !== undefined) process.kill(pid);
      expect(await eventually(() => windowsJobHelperPid() === undefined, 10_000)).toBe(true);
    };
    await restartHelper();
    process.env['ACM_TEST_JOB_SNAPSHOT_FAILS'] = '1';
    try {
      await expect(bash('echo ran > ran.txt')).rejects.toMatchObject({ code: 'tool-error', message: expect.stringMatching(/CreateToolhelp32Snapshot/) });
      expect(existsSync(path.join(ws, 'ran.txt'))).toBe(false);
    } finally {
      delete process.env['ACM_TEST_JOB_SNAPSHOT_FAILS'];
      await restartHelper();
    }
  });

  it('after a normal exit leaves no background process behind', async () => {
    const r = await bash(`sleep 100 & ${WINPID}`);
    const pid = Number(r.stdout.trim());
    expect(pid).toBeGreaterThan(0);
    expect(alive(pid)).toBe(false);
  });

  it('kills the whole call on timeout', async () => {
    const r = await bash(`(sleep 100 & ${WINPID} > orphan.pid); sleep 100`, { timeoutMs: 5000 });
    expect(r.timedOut).toBe(true);
    const orphan = Number(readFileSync(path.join(ws, 'orphan.pid'), 'utf8'));
    expect(Number.isInteger(orphan) && orphan > 0).toBe(true);
    expect(alive(orphan)).toBe(false);
  });
});

const unavailable = await containmentUnavailableReason();
if (unavailable !== null) {
  // Logged so a CI run shows why the containment tests were skipped.
  console.log(`bash containment tests skipped: ${unavailable}`);
}

it.runIf(process.env.ACM_REQUIRE_CONTAINMENT === '1')('runs the containment tests where they are required', () => {
  expect(unavailable).toBeNull();
});

describe.skipIf(unavailable !== null)('bash containment (OS sandbox)', () => {
  const readOnly: BashContainment = { mode: 'sandbox', readOnly: true, writableRoots: [], network: false };

  const writable = (network: boolean): BashContainment => ({ mode: 'sandbox', readOnly: false, writableRoots: [ws], network });
  let server: http.Server;
  let url: string;

  beforeEach(async () => {
    server = http.createServer((_req, res) => res.end('reached'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const viaProxy = (proxyExpr: string): string => `curl -s -o /dev/null -w '%{http_code}' -m 5 --noproxy '' -x "${proxyExpr}" ${url}`;

  it('keeps no sandbox process alive after a command, and starts it again for the next one', async () => {
    const bridges = (): number => process.getActiveResourcesInfo().filter((r) => r === 'ProcessWrap').length;
    const before = bridges();
    expect((await bash('echo one', { containment: readOnly })).stdout).toBe('one\n');
    expect(bridges()).toBe(before);
    expect((await bash('echo two', { containment: readOnly })).stdout).toBe('two\n');
  });

  it('gives network only to the call that has it: a proxy credential from an earlier call is refused', async () => {
    const first = await bash(`${viaProxy('$HTTP_PROXY')}; echo "$HTTP_PROXY" > proxy.txt`, { containment: writable(true) });
    expect(first.stdout).toBe('200');
    // The earlier credential against this call's proxy address: on macOS the port changes too, so only this tests the token.
    const second = await bash(`${viaProxy('$HTTP_PROXY')} ; echo; old=$(cat proxy.txt); ${viaProxy('${old%@*}@${HTTP_PROXY#*@}')}`, { containment: writable(true) });
    const [own, earlier] = second.stdout.split('\n');
    expect(own).toBe('200');
    expect(earlier).not.toBe('200');
  });

  it.runIf(process.platform === 'linux')('starts no sentinel outside the PID namespace of a contained call', async () => {
    const sentinels = (): number[] => {
      const leaders = new Set<number>();
      const rows: { pid: number; pgid: number; cmd: string }[] = [];
      for (const name of readdirSync('/proc')) {
        try {
          const fields = readFileSync(`/proc/${name}/stat`, 'utf8').split(') ')[1]?.split(' ') ?? [];
          const cmd = readFileSync(`/proc/${name}/cmdline`, 'utf8');
          if (Number(fields[1]) === process.pid) leaders.add(Number(name));
          rows.push({ pid: Number(name), pgid: Number(fields[2]), cmd });
        } catch {
          // Gone while read.
        }
      }
      return rows.filter((r) => leaders.has(r.pgid) && r.cmd.includes('kill -STOP')).map((r) => r.pid);
    };
    const call = bash('sleep 1.5', { containment: writable(false) });
    const seen = new Set<number>();
    const end = Date.now() + 1200;
    while (Date.now() < end) {
      for (const pid of sentinels()) seen.add(pid);
      await new Promise((r) => setTimeout(r, 100));
    }
    await call;
    expect([...seen]).toEqual([]);
  });

  it('a process left behind by a call never reaches the network of a later call', async () => {
    const late = `echo > detached.txt; sleep 2; ${viaProxy('$HTTP_PROXY')} > late.txt; echo alive > survived.txt`;
    const detach = `(perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' sh -c ${JSON.stringify(late)} >/dev/null 2>&1 &)`;
    // The call ends only once the child has left the session: before that, the sweep still finds it.
    const first = await bash(`${detach}; until [ -e detached.txt ]; do sleep 0.1; done; echo started`, { containment: writable(false), timeoutMs: 15_000 });
    expect(first.stdout).toBe('started\n');
    const second = await bash(`sleep 4; ${viaProxy('$HTTP_PROXY')}`, { containment: writable(true) });
    expect(second.stdout).toBe('200');
    if (process.platform === 'linux') {
      // The PID namespace ends with the call: the child never makes its attempt.
      expect([existsSync(path.join(ws, 'late.txt')), existsSync(path.join(ws, 'survived.txt'))]).toEqual([false, false]);
    } else {
      // On macOS the child outlives its call and tries the network during the later one.
      expect(await eventually(() => existsSync(path.join(ws, 'survived.txt')), 5000)).toBe(true);
      expect(readFileSync(path.join(ws, 'late.txt'), 'utf8')).not.toBe('200');
    }
  });

  it('blocks writes under a read-only sandbox', async () => {
    const r = await bash('touch x', { containment: readOnly });
    expect(r.exitCode).not.toBe(0);
    expect(existsSync(path.join(ws, 'x'))).toBe(false);
  });

  it('allows writes only under the writable roots', async () => {
    const r = await bash(`touch y && touch ${JSON.stringify(path.join(base, 'z'))}`, {
      containment: { mode: 'sandbox', readOnly: false, writableRoots: [ws], network: false },
    });
    expect(existsSync(path.join(ws, 'y'))).toBe(true);
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
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(8000);
  });
});
