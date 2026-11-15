import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { runCommandHook } from './command-hook.js';

const posix = process.platform !== 'win32';
const base = { cwd: os.tmpdir(), timeoutMs: 5_000 };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!posix)('runCommandHook (POSIX)', () => {
  it('passes JSON on stdin and env additions, exit 0', async () => {
    const r = await runCommandHook({ ...base, command: 'cat; printf " %s" "$HOOK_EXTRA"', stdin: '{"a":1}', env: { HOOK_EXTRA: 'yes' } });
    expect(r).toMatchObject({ exitCode: 0, stdout: '{"a":1} yes', timedOut: false, spawnError: null });
  });

  it('reports exit 2 with stderr and other exit codes', async () => {
    const two = await runCommandHook({ ...base, command: 'echo blocked >&2; exit 2', stdin: '' });
    expect(two).toMatchObject({ exitCode: 2, stderr: 'blocked\n' });
    const other = await runCommandHook({ ...base, command: 'exit 7', stdin: '' });
    expect(other.exitCode).toBe(7);
  });

  it('kills the child and its grandchild on timeout', async () => {
    const started = Date.now();
    const r = await runCommandHook({ ...base, timeoutMs: 300, command: 'sleep 30 & echo $!; wait', stdin: '' });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
    const grandchild = Number(r.stdout.trim());
    expect(grandchild).toBeGreaterThan(0);
    await new Promise((res) => setTimeout(res, 100));
    expect(alive(grandchild)).toBe(false);
  });

  it('caps huge stdout', async () => {
    const r = await runCommandHook({ ...base, command: 'head -c 5000000 /dev/zero', stdin: '', maxOutputBytes: 1000 });
    expect(r.stdout.length).toBe(1000);
    expect(r.stdoutTruncated).toBe(true);
  });

  it('reports a non-existent command as exit 127', async () => {
    const r = await runCommandHook({ ...base, command: 'definitely-not-a-command-xyz', stdin: '' });
    expect(r.exitCode).toBe(127);
    expect(r.spawnError).toBeNull();
  });

  it('kills the hook when aborted', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const r = await runCommandHook({ ...base, command: 'sleep 30', stdin: '', signal: controller.signal });
    expect(r).toMatchObject({ aborted: true, timedOut: false });
  });

  it('survives a hook that does not read stdin', async () => {
    const r = await runCommandHook({ ...base, command: 'exit 0', stdin: 'x'.repeat(2_000_000) });
    expect(r.exitCode).toBe(0);
  });
});

describe('runCommandHook', () => {
  it('reports a spawn error for a missing cwd and never throws', async () => {
    const r = await runCommandHook({ ...base, cwd: '/definitely/missing/dir', command: 'echo hi', stdin: '' });
    expect(r.exitCode).toBeNull();
    expect(r.spawnError).toBeTruthy();
  });
});
