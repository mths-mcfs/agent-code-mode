import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolError } from '../core/errors.js';
import type { BashContainment, BashResult, PolicySnapshot, SessionContext } from '../core/types.js';
import { makeContext } from '../testing/context.js';
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
