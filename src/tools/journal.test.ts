import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolError } from '../core/errors.js';
import type { PolicySnapshot, SessionContext, ToolCall, Transaction } from '../core/types.js';
import { makeContext } from '../testing/context.js';
import { FileTransaction, journalRoot, recoverStaleJournals } from './journal.js';
import { NodeToolRuntime } from './runtime.js';

let base: string;
let ws: string;
let outside: string;
let stateDir: string;
let ctx: SessionContext;
let rt: NodeToolRuntime;
let seq = 0;
const policy: PolicySnapshot = { host: 'generic', bashContainment: { mode: 'none' }, protectedPaths: [], payload: null };
const signal = new AbortController().signal;

async function write(rel: string, content: string, tx: Transaction): Promise<void> {
  const prepared = await rt.prepare({ id: `c${++seq}`, tool: 'write', args: { path: rel, content } } satisfies ToolCall, ctx, policy);
  await rt.commit(prepared, signal, tx);
}

const read = (rel: string): string => readFileSync(path.join(ws, rel), 'utf8');

/** A pid that belonged to a process that has exited. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', '']);
  return r.pid ?? 999_999;
}

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'acm-journal-')));
  ws = path.join(base, 'ws');
  outside = path.join(base, 'outside');
  stateDir = path.join(base, 'state');
  mkdirSync(ws);
  mkdirSync(outside);
  ctx = makeContext(ws);
  rt = new NodeToolRuntime({ stateDir });
  writeFileSync(path.join(ws, 'a.txt'), 'a0\n');
  writeFileSync(path.join(ws, 'b.txt'), 'b0\n');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('transactions', () => {
  it('rolls back three writes (two edits and a create in a new directory)', async () => {
    const tx = rt.beginTransaction();
    await write('a.txt', 'a1\n', tx);
    await write('a.txt', 'a2\n', tx);
    await write('b.txt', 'b1\n', tx);
    await write('new/dir/c.txt', 'c1\n', tx);
    expect(existsSync(path.join(stateDir, 'journal'))).toBe(true);
    const report = await tx.rollback();
    expect(report.skipped).toEqual([]);
    expect([...report.restored].sort()).toEqual([path.join(ws, 'a.txt'), path.join(ws, 'b.txt'), path.join(ws, 'new/dir/c.txt')].sort());
    expect(read('a.txt')).toBe('a0\n');
    expect(read('b.txt')).toBe('b0\n');
    expect(existsSync(path.join(ws, 'new'))).toBe(false);
    expect(readdirSync(journalRoot(stateDir))).toEqual([]);
  });

  it('does not clobber a file changed externally after our write, and reports it', async () => {
    const tx = rt.beginTransaction();
    await write('a.txt', 'a1\n', tx);
    await write('b.txt', 'b1\n', tx);
    writeFileSync(path.join(ws, 'a.txt'), 'edited by someone else\n');
    const report = await tx.rollback();
    expect(report.restored).toEqual([path.join(ws, 'b.txt')]);
    expect(report.skipped).toEqual([{ path: path.join(ws, 'a.txt'), reason: 'changed-externally', detail: expect.any(String) }]);
    expect(read('a.txt')).toBe('edited by someone else\n');
    expect(read('b.txt')).toBe('b0\n');
  });

  it('keeps changes and deletes the journal on dispose, and refuses writes afterwards', async () => {
    const tx = rt.beginTransaction();
    await write('a.txt', 'a1\n', tx);
    await tx.dispose();
    await tx.dispose();
    expect(read('a.txt')).toBe('a1\n');
    expect(readdirSync(journalRoot(stateDir))).toEqual([]);
    await expect(write('b.txt', 'b1\n', tx)).rejects.toBeInstanceOf(ToolError);
    expect(read('b.txt')).toBe('b0\n');
  });

  it('refuses a write that would push the journal past its size cap', async () => {
    const big = Buffer.alloc(33 * 1024 * 1024, 0x61);
    writeFileSync(path.join(ws, 'big1.txt'), big);
    writeFileSync(path.join(ws, 'big2.txt'), big);
    const tx = rt.beginTransaction();
    await write('big1.txt', 'small\n', tx);
    const err = await write('big2.txt', 'small\n', tx).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ToolError);
    expect(String(err)).toMatch(/journal is full/);
    expect(readFileSync(path.join(ws, 'big2.txt')).length).toBe(big.length);
    const report = await tx.rollback();
    expect(report.restored).toEqual([path.join(ws, 'big1.txt')]);
    expect(readFileSync(path.join(ws, 'big1.txt')).equals(big)).toBe(true);
  });

  it('refuses a transaction it did not start', async () => {
    const foreign: Transaction = { rollback: async () => ({ restored: [], skipped: [] }), dispose: async () => undefined };
    await expect(write('a.txt', 'a1\n', foreign)).rejects.toThrow(/not started by this tool runtime/);
    expect(read('a.txt')).toBe('a0\n');
  });
});

describe('crash recovery', () => {
  /** Makes the journal of `tx` look like it was left by a process that died. */
  function abandon(tx: FileTransaction): string {
    const dir = tx.dir;
    const manifestPath = path.join(dir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { pid: number };
    const pid = deadPid();
    manifest.pid = pid;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const [stamp, , hex] = path.basename(dir).split('-');
    const moved = path.join(path.dirname(dir), `${stamp}-${pid}-${hex}`);
    renameSync(dir, moved);
    return moved;
  }

  it('restores a journal whose process is gone, and leaves a live one alone', async () => {
    const crashed = rt.beginTransaction();
    if (!(crashed instanceof FileTransaction)) throw new Error('unreachable');
    await write('a.txt', 'a1\n', crashed);
    await write('new.txt', 'n1\n', crashed);
    await write('b.txt', 'b1\n', crashed);
    writeFileSync(path.join(ws, 'b.txt'), 'changed after the crash\n');
    const moved = abandon(crashed);

    const live = rt.beginTransaction();
    writeFileSync(path.join(ws, 'live.txt'), 'l0\n');
    await write('live.txt', 'l1\n', live);

    const recovered = await recoverStaleJournals(stateDir, [ws]);
    expect(recovered).toHaveLength(1);
    const report = recovered[0]?.report;
    expect([...(report?.restored ?? [])].sort()).toEqual([path.join(ws, 'a.txt'), path.join(ws, 'new.txt')]);
    expect(report?.skipped).toEqual([{ path: path.join(ws, 'b.txt'), reason: 'changed-externally', detail: expect.any(String) }]);
    expect(read('a.txt')).toBe('a0\n');
    expect(existsSync(path.join(ws, 'new.txt'))).toBe(false);
    expect(read('b.txt')).toBe('changed after the crash\n');
    expect(read('live.txt')).toBe('l1\n');
    expect(existsSync(moved)).toBe(false);
    await live.dispose();
  });

  it('ignores journals of other workspaces and never restores outside the roots', async () => {
    const tx = rt.beginTransaction();
    if (!(tx instanceof FileTransaction)) throw new Error('unreachable');
    await write('a.txt', 'a1\n', tx);
    const moved = abandon(tx);
    // Another workspace: nothing happens.
    expect(await recoverStaleJournals(stateDir, [outside])).toEqual([]);
    expect(read('a.txt')).toBe('a1\n');

    // A tampered record pointing outside the roots is not followed.
    writeFileSync(path.join(outside, 'victim.txt'), 'victim\n');
    const manifestPath = path.join(moved, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { entries: { path: string }[] };
    const first = manifest.entries[0];
    if (first) first.path = path.join(outside, 'victim.txt');
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const recovered = await recoverStaleJournals(stateDir, [ws]);
    expect(recovered[0]?.report.restored).toEqual([]);
    expect(recovered[0]?.report.skipped[0]?.reason).toBe('error');
    expect(readFileSync(path.join(outside, 'victim.txt'), 'utf8')).toBe('victim\n');
  });

  it('skips a malformed record', async () => {
    mkdirSync(path.join(journalRoot(stateDir), 'zz-1-abcd'), { recursive: true });
    writeFileSync(path.join(journalRoot(stateDir), 'zz-1-abcd', 'manifest.json'), '{"version":1,"entries":"nope"}');
    expect(await recoverStaleJournals(stateDir, [ws])).toEqual([]);
  });
});
