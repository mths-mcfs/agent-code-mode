import { spawn } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolError } from '../core/errors.js';
import type { PolicySnapshot, ToolCall } from '../core/types.js';
import { makeContext } from '../testing/context.js';
import { cwdAnchor, procFdAnchor, rooted, within } from './rooted.js';
import { NodeToolRuntime } from './runtime.js';

const IS_WINDOWS = process.platform === 'win32';
const policy: PolicySnapshot = { host: 'generic', bashContainment: { mode: 'none' }, protectedPaths: [], payload: null };

let base: string;
let ws: string;
let outside: string;

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'acm-rooted-')));
  ws = path.join(base, 'ws');
  outside = path.join(base, 'outside');
  mkdirSync(path.join(ws, 'a'), { recursive: true });
  mkdirSync(path.join(outside, 'a'), { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function swapIn(): void {
  renameSync(path.join(ws, 'a'), path.join(ws, 'a-real'));
  nodeFs.symlinkSync(path.join(outside, 'a'), path.join(ws, 'a'), 'dir');
}

const anchors = [
  ...(process.platform === 'linux' ? [['/proc/self/fd', procFdAnchor] as const] : []),
  ...(IS_WINDOWS ? [] : [['working directory', cwdAnchor] as const]),
];

describe.each(anchors)('%s anchor', (_name, anchor) => {
  it('acts on the directory it reached even when that path is swapped for a link meanwhile', () => {
    anchor(rooted(ws, path.join(ws, 'a')), (at) => {
      swapIn();
      writeFileSync(at('new.txt'), 'x');
      nodeFs.mkdirSync(at('sub'));
      nodeFs.renameSync(at('new.txt'), at('moved.txt'));
      return readdirSync(at('.'));
    });
    expect(readdirSync(path.join(ws, 'a-real')).sort()).toEqual(['moved.txt', 'sub']);
    expect(readdirSync(path.join(outside, 'a'))).toEqual([]);
  });

  it('refuses a step that is a symbolic link', () => {
    swapIn();
    expect(() => anchor(rooted(ws, path.join(ws, 'a')), () => undefined)).toThrow(ToolError);
    expect(() => anchor(rooted(ws, path.join(ws, 'a')), () => undefined)).toThrow(/is a symbolic link/);
  });

  it('keeps the errno of a missing step', () => {
    expect(() => anchor(rooted(ws, path.join(ws, 'missing', 'deeper')), () => undefined)).toThrow(expect.objectContaining({ code: 'ENOENT' }));
  });

  it.skipIf(process.getuid?.() === 0)('walks through a directory it may search but not list, as a path lookup does', () => {
    mkdirSync(path.join(ws, 'a', 'b'));
    nodeFs.chmodSync(path.join(ws, 'a'), 0o311);
    try {
      expect(anchor(rooted(ws, path.join(ws, 'a', 'b')), (at) => nodeFs.lstatSync(at('.')).isDirectory())).toBe(true);
    } finally {
      nodeFs.chmodSync(path.join(ws, 'a'), 0o755);
    }
  });

  it('leaves the working directory where it was', () => {
    const before = process.cwd();
    anchor(rooted(ws, path.join(ws, 'a')), () => undefined);
    expect(process.cwd()).toBe(before);
  });
});

describe.skipIf(IS_WINDOWS)('working directory anchor when the server cwd disappears', () => {
  it('moves the process to the file system root and reports it once, never staying in the workspace', async () => {
    const before = process.cwd();
    const serverCwd = path.join(base, 'server-cwd');
    mkdirSync(serverCwd);
    const warnings: Error[] = [];
    const onWarning = (w: Error): void => {
      if ('code' in w && w.code === 'ACM_CWD_LOST') warnings.push(w);
    };
    process.on('warning', onWarning);
    process.chdir(serverCwd);
    try {
      cwdAnchor(rooted(ws, path.join(ws, 'a')), () => renameSync(serverCwd, `${serverCwd}-moved`));
      expect(process.cwd()).toBe(path.parse(ws).root);
      cwdAnchor(rooted(ws, path.join(ws, 'a')), () => undefined);
      expect(process.cwd()).toBe(path.parse(ws).root);
      await new Promise((resolve) => setImmediate(resolve));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.message).toContain(serverCwd);
    } finally {
      process.off('warning', onWarning);
      process.chdir(before);
    }
  });
});

describe.skipIf(!IS_WINDOWS)('Windows', () => {
  it('refuses rooted operations with the reason', () => {
    expect(() => within(rooted(ws, path.join(ws, 'a')), () => undefined)).toThrow(
      'read, write, edit, grep and glob are not available on Windows: Node cannot open a file relative to a directory handle there',
    );
  });

  it('refuses read, write, edit, grep and glob through the runtime', async () => {
    writeFileSync(path.join(ws, 'a', 'f.txt'), 'x\n');
    const rt = new NodeToolRuntime({ stateDir: path.join(base, 'state') });
    const ctx = makeContext(ws);
    const calls: ToolCall[] = [
      { id: 'r', tool: 'read', args: { path: 'a/f.txt' } },
      { id: 'w', tool: 'write', args: { path: 'a/f.txt', content: 'y\n' } },
      { id: 'e', tool: 'edit', args: { path: 'a/f.txt', oldString: 'x', newString: 'y' } },
      { id: 'g', tool: 'grep', args: { pattern: 'x' } },
      { id: 'G', tool: 'glob', args: { pattern: '**/*' } },
    ];
    for (const call of calls) {
      const outcome = rt.prepare(call, ctx, policy).then((prepared) => rt.commit(prepared, new AbortController().signal));
      await expect(outcome).rejects.toMatchObject({ code: 'containment-unavailable' });
    }
    expect(readFileSync(path.join(ws, 'a', 'f.txt'), 'utf8')).toBe('x\n');
  });
});

const ATTACKER = `
const fs = require('node:fs');
const [ws, outside, counter] = process.argv.slice(1);
const pause = new Int32Array(new SharedArrayBuffer(4));
const hold = (ms) => Atomics.wait(pause, 0, 0, Math.random() * ms);
fs.symlinkSync(outside + '/a', ws + '/a.lnk', 'dir');
for (let swaps = 1; ; swaps++) {
  try {
    fs.renameSync(ws + '/a', ws + '/a.real');
    fs.renameSync(ws + '/a.lnk', ws + '/a');
    hold(0.5);
    fs.renameSync(ws + '/a', ws + '/a.lnk');
    fs.renameSync(ws + '/a.real', ws + '/a');
    // Longer in the real state, so calls still land inside under load and the test cannot pass vacuously.
    hold(2);
  } catch {}
  if (swaps % 256 === 0) fs.writeFileSync(counter, String(swaps));
}
`;

describe.skipIf(IS_WINDOWS)('racing symlink swap', () => {
  it('never changes a file outside the workspace in 1000 writes and 1000 edits', { timeout: 120_000 }, async () => {
    const victim = path.join(outside, 'a', 'f.txt');
    writeFileSync(victim, 'same\n');
    writeFileSync(path.join(ws, 'a', 'f.txt'), 'same\n');
    const victimBefore = lstatSync(victim, { bigint: true });
    const rt = new NodeToolRuntime({ stateDir: path.join(base, 'state') });
    const ctx = makeContext(ws);
    const counter = path.join(base, 'swaps');
    const attacker = spawn(process.execPath, ['-e', ATTACKER, ws, outside, counter], { stdio: 'ignore' });
    const done = { write: 0, edit: 0, refused: 0 };
    const calls = (i: number): ToolCall[] => [
      { id: `w${i}`, tool: 'write', args: { path: 'a/f.txt', content: 'same\n' } },
      { id: `e${i}`, tool: 'edit', args: { path: 'a/f.txt', oldString: 'same', newString: 'SAME' } },
    ];
    try {
      for (let i = 0; i < 1000; i++) {
        for (const call of calls(i)) {
          try {
            await rt.commit(await rt.prepare(call, ctx, policy), new AbortController().signal);
            if (call.tool === 'write' || call.tool === 'edit') done[call.tool]++;
          } catch (err) {
            if (!(err instanceof ToolError)) throw err;
            done.refused++;
          }
        }
      }
    } finally {
      attacker.kill('SIGKILL');
      await new Promise((resolve) => attacker.once('exit', resolve));
    }
    const victimAfter = lstatSync(victim, { bigint: true });
    expect(readFileSync(victim, 'utf8')).toBe('same\n');
    expect([victimAfter.ino, victimAfter.mtimeNs]).toEqual([victimBefore.ino, victimBefore.mtimeNs]);
    expect(readdirSync(path.join(outside, 'a'))).toEqual(['f.txt']);
    const attackerSwaps = Number(readFileSync(counter, 'utf8'));
    const callsThatLandedInside = done.write + done.edit;
    expect(attackerSwaps).toBeGreaterThan(500);
    expect(callsThatLandedInside).toBeGreaterThan(0);
  });
});
