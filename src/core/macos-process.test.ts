import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkSystemPerl, macPerlInvocation, parseMacProcess, readMacProcess, readMacProcessSync, SYSTEM_PERL } from './macos-process.js';

interface Dump {
  readonly argv: readonly string[];
  readonly execPath?: string;
  readonly env?: readonly string[];
  readonly pid?: number;
  readonly ppid?: number;
  readonly cwd?: string;
  readonly bsdResult?: number;
  readonly vnodeResult?: number;
  /** Bytes between the exec path and argv[0], replacing the computed padding. */
  readonly pad?: Buffer;
}

/** What the perl script prints, built the way the kernel lays it out. */
function dump(d: Dump): Buffer {
  const execPath = Buffer.from(`${d.execPath ?? '/usr/local/bin/node'}\0`);
  const pad = d.pad ?? Buffer.alloc((8 - (execPath.length % 8)) % 8);
  const strings = [...d.argv, ...(d.env ?? ['HOME=/h'])].map((s) => Buffer.from(`${s}\0`));
  const argc = Buffer.alloc(4);
  argc.writeInt32LE(d.argv.length);
  const args = Buffer.concat([argc, execPath, pad, ...strings, Buffer.alloc(3)]);
  const bsd = Buffer.alloc(136);
  bsd.writeUInt32LE(d.pid ?? 42, 12);
  bsd.writeUInt32LE(d.ppid ?? 7, 16);
  const vnode = Buffer.alloc(2352);
  vnode.write(d.cwd ?? '/work dir', 152);
  const int64 = (n: number) => {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(BigInt(n));
    return b;
  };
  return Buffer.concat([int64(args.length), args, int64(d.bsdResult ?? 136), bsd, int64(d.vnodeResult ?? 2352), vnode]);
}

describe('macOS process reader', () => {
  it('runs the system perl by absolute path, from /, with an empty environment and an inline script', () => {
    const run = macPerlInvocation(42);
    expect(run).toMatchObject({ file: '/usr/bin/perl', cwd: '/', env: {} });
    expect(run.args).toHaveLength(3);
    expect(run.args[0]).toBe('-e');
    expect(run.args[2]).toBe('42');
    for (const pid of [0, -1, 1.5, Number.NaN]) expect(() => macPerlInvocation(pid)).toThrow(/invalid process id/);
  });

  it('refuses a perl that is not a regular file owned and writable only by root', () => {
    const st = (isFile: boolean, uid: number, mode: number) => ({ isFile: () => isFile, uid, mode });
    expect(() => checkSystemPerl(st(true, 0, 0o100755))).not.toThrow();
    for (const bad of [st(false, 0, 0o120755), st(true, 501, 0o100755), st(true, 0, 0o100775), st(true, 0, 0o100757)]) {
      expect(() => checkSystemPerl(bad)).toThrow(SYSTEM_PERL);
    }
  });

  it('keeps every argument exactly, empty ones included, and returns the parent, cwd and environment', () => {
    const argv = ['/opt/my apps/claude', '--settings', '{"permissions": {"deny": ["Bash(rm:*)"]}}', '', 'x\ny', ' lead', 'ünï'];
    const p = parseMacProcess(42, dump({ argv, env: ['CODEX_HOME=/c h', 'A=1'] }));
    expect(p).toMatchObject({ argv, ppid: 7, cwd: '/work dir' });
    expect(p.environ.toString().split('\0').filter(Boolean)).toEqual(['CODEX_HOME=/c h', 'A=1']);
  });

  it('reads an empty argv[0] from the padding boundary instead of skipping it as padding', () => {
    expect(parseMacProcess(42, dump({ argv: ['', '-e', 'x'], execPath: '/bin/abc' })).argv).toEqual(['', '-e', 'x']);
    expect(parseMacProcess(42, dump({ argv: ['', 'y'], execPath: '/bin/abcdef' })).argv).toEqual(['', 'y']);
  });

  it('refuses output that does not fit the layout', () => {
    const good = dump({ argv: ['node', 'a'] });
    expect(() => parseMacProcess(42, good.subarray(0, good.length - 1))).toThrow(/truncated/);
    expect(() => parseMacProcess(42, Buffer.concat([good, Buffer.from([0])]))).toThrow(/trailing/);
    expect(() => parseMacProcess(43, good)).toThrow(/parent process id/);
    expect(() => parseMacProcess(42, dump({ argv: ['node'], bsdResult: -1 }))).toThrow(/parent process id/);
    expect(() => parseMacProcess(42, dump({ argv: ['node'], pad: Buffer.from([0x41, 0, 0, 0, 0, 0, 0]), execPath: '/a' }))).toThrow(/layout/);
    const short = dump({ argv: ['node', 'a'], env: [] });
    short.writeInt32LE(9, 8);
    expect(() => parseMacProcess(42, short)).toThrow(/ends inside argument/);
  });

  it('rejects an argument that is not valid UTF-8', () => {
    const raw = dump({ argv: ['node', 'ab'] });
    const at = raw.indexOf(Buffer.from('ab\0'));
    raw[at] = 0xff;
    expect(() => parseMacProcess(42, raw)).toThrow(/argument 1 is not valid UTF-8/);
  });

  it('leaves the cwd unknown when the kernel does not report it or it is not absolute UTF-8', () => {
    expect(parseMacProcess(42, dump({ argv: ['node'], vnodeResult: -1 })).cwd).toBeUndefined();
    expect(parseMacProcess(42, dump({ argv: ['node'], cwd: 'relative' })).cwd).toBeUndefined();
  });

  it.runIf(process.platform === 'darwin')('reads the exact argv, parent, cwd and environment of a real process', async () => {
    const cwd = path.join(await realpath(await mkdtemp(path.join(os.tmpdir(), 'acm-mac-'))), 'dir with "quotes" and spaces');
    await mkdir(cwd);
    const args = ['-e', 'setInterval(() => {}, 1000)', '--', 'a b', '"q"', "it's", '{"permissions": {"deny": ["Bash(rm:*)"]}}', '', 'x\ny', 'tab\there', 'ünï', '', '  lead', 'trail  '];
    const child = spawn(process.execPath, args, { cwd, argv0: '/opt/my apps/node', env: { ...process.env, ACM_MARK: 'v a l' }, stdio: 'ignore' });
    try {
      await new Promise((resolve) => child.once('spawn', resolve));
      const pid = child.pid ?? 0;
      for (const p of [await readMacProcess(pid), readMacProcessSync(pid)]) {
        expect(p.argv).toEqual(['/opt/my apps/node', ...args]);
        expect(p.ppid).toBe(process.pid);
        expect(p.cwd).toBe(cwd);
        expect(p.environ.toString().split('\0')).toContain('ACM_MARK=v a l');
      }
    } finally {
      child.kill();
    }
  });

  it.runIf(process.platform === 'darwin')('fails closed on a process of another user', async () => {
    await expect(readMacProcess(1)).rejects.toThrow(/process 1 cannot be read on macOS/);
    expect(() => readMacProcessSync(1)).toThrow(/process 1 cannot be read on macOS/);
  });
});
