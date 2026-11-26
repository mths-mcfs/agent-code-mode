import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolError } from '../core/errors.js';
import type { PolicySnapshot, SessionContext, ToolCall, Transaction } from '../core/types.js';
import { makeContext } from '../testing/context.js';
import { ROOTED_OPS_REFUSED } from '../testing/platform.js';
import { FileTransaction, journalRoot } from './journal.js';
import { NodeToolRuntime } from './runtime.js';

let base: string;
let ws: string;
let stateDir: string;
let ctx: SessionContext;
let rt: NodeToolRuntime;
let seq = 0;
const policy: PolicySnapshot = { host: 'generic', bashContainment: { mode: 'none' }, protectedPaths: [], payload: null };
const signal = new AbortController().signal;

async function write(rel: string, content: string | Buffer, tx: Transaction): Promise<void> {
  const prepared = await rt.prepare({ id: `c${++seq}`, tool: 'write', args: { path: rel, content: content.toString() } } satisfies ToolCall, ctx, policy);
  await rt.commit(prepared, signal, tx);
}

const at = (rel: string): string => path.join(ws, rel);
const read = (rel: string): string => readFileSync(at(rel), 'utf8');

function begin(): FileTransaction {
  const tx = rt.beginTransaction();
  if (!(tx instanceof FileTransaction)) throw new Error('expected a FileTransaction');
  return tx;
}

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'acm-undo-')));
  ws = path.join(base, 'ws');
  stateDir = path.join(base, 'state');
  mkdirSync(ws);
  ctx = makeContext(ws);
  rt = new NodeToolRuntime({ stateDir });
  writeFileSync(at('a.txt'), 'a0\n');
  writeFileSync(at('b.txt'), 'b0\n');
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(base, { recursive: true, force: true });
});

describe.skipIf(ROOTED_OPS_REFUSED)('FileTransaction.undo', () => {
  it('puts every file back byte for byte, removes created files and directories, and the run goes on', async () => {
    const original = Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a, 0x62]);
    writeFileSync(at('a.txt'), original);
    if (process.platform !== 'win32') chmodSync(at('a.txt'), 0o640);
    const tx = begin();
    await write('a.txt', 'a1\n', tx);
    await write('a.txt', 'a2\n', tx);
    await write('new/dir/c.txt', 'c1\n', tx);
    const report = await tx.undo();
    expect(report.skipped).toEqual([]);
    expect([...report.restored].sort()).toEqual([at('a.txt'), at('new/dir/c.txt')].sort());
    expect(readFileSync(at('a.txt')).equals(original)).toBe(true);
    if (process.platform !== 'win32') expect(statSync(at('a.txt')).mode & 0o777).toBe(0o640);
    expect(existsSync(at('new'))).toBe(false);
    await write('b.txt', 'b1\n', tx);
    await tx.dispose();
    expect(read('b.txt')).toBe('b1\n');
    await vi.waitFor(() => expect(readdirSync(journalRoot(stateDir))).toEqual([]));
  });

  it('undoes only the files accepted', async () => {
    const tx = begin();
    await write('a.txt', 'a1\n', tx);
    await write('b.txt', 'b1\n', tx);
    const report = await tx.undo((p) => p === at('a.txt'));
    expect(report).toEqual({ restored: [at('a.txt')], skipped: [] });
    expect(read('a.txt')).toBe('a0\n');
    expect(read('b.txt')).toBe('b1\n');
    await tx.rollback();
    expect(read('b.txt')).toBe('b0\n');
  });

  it('never restores a file someone else changed since, keeps refusing to write it, and rollback leaves it too', async () => {
    const tx = begin();
    await write('a.txt', 'a1\n', tx);
    await write('b.txt', 'b1\n', tx);
    writeFileSync(at('a.txt'), 'someone else\n');
    const report = await tx.undo();
    expect(report.restored).toEqual([at('b.txt')]);
    expect(report.skipped).toEqual([{ path: at('a.txt'), reason: 'changed-externally', detail: expect.any(String) }]);
    expect(read('a.txt')).toBe('someone else\n');
    await expect(write('a.txt', 'a2\n', tx)).rejects.toMatchObject({ code: 'stale' });
    expect(read('a.txt')).toBe('someone else\n');
    const rolled = await tx.rollback();
    expect(rolled.restored).toEqual([]);
    expect(read('a.txt')).toBe('someone else\n');
  });

  it('leaves a file the run created alone when someone else rewrote it', async () => {
    const tx = begin();
    await write('c.txt', 'mine\n', tx);
    writeFileSync(at('c.txt'), 'theirs\n');
    const report = await tx.undo();
    expect(report.skipped.map((s) => s.path)).toEqual([at('c.txt')]);
    expect(read('c.txt')).toBe('theirs\n');
  });

  it('a write after undo journals the restored content as the new original', async () => {
    const tx = begin();
    await write('a.txt', 'a1\n', tx);
    await tx.undo();
    await write('a.txt', 'a2\n', tx);
    await tx.rollback();
    expect(read('a.txt')).toBe('a0\n');
  });

  it('is refused once the transaction finished', async () => {
    const tx = begin();
    await write('a.txt', 'a1\n', tx);
    await tx.dispose();
    await expect(tx.undo()).rejects.toBeInstanceOf(ToolError);
    expect(read('a.txt')).toBe('a1\n');
  });

  it('runs again with nothing left to do', async () => {
    const tx = begin();
    await write('a.txt', 'a1\n', tx);
    await tx.undo();
    expect(await tx.undo()).toEqual({ restored: [], skipped: [] });
    await tx.dispose();
  });
});
