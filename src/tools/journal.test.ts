import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolError, TransactionFinalizeError } from '../core/errors.js';
import type { PolicySnapshot, SessionContext, ToolCall, Transaction } from '../core/types.js';
import { makeContext } from '../testing/context.js';
import { COMMITTED, FileTransaction, type JournalIo, journalRoot, recoverStaleJournals } from './journal.js';
import { atomicWrite, sha256, syncDirStrict } from './fs-ops.js';
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

const IS_WINDOWS = process.platform === 'win32';

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

it.runIf(IS_WINDOWS)('refuses a transactional write on Windows before the file changes, and keeps plain writes', async () => {
  const tx = rt.beginTransaction();
  await expect(write('a.txt', 'a1\n', tx)).rejects.toThrow(/refused to write .*Windows cannot flush the directory/);
  expect(read('a.txt')).toBe('a0\n');
  const prepared = await rt.prepare({ id: `c${++seq}`, tool: 'write', args: { path: 'a.txt', content: 'a1\n' } } satisfies ToolCall, ctx, policy);
  await rt.commit(prepared, signal);
  expect(read('a.txt')).toBe('a1\n');
});

describe.skipIf(IS_WINDOWS)('transactions', () => {
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
    await vi.waitFor(() => expect(readdirSync(journalRoot(stateDir))).toEqual([]));
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

  it('refuses to write again a file another writer changed since this transaction wrote it', async () => {
    const mine = rt.beginTransaction();
    const other = rt.beginTransaction();
    await write('a.txt', 'mine\n', mine);
    await write('a.txt', 'other\n', other);
    await other.dispose();
    await expect(write('a.txt', 'mine again\n', mine)).rejects.toMatchObject({ code: 'stale' });
    await mine.rollback();
    expect(read('a.txt')).toBe('other\n');
  });

  it('rolls back only directories its own writes created', async () => {
    const tx = rt.beginTransaction();
    if (!(tx instanceof FileTransaction)) throw new Error('unreachable');
    const dir = path.join(ws, 'shared');
    const abs = path.join(dir, 'x.txt');
    const bytes = Buffer.from('x\n');
    const outcome = await atomicWrite(abs, bytes, { kind: 'absent' }, {
      beforeWrite: async (before, dirs) => {
        await tx.record(abs, ws, before, sha256(bytes), dirs);
        // Another writer creates the directory between the checks and the write.
        mkdirSync(dir);
      },
    });
    tx.written(abs, sha256(bytes), outcome.createdDirs);
    await tx.rollback();
    expect(existsSync(abs)).toBe(false);
    expect(existsSync(dir)).toBe(true);
  });

  it('refuses a transaction it did not start', async () => {
    const foreign: Transaction = { rollback: async () => ({ restored: [], skipped: [] }), dispose: async () => undefined };
    await expect(write('a.txt', 'a1\n', foreign)).rejects.toThrow(/not started by this tool runtime/);
    expect(read('a.txt')).toBe('a0\n');
  });
});

describe.skipIf(IS_WINDOWS)('crash recovery', () => {
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

  it('recovers a journal without write timestamps and preserves directories with unknown ownership', async () => {
    const pid = deadPid();
    const dir = path.join(journalRoot(stateDir), `old-${pid}-abcd`);
    const shared = path.join(ws, 'shared');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    mkdirSync(shared);
    writeFileSync(path.join(ws, 'a.txt'), 'a1\n');
    writeFileSync(path.join(dir, '0.bin'), 'a0\n');
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      version: 1, pid, host: os.hostname(), startedAt: 0, roots: [ws], dirs: [shared],
      entries: [{
        path: path.join(ws, 'a.txt'), existed: true, original: sha256('a0\n'),
        mode: 0o644, blob: '0.bin', written: [sha256('a1\n')],
      }],
    }));

    const recovered = await recoverStaleJournals(stateDir, [ws], []);

    expect(recovered[0]?.report.restored).toEqual([path.join(ws, 'a.txt')]);
    expect(read('a.txt')).toBe('a0\n');
    expect(existsSync(shared)).toBe(true);
  });

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

    const recovered = await recoverStaleJournals(stateDir, [ws], []);
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
    expect(await recoverStaleJournals(stateDir, [outside], [])).toEqual([]);
    expect(read('a.txt')).toBe('a1\n');

    // A tampered record pointing outside the roots is not followed.
    writeFileSync(path.join(outside, 'victim.txt'), 'victim\n');
    const manifestPath = path.join(moved, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { entries: { path: string }[] };
    const first = manifest.entries[0];
    if (first) first.path = path.join(outside, 'victim.txt');
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const recovered = await recoverStaleJournals(stateDir, [ws], []);
    expect(recovered[0]?.report.restored).toEqual([]);
    expect(recovered[0]?.report.skipped[0]?.reason).toBe('error');
    expect(readFileSync(path.join(outside, 'victim.txt'), 'utf8')).toBe('victim\n');
    // A record with a file it could not handle is kept for a later pass.
    expect(readdirSync(journalRoot(stateDir))).toHaveLength(1);
  });

  it('undoes writes newest first across journals, whatever order the runs started in', async () => {
    const first = rt.beginTransaction();
    const second = rt.beginTransaction();
    if (!(first instanceof FileTransaction) || !(second instanceof FileTransaction)) throw new Error('unreachable');
    await write('a.txt', 'second\n', second);
    await new Promise((r) => setTimeout(r, 5));
    await write('a.txt', 'first\n', first);
    abandon(first);
    abandon(second);
    await recoverStaleJournals(stateDir, [ws], []);
    expect(read('a.txt')).toBe('a0\n');
  });

  it('never restores a protected path', async () => {
    const tx = rt.beginTransaction();
    if (!(tx instanceof FileTransaction)) throw new Error('unreachable');
    await write('a.txt', 'a1\n', tx);
    abandon(tx);
    const recovered = await recoverStaleJournals(stateDir, [ws], [path.join(ws, 'a.txt')]);
    expect(recovered[0]?.report.skipped).toEqual([{ path: path.join(ws, 'a.txt'), reason: 'error', detail: expect.stringContaining('protected') }]);
    expect(read('a.txt')).toBe('a1\n');
  });

  it.skipIf(IS_WINDOWS)('reads and deletes nothing in a journal directory other users can write', async () => {
    const tx = rt.beginTransaction();
    if (!(tx instanceof FileTransaction)) throw new Error('unreachable');
    await write('a.txt', 'a1\n', tx);
    abandon(tx);
    mkdirSync(path.join(journalRoot(stateDir), `zz-1-abcd${COMMITTED}`));
    chmodSync(journalRoot(stateDir), 0o777);
    expect(await recoverStaleJournals(stateDir, [ws], [])).toEqual([]);
    expect(read('a.txt')).toBe('a1\n');
    expect(readdirSync(journalRoot(stateDir))).toHaveLength(2);
  });

  it('deletes only finalized transaction directories', async () => {
    const root = journalRoot(stateDir);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    mkdirSync(path.join(root, `notes${COMMITTED}`));
    mkdirSync(path.join(root, `zz-1-abcd${COMMITTED}`));
    await recoverStaleJournals(stateDir, [ws], []);
    expect(readdirSync(root)).toEqual([`notes${COMMITTED}`]);
  });

  it('skips a malformed record', async () => {
    mkdirSync(path.join(journalRoot(stateDir), 'zz-1-abcd'), { recursive: true });
    writeFileSync(path.join(journalRoot(stateDir), 'zz-1-abcd', 'manifest.json'), '{"version":1,"entries":"nope"}');
    expect(await recoverStaleJournals(stateDir, [ws], [])).toEqual([]);
  });
});

describe.skipIf(IS_WINDOWS)('finalization', () => {
  /** Keeps the delete of a finalized journal pending, as if the process died right after the commit. */
  const held = (): Promise<void> => new Promise(() => undefined);

  it('commits by renaming the journal, so recovery never undoes a finalized run', async () => {
    const tx = new FileTransaction(stateDir, { syncDir: syncDirStrict, removeDir: held });
    await write('a.txt', 'a1\n', tx);
    await write('new.txt', 'n1\n', tx);
    await tx.dispose();
    // The delete never ran: the record is still complete, under the committed name.
    expect(existsSync(tx.dir)).toBe(false);
    expect(existsSync(path.join(`${tx.dir}${COMMITTED}`, 'manifest.json'))).toBe(true);

    expect(await recoverStaleJournals(stateDir, [ws], [])).toEqual([]);
    expect(read('a.txt')).toBe('a1\n');
    expect(read('new.txt')).toBe('n1\n');
    // Recovery deletes what a finalized run left behind.
    expect(readdirSync(journalRoot(stateDir))).toEqual([]);
  });

  it('reports a committed but not flushed journal and never rolls it back', async () => {
    let failing = false;
    const io: JournalIo = {
      syncDir: async (dir) => {
        if (failing && dir === journalRoot(stateDir)) throw new Error('EIO: flush failed');
      },
      removeDir: held,
    };
    const tx = new FileTransaction(stateDir, io);
    await write('a.txt', 'a1\n', tx);
    failing = true;
    const err = await tx.dispose().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TransactionFinalizeError);
    expect(err).toMatchObject({ committed: true });
    expect(String(err)).toMatch(/durability is not guaranteed/);
    // Asked again, finalization settles the same way.
    await expect(tx.dispose()).rejects.toBe(err);
    expect(existsSync(path.join(`${tx.dir}${COMMITTED}`, 'manifest.json'))).toBe(true);
    expect(await tx.rollback()).toEqual({ restored: [], skipped: [] });
    expect(await recoverStaleJournals(stateDir, [ws], [])).toEqual([]);
    expect(read('a.txt')).toBe('a1\n');
  });

  it('refuses the write when its journal record cannot be flushed', async () => {
    const tx = new FileTransaction(stateDir, {
      syncDir: async () => {
        throw new Error('EIO: flush failed');
      },
      removeDir: held,
    });
    await expect(write('a.txt', 'a1\n', tx)).rejects.toThrow(/EIO/);
    expect(read('a.txt')).toBe('a0\n');
  });

  it('keeps the journal open for a rollback when the commit rename fails', async () => {
    const tx = rt.beginTransaction();
    if (!(tx instanceof FileTransaction)) throw new Error('unreachable');
    await write('a.txt', 'a1\n', tx);
    // A non-empty directory in the way makes the rename fail.
    mkdirSync(path.join(`${tx.dir}${COMMITTED}`, 'blocker'), { recursive: true });
    const err = await tx.dispose().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TransactionFinalizeError);
    expect(err).toMatchObject({ committed: false });
    expect(existsSync(path.join(tx.dir, 'manifest.json'))).toBe(true);
    const report = await tx.rollback();
    expect(report.restored).toEqual([path.join(ws, 'a.txt')]);
    expect(read('a.txt')).toBe('a0\n');
  });

  function workspaceFlushFails(code: string, failing: () => boolean): JournalIo {
    const inWorkspace = (dir: string): boolean => dir === ws || dir.startsWith(`${ws}${path.sep}`);
    return {
      syncDir: (dir) =>
        syncDirStrict(dir, async (d) => {
          if (failing() && inWorkspace(d)) throw Object.assign(new Error(`${code}: directory fsync`), { code });
          await syncDirStrict(d);
        }),
      removeDir: held,
    };
  }

  it('refuses a transactional write, before the file changes, where its directory cannot be flushed', async () => {
    const tx = new FileTransaction(stateDir, workspaceFlushFails('EINVAL', () => true));
    await expect(write('a.txt', 'a1\n', tx)).rejects.toThrow(/refused to write .*cannot flush a directory to disk/);
    await expect(write('sub/new.txt', 'n1\n', tx)).rejects.toThrow(/refused to write/);
    expect(read('a.txt')).toBe('a0\n');
    expect(existsSync(path.join(ws, 'sub'))).toBe(false);
  });

  it('flushes every directory the run changed before the commit makes the journal unrecoverable', async () => {
    const flushed: { dir: string; committed: boolean }[] = [];
    let txDir = '';
    const tx = new FileTransaction(stateDir, {
      syncDir: async (dir) => {
        flushed.push({ dir, committed: existsSync(`${txDir}${COMMITTED}`) });
        await syncDirStrict(dir);
      },
      removeDir: held,
    });
    txDir = tx.dir;
    await write('a.txt', 'a1\n', tx);
    await write('d1/d2/new.txt', 'n1\n', tx);
    const before = flushed.length;
    await tx.dispose();
    const atDispose = flushed.slice(before);
    const uncommitted = atDispose.filter((f) => !f.committed).map((f) => f.dir);
    expect(uncommitted).toEqual(expect.arrayContaining([ws, path.join(ws, 'd1'), path.join(ws, 'd1', 'd2')]));
    expect(atDispose.at(-1)).toEqual({ dir: journalRoot(stateDir), committed: true });
  });

  it('keeps the journal open for a rollback when a changed directory cannot be flushed at finalization', async () => {
    let failing = false;
    const tx = new FileTransaction(stateDir, workspaceFlushFails('EIO', () => failing));
    await write('a.txt', 'a1\n', tx);
    failing = true;
    await expect(tx.dispose()).rejects.toMatchObject({ name: 'TransactionFinalizeError', committed: false });
    expect(existsSync(path.join(tx.dir, 'manifest.json'))).toBe(true);
    failing = false;
    expect((await tx.rollback()).restored).toEqual([path.join(ws, 'a.txt')]);
    expect(read('a.txt')).toBe('a0\n');
  });

  it('keeps the record of a rollback whose restore cannot be flushed, for recovery to finish', async () => {
    let failing = false;
    const tx = new FileTransaction(stateDir, workspaceFlushFails('EIO', () => failing));
    await write('a.txt', 'a1\n', tx);
    failing = true;
    expect((await tx.rollback()).restored).toEqual([path.join(ws, 'a.txt')]);
    expect(read('a.txt')).toBe('a0\n');
    expect(existsSync(path.join(tx.dir, 'manifest.json'))).toBe(true);
    expect(await recoverStaleJournals(stateDir, [ws], [])).toEqual([{ id: tx.id, report: { restored: [], skipped: [] } }]);
    expect(readdirSync(journalRoot(stateDir))).toEqual([]);
  });

  it('flushes every directory it creates for the journal, so a crash cannot lose the record', async () => {
    const flushed: string[] = [];
    const tx = new FileTransaction(stateDir, {
      syncDir: async (dir) => {
        flushed.push(dir);
        await syncDirStrict(dir);
      },
      removeDir: held,
    });
    await write('a.txt', 'a1\n', tx);
    expect(flushed).toEqual(expect.arrayContaining([base, stateDir, journalRoot(stateDir), tx.dir]));
  });
});
