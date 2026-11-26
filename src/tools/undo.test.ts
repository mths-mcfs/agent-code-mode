import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolError } from '../core/errors.js';
import type { PolicySnapshot, SessionContext, ToolCall, Transaction } from '../core/types.js';
import { makeContext } from '../testing/context.js';
import { ROOTED_OPS_REFUSED } from '../testing/platform.js';
import { FileTransaction, type JournalIo, journalRoot, recoverStaleJournals } from './journal.js';
import { sha256, syncDirStrict } from './fs-ops.js';
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

  it('writes nothing when someone else already put the original back, and reports the file as back', async () => {
    const tx = begin();
    await write('a.txt', 'a1\n', tx);
    writeFileSync(at('a.txt'), 'a0\n');
    const before = statSync(at('a.txt')).ino;
    expect(await tx.undo()).toEqual({ restored: [at('a.txt')], skipped: [] });
    expect(statSync(at('a.txt')).ino).toBe(before);
    expect(read('a.txt')).toBe('a0\n');
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

  it('never gives a new original the blob name of one still held, after an undo', async () => {
    writeFileSync(at('c.txt'), 'c0\n');
    const tx = begin();
    await write('a.txt', 'a1\n', tx);
    await write('b.txt', 'b1\n', tx);
    await tx.undo((p) => p === at('a.txt'));
    await write('c.txt', 'c1\n', tx);
    // Crash recovery restores from the blobs on disk, not from memory: each must still hold its own original.
    const manifest = JSON.parse(readFileSync(path.join(tx.dir, 'manifest.json'), 'utf8')) as { entries: { path: string; original: string; blob: string | null }[] };
    const blobs = manifest.entries.map((e) => e.blob);
    expect(new Set(blobs).size).toBe(blobs.length);
    for (const e of manifest.entries) expect(sha256(readFileSync(path.join(tx.dir, e.blob ?? '')))).toBe(e.original);
    await tx.rollback();
    expect(read('b.txt')).toBe('b0\n');
  });

  it('keeps an entry in the record when its restore could not be flushed', async () => {
    let failing = false;
    const io: { -readonly [K in keyof JournalIo]: JournalIo[K] } = {
      syncDir: async (dir, expected) => {
        if (failing && dir === ws) throw new Error('flush failed');
        await syncDirStrict(dir, expected);
      },
      removeDir: (dir) => import('node:fs/promises').then((fs) => fs.rm(dir, { recursive: true, force: true })),
    };
    const tx = new FileTransaction(stateDir, io);
    await write('a.txt', 'a1\n', tx);
    failing = true;
    expect((await tx.undo()).restored).toEqual([at('a.txt')]);
    const manifest = JSON.parse(readFileSync(path.join(tx.dir, 'manifest.json'), 'utf8')) as { entries: { path: string }[] };
    expect(manifest.entries.map((e) => e.path)).toEqual([at('a.txt')]);
    const flushed: string[] = [];
    io.syncDir = async (dir, expected) => {
      flushed.push(dir);
      await syncDirStrict(dir, expected);
    };
    failing = false;
    await tx.rollback();
    expect(read('a.txt')).toBe('a0\n');
    expect(flushed).toContain(ws);
  });

  it('deletes the saved originals of undone files, so a write-and-undo loop does not pile them up', async () => {
    const tx = begin();
    for (let i = 0; i < 5; i++) {
      await write('a.txt', `a${i + 1}\n`, tx);
      await tx.undo();
    }
    expect(readdirSync(tx.dir).filter((n) => n.endsWith('.bin'))).toEqual([]);
    await write('b.txt', 'b1\n', tx);
    expect(readdirSync(tx.dir).filter((n) => n.endsWith('.bin'))).toHaveLength(1);
    await tx.rollback();
    expect(read('a.txt')).toBe('a0\n');
    expect(read('b.txt')).toBe('b0\n');
  });

  it('recovery settles a file an undo put back just before the process died, with no conflict', async () => {
    // The flush after the restore fails, so the record on disk is left as a crash right after the restore leaves it:
    // the entry is still there, marked as being undone, and the file holds its original again.
    const io: JournalIo = {
      syncDir: async (dir, expected) => {
        if (dir === ws && stage === 'undo') throw new Error('killed here');
        await syncDirStrict(dir, expected);
      },
      removeDir: (dir) => import('node:fs/promises').then((fs) => fs.rm(dir, { recursive: true, force: true })),
    };
    let stage = 'write';
    const tx = new FileTransaction(stateDir, io);
    await write('a.txt', 'a1\n', tx);
    stage = 'undo';
    await tx.undo();
    const manifestPath = path.join(tx.dir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { pid: number; entries: { undoing?: true }[] };
    expect(manifest.entries.map((e) => e.undoing)).toEqual([true]);
    const pid = spawnSync(process.execPath, ['-e', '']).pid ?? 999_999;
    manifest.pid = pid;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const [stamp, , hex] = path.basename(tx.dir).split('-');
    renameSync(tx.dir, path.join(path.dirname(tx.dir), `${stamp}-${pid}-${hex}`));
    const recovered = await recoverStaleJournals(stateDir, [ws], []);
    expect(recovered.flatMap((r) => r.report.skipped)).toEqual([]);
    // Counted as restored, so recovery flushes its directory before it drops the record.
    expect(recovered.flatMap((r) => r.report.restored)).toEqual([at('a.txt')]);
    expect(read('a.txt')).toBe('a0\n');
    expect(readdirSync(journalRoot(stateDir))).toEqual([]);
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
