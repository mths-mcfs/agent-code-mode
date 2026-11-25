import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync, renameSync, linkSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeContext } from '../testing/index.js';
import { FileTransaction, recoverStaleJournals } from './journal.js';
import { NodeToolRuntime } from './runtime.js';
import { syncDirStrict } from './fs-ops.js';

let base: string;
let workspace: string;
let state: string;
let target: string;
let runtime: NodeToolRuntime;
const time = 1_700_000_000;
const policy = { host: 'generic', bashContainment: { mode: 'none' }, protectedPaths: [], payload: null } as const;

beforeEach(() => {
  base = mkdtempSync(path.join(os.tmpdir(), 'l1-verifier-'));
  workspace = path.join(base, 'workspace');
  state = path.join(base, 'state');
  mkdirSync(workspace);
  target = path.join(workspace, 'file');
  writeFileSync(target, 'original');
  runtime = new NodeToolRuntime({ stateDir: state });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(base, { recursive: true, force: true });
});

async function write(tx: FileTransaction, content = 'pending') {
  const prepared = await runtime.prepare({ id: 'write', tool: 'write', args: { path: 'file', content } }, makeContext(workspace), { ...policy, protectedPaths: [] });
  return runtime.commit(prepared, new AbortController().signal, tx);
}

function abandon(tx: FileTransaction, edit = (raw: string) => raw) {
  const dead = execFileSync(process.execPath, ['-p', 'process.pid'], { encoding: 'utf8' }).trim();
  const manifest = path.join(tx.dir, 'manifest.json');
  const raw = readFileSync(manifest, 'utf8');
  expect(raw).toContain(`"pid":${process.pid},`);
  writeFileSync(manifest, edit(raw.replace(`"pid":${process.pid},`, `"pid":${dead},`)));
}

const recover = () => recoverStaleJournals(state, [workspace], []);
const bytes = () => readFileSync(target, 'utf8');

function installId(file: string) {
  const st = statSync(file, { bigint: true });
  return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}`;
}

function coarseMtime() {
  const open = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
    const handle = await open(file, flags, mode);
    if (typeof file === 'string' && path.dirname(file) === workspace && file.endsWith('.tmp')) {
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, 'sync').mockImplementation(async () => {
        await handle.utimes(time, time);
        await sync();
      });
    }
    return handle;
  });
}

class UnconfirmedInstall extends FileTransaction {
  override written(): Promise<void> {
    return Promise.resolve();
  }
}

it('cleans the temp left by a crash immediately before rename and preserves old target', async () => {
  const tx = new FileTransaction(state);
  const rename = fs.rename.bind(fs);
  let temp = '';
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (to === target) {
      temp = String(from);
      expect(readFileSync(path.join(tx.dir, 'manifest.json'), 'utf8')).toContain(installId(temp));
      throw new Error('cut immediately before rename');
    }
    await rename(from, to);
  });
  const rm = fs.rm.bind(fs);
  vi.spyOn(fs, 'rm').mockImplementation(async (file, options) => {
    if (file !== temp) await rm(file, options);
  });
  await expect(write(tx)).rejects.toThrow('cut immediately before rename');
  vi.restoreAllMocks();
  expect(existsSync(temp)).toBe(true);
  abandon(tx);
  expect((await recover())[0]?.report.restored).toEqual([]);
  expect(bytes()).toBe('original');
  expect(readdirSync(workspace)).toEqual(['file']);
});

it('preserves later unrelated bytes on reuse of a temp inode with the same coarse mtime', async () => {
  coarseMtime();
  const tx = new UnconfirmedInstall(state);
  await write(tx);
  const deletedId = installId(target);
  rmSync(target);
  writeFileSync(target, 'pending');
  utimesSync(target, time, time);
  const replacementId = installId(target);
  if (deletedId !== replacementId) {
    // The Btrfs test volume does not immediately recycle this inode.
    // Model reuse at the persisted boundary while leaving all reads/writes real.
    abandon(tx, (raw) => {
      expect(raw).toContain(deletedId);
      return raw.replace(deletedId, replacementId);
    });
  } else {
    abandon(tx);
  }
  expect((await recover())[0]?.report.skipped[0]?.reason).toBe('changed-externally');
  expect(bytes()).toBe('pending');
});

it.each([
  { confirmed: true, constructor: FileTransaction },
  { confirmed: false, constructor: UnconfirmedInstall },
])('preserves same-byte in-place rewrite with same mtime (confirmed=$confirmed)', async ({ constructor }) => {
  coarseMtime();
  const tx = new constructor(state);
  await write(tx);
  const manifest = readFileSync(path.join(tx.dir, 'manifest.json'), 'utf8');
  expect(manifest.includes('"confirmed":')).toBe(constructor === FileTransaction);
  const before = statSync(target, { bigint: true });
  const partial = installId(target);
  await new Promise((resolve) => setTimeout(resolve, 20));
  writeFileSync(target, 'pending');
  utimesSync(target, time, time);
  expect(installId(target)).toBe(partial);
  expect(statSync(target, { bigint: true }).ctimeNs).not.toBe(before.ctimeNs);
  abandon(tx);
  expect((await recover())[0]?.report.skipped[0]?.reason).toBe('changed-externally');
  expect(bytes()).toBe('pending');
});

// Adjusted for the strict rule: only the newest journal is undone; the older ones report conflicts.
it('undoes the newest of three consecutive pending journals and reports the others as conflicts', async () => {
  const one = new FileTransaction(state);
  const two = new FileTransaction(state);
  const three = new FileTransaction(state);
  await write(one, 'one');
  await write(two, 'two');
  await write(three, 'three');
  for (const tx of [one, two, three]) abandon(tx);
  const reports = (await recover()).map((item) => item.report);
  expect(reports.flatMap((report) => report.restored)).toEqual([target]);
  expect(reports.flatMap((report) => report.skipped.map((item) => item.reason))).toEqual(['changed-externally', 'changed-externally']);
  expect(bytes()).toBe('two');
});

it('reports conflict after creation of a second hard link to a confirmed inode', async () => {
  const tx = new FileTransaction(state);
  await write(tx);
  const before = statSync(target, { bigint: true });
  const alias = path.join(workspace, 'alias');
  await new Promise((resolve) => setTimeout(resolve, 20));
  linkSync(target, alias);
  const after = statSync(target, { bigint: true });
  expect(statSync(alias, { bigint: true }).ino).toBe(before.ino);
  expect(after.ctimeNs).not.toBe(before.ctimeNs);
  abandon(tx);
  expect((await recover())[0]?.report.skipped[0]?.reason).toBe('changed-externally');
  expect(bytes()).toBe('pending');
  expect(readFileSync(alias, 'utf8')).toBe('pending');
});

it('reports a legacy journal without install identities even if bytes equal original', async () => {
  const tx = new FileTransaction(state);
  await write(tx);
  writeFileSync(target, 'original');
  abandon(tx, (raw) => raw.replace(/,"installs":\[[^\]]*\]/, ''));
  expect((await recover())[0]?.report.skipped[0]?.reason).toBe('changed-externally');
  expect(bytes()).toBe('original');
});

it('refuses finalization when directory is replaced before the flush actually opens it', async () => {
  let finalizing = false;
  const moved = path.join(base, 'moved');
  const tx = new FileTransaction(state, {
    syncDir: async (dir) => {
      if (finalizing && dir === workspace) {
        renameSync(workspace, moved);
        mkdirSync(workspace);
      }
      await syncDirStrict(dir);
    },
    removeDir: async () => {},
  });
  await write(tx);
  finalizing = true;
  await expect(tx.dispose()).rejects.toMatchObject({ committed: false });
});

// Adjusted for the strict rule: the middle journal's equal bytes do not make the older journals' files theirs.
it('undoes only the newest of three pending journals when the middle journal wrote the same bytes', async () => {
  const one = new FileTransaction(state);
  const two = new FileTransaction(state);
  const three = new FileTransaction(state);
  await write(one, 'one');
  const firstId = installId(target);
  await write(two, 'one');
  expect(installId(target)).not.toBe(firstId);
  await write(three, 'three');
  for (const tx of [one, two, three]) abandon(tx);
  const reports = (await recover()).map((item) => item.report);
  expect({ bytes: bytes(), reasons: reports.flatMap((report) => report.skipped.map((item) => item.reason)) })
    .toEqual({ bytes: 'one', reasons: ['changed-externally', 'changed-externally'] });
});
