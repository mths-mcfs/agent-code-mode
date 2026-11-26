import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createScratch, scratchBase, sweepScratch } from './scratch.js';

const posix = process.platform !== 'win32';
let tmp: string;
let base: string;

beforeEach(() => {
  tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'acm-scratch-')));
  base = scratchBase(path.join(tmp, 'state', 'agent-code-mode'));
});

afterEach(() => {
  if (existsSync(tmp)) {
    spawnSync('chmod', ['-R', 'u+rwx', tmp]);
    rmSync(tmp, { recursive: true, force: true });
  }
});

describe('scratch directory', () => {
  it('sits next to the state directory, never inside it', () => {
    expect(scratchBase('/home/u/.local/state/agent-code-mode')).toBe(path.join('/home/u/.local/state', 'agent-code-mode-scratch'));
  });

  it('is a new, empty, private directory per call, named after this process', async () => {
    const a = await createScratch(base);
    const b = await createScratch(base);
    expect(a.path).not.toBe(b.path);
    expect(path.dirname(a.path)).toBe(base);
    expect(path.basename(a.path).startsWith(`${process.pid}-`)).toBe(true);
    expect(readdirSync(a.path)).toEqual([]);
    if (posix) {
      expect(statSync(a.path).mode & 0o777).toBe(0o700);
      expect(statSync(base).mode & 0o777).toBe(0o700);
    }
  });

  it.skipIf(!posix)('refuses a base another user could write', async () => {
    mkdirSync(base, { recursive: true, mode: 0o700 });
    chmodSync(base, 0o777);
    await expect(createScratch(base)).rejects.toThrow(/not private/);
  });

  it('remove deletes everything, also directories a script made unwritable, and is idempotent', async () => {
    const s = await createScratch(base);
    mkdirSync(path.join(s.path, 'a', 'b'), { recursive: true });
    writeFileSync(path.join(s.path, 'a', 'b', 'f.txt'), 'x');
    if (posix) chmodSync(path.join(s.path, 'a'), 0o500);
    expect(await s.remove()).toBeUndefined();
    expect(existsSync(s.path)).toBe(false);
    expect(await s.remove()).toBeUndefined();
  });

  it('empties itself and says why past its byte limit', async () => {
    const s = await createScratch(base, { bytes: 64 * 1024, entries: 1000 });
    writeFileSync(path.join(s.path, 'small.txt'), 'x'.repeat(10));
    expect(await s.enforceLimit()).toBeUndefined();
    writeFileSync(path.join(s.path, 'big.bin'), Buffer.alloc(256 * 1024, 1));
    expect(await s.enforceLimit()).toMatch(/passed 65536 bytes and was emptied/);
    expect(readdirSync(s.path)).toEqual([]);
    expect(existsSync(s.path)).toBe(true);
  });

  it('empties itself past its entry limit, counting nested entries', async () => {
    const s = await createScratch(base, { bytes: 1024 * 1024 * 1024, entries: 50 });
    mkdirSync(path.join(s.path, 'd'));
    for (let i = 0; i < 49; i++) writeFileSync(path.join(s.path, 'd', `${i}`), '');
    expect(await s.enforceLimit()).toBeUndefined();
    writeFileSync(path.join(s.path, 'd', 'one-more'), '');
    expect(await s.enforceLimit()).toMatch(/passed 50 entries/);
    expect(readdirSync(s.path)).toEqual([]);
  });

  it.skipIf(!posix)('counts a directory it cannot read as over the limit, and empties it anyway', async () => {
    const s = await createScratch(base, { bytes: 64 * 1024, entries: 1000 });
    mkdirSync(path.join(s.path, 'hidden'));
    writeFileSync(path.join(s.path, 'hidden', 'big.bin'), Buffer.alloc(256 * 1024, 1));
    chmodSync(path.join(s.path, 'hidden'), 0o000);
    expect(await s.enforceLimit()).toMatch(/cannot be read.*emptied/);
    expect(readdirSync(s.path)).toEqual([]);
  });

  it.skipIf(!posix)('does not follow a link out of the directory when measuring or emptying', async () => {
    const outside = path.join(tmp, 'outside');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'keep.bin'), Buffer.alloc(256 * 1024, 1));
    const s = await createScratch(base, { bytes: 64 * 1024, entries: 1000 });
    spawnSync('ln', ['-s', outside, path.join(s.path, 'link')]);
    expect(await s.enforceLimit()).toBeUndefined();
    writeFileSync(path.join(s.path, 'big.bin'), Buffer.alloc(256 * 1024, 1));
    expect(await s.enforceLimit()).toMatch(/emptied/);
    expect(existsSync(path.join(outside, 'keep.bin'))).toBe(true);
    expect(await s.remove()).toBeUndefined();
    expect(existsSync(path.join(outside, 'keep.bin'))).toBe(true);
  });

  const deadPid = (): string => spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString();
  const recorded = (dir: string): void => writeFileSync(`${dir}.owner`, `agent-code-mode scratch ${path.basename(dir)}\n`, { mode: 0o600 });

  it('the sweep removes recorded directories of dead processes only, with their records', async () => {
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const deadDir = path.join(base, `${deadPid()}-${'a'.repeat(32)}`);
    const liveDir = path.join(base, `${process.ppid}-${'b'.repeat(32)}`);
    const unrelated = path.join(base, 'not-a-scratch-dir');
    for (const d of [deadDir, liveDir, unrelated]) mkdirSync(path.join(d, 'x'), { recursive: true });
    recorded(deadDir);
    recorded(liveDir);
    const mine = await createScratch(base);
    await sweepScratch(base);
    expect(existsSync(deadDir)).toBe(false);
    expect(existsSync(`${deadDir}.owner`)).toBe(false);
    expect(existsSync(liveDir)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
    expect(existsSync(mine.path)).toBe(true);
  });

  it('the sweep keeps a directory named like a dead run\'s that this server never recorded', async () => {
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const lookalike = path.join(base, `${deadPid()}-${'d'.repeat(32)}`);
    mkdirSync(lookalike);
    writeFileSync(path.join(lookalike, 'keep.txt'), 'mine');
    const forged = path.join(base, `${deadPid()}-${'e'.repeat(32)}`);
    mkdirSync(forged);
    writeFileSync(`${forged}.owner`, 'something else\n');
    await sweepScratch(base);
    expect(existsSync(path.join(lookalike, 'keep.txt'))).toBe(true);
    expect(existsSync(forged)).toBe(true);
  });

  it.skipIf(!posix)('the sweep touches nothing in a base other users can write, or one that is a link', async () => {
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const deadDir = path.join(base, `${deadPid()}-${'f'.repeat(32)}`);
    mkdirSync(deadDir);
    recorded(deadDir);
    chmodSync(base, 0o777);
    await sweepScratch(base);
    expect(existsSync(deadDir)).toBe(true);
    chmodSync(base, 0o700);
    const link = path.join(tmp, 'linked-base');
    spawnSync('ln', ['-s', base, link]);
    await sweepScratch(link);
    expect(existsSync(deadDir)).toBe(true);
  });

  it.skipIf(!posix)('the sweep does not follow a recorded name that is a link out of the base', async () => {
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const outside = path.join(tmp, 'outside');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'keep.txt'), 'x');
    const name = path.join(base, `${deadPid()}-${'9'.repeat(32)}`);
    spawnSync('ln', ['-s', outside, name]);
    recorded(name);
    await sweepScratch(base);
    expect(existsSync(path.join(outside, 'keep.txt'))).toBe(true);
  });

  it('the sweep of a missing base does nothing', async () => {
    await expect(sweepScratch(path.join(tmp, 'nothing-here'))).resolves.toBeUndefined();
  });
});
