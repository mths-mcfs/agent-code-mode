import { spawnSync } from 'node:child_process';
import {
  existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeContext } from '../testing/index.js';
import { FileTransaction, recoverStaleJournals } from './journal.js';
import { NodeToolRuntime } from './runtime.js';
import { cutBeforeRename, pinTempMtime } from '../testing/install-faults.js';
import { ROOTED_OPS_REFUSED } from '../testing/platform.js';

let base: string;
let workspace: string;
let folder: string;
let state: string;
let target: string;
let runtime: NodeToolRuntime;
const policy = { host: 'generic', bashContainment: { mode: 'none' }, protectedPaths: [], payload: null } as const;

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'acm-temps-')));
  workspace = path.join(base, 'workspace');
  folder = path.join(workspace, 'sub');
  state = path.join(base, 'state');
  mkdirSync(folder, { recursive: true });
  target = path.join(folder, 'file');
  writeFileSync(target, 'original');
  runtime = new NodeToolRuntime({ stateDir: state });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(base, { recursive: true, force: true });
});

async function write(tx: FileTransaction, content = 'pending') {
  const prepared = await runtime.prepare(
    { id: 'write', tool: 'write', args: { path: 'sub/file', content } },
    makeContext(workspace),
    policy,
  );
  await runtime.commit(prepared, new AbortController().signal, tx);
}

function abandon(tx: FileTransaction, edit: (json: string) => string = (json) => json) {
  const child = spawnSync(process.execPath, ['-p', 'process.pid'], { encoding: 'utf8' });
  expect(child.status).toBe(0);
  const manifest = path.join(tx.dir, 'manifest.json');
  const raw = readFileSync(manifest, 'utf8');
  expect(raw).toContain(`"pid":${process.pid},`);
  writeFileSync(manifest, edit(raw.replace(`"pid":${process.pid},`, `"pid":${child.stdout.trim()},`)));
}

function isKept(tx: FileTransaction) {
  return readdirSync(path.dirname(tx.dir)).some((entry) => entry.startsWith(path.basename(tx.dir)));
}

const recover = () => recoverStaleJournals(state, [workspace], []);
const read = (file: string) => readFileSync(file, 'utf8');
const stats = (file: string) => statSync(file, { bigint: true });
const partialId = (st: ReturnType<typeof stats>) => `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}`;
const id = (st: ReturnType<typeof stats>) => `${partialId(st)}:${st.ctimeNs}`;
const oldTime = 1_700_000_000;

async function crashBeforeRename(tx: FileTransaction) {
  const cut = cutBeforeRename(vi, target, 'simulated process stop before rename');
  await expect(write(tx)).rejects.toThrow('simulated process stop before rename');
  vi.restoreAllMocks();
  const temp = cut.temp();
  expect(existsSync(temp)).toBe(true);
  abandon(tx);
  return temp;
}

async function expectConflict(tx: FileTransaction) {
  const [journal] = await recover();
  expect(journal?.report.restored).toEqual([]);
  expect(journal?.report.skipped).toEqual([expect.objectContaining({ path: target })]);
  expect(isKept(tx)).toBe(true);
}

it.skipIf(ROOTED_OPS_REFUSED)('keeps a later separately installed file with identical bytes', async () => {
  const tx = new FileTransaction(state);
  await write(tx);
  const previous = stats(target);
  const replacement = path.join(folder, 'replacement');
  writeFileSync(replacement, 'pending');
  renameSync(replacement, target);
  expect(stats(target).ino).not.toBe(previous.ino);
  abandon(tx);
  await expectConflict(tx);
  expect(read(target)).toBe('pending');
});

it.skipIf(ROOTED_OPS_REFUSED)('keeps a same-size rewrite with the same mtime and different ctime', async () => {
  pinTempMtime(vi, oldTime);
  const tx = new FileTransaction(state);
  await write(tx);
  vi.restoreAllMocks();
  const before = stats(target);
  await new Promise((resolve) => setTimeout(resolve, 20));
  writeFileSync(target, 'pending');
  utimesSync(target, oldTime, oldTime);
  expect(partialId(stats(target))).toBe(partialId(before));
  expect(stats(target).ctimeNs).not.toBe(before.ctimeNs);
  abandon(tx);
  await expectConflict(tx);
  expect(read(target)).toBe('pending');
});

it.skipIf(ROOTED_OPS_REFUSED)('keeps the target when the user added a hard link', async () => {
  const tx = new FileTransaction(state);
  await write(tx);
  const before = stats(target);
  const alias = path.join(folder, 'alias');
  await new Promise((resolve) => setTimeout(resolve, 20));
  linkSync(target, alias);
  expect(stats(alias).ino).toBe(before.ino);
  expect(stats(target).ctimeNs).not.toBe(before.ctimeNs);
  abandon(tx);
  await expectConflict(tx);
  expect([read(target), read(alias)]).toEqual(['pending', 'pending']);
});

it.skipIf(ROOTED_OPS_REFUSED)('keeps a replacement on an inode recorded as reused, with the same mtime', async () => {
  pinTempMtime(vi, oldTime);
  const tx = new FileTransaction(state);
  await write(tx);
  vi.restoreAllMocks();
  const before = stats(target);
  rmSync(target);
  await new Promise((resolve) => setTimeout(resolve, 20));
  writeFileSync(target, 'pending');
  utimesSync(target, oldTime, oldTime);
  const replacement = stats(target);
  expect(replacement.ctimeNs).not.toBe(before.ctimeNs);
  // Model inode reuse in the record when the current filesystem allocates a new inode.
  abandon(tx, (raw) => {
    expect(raw).toContain(`"confirmed":"${id(before)}"`);
    return raw.replace(`"confirmed":"${id(before)}"`, `"confirmed":"${partialId(replacement)}:${before.ctimeNs}"`);
  });
  await expectConflict(tx);
  expect(read(target)).toBe('pending');
});

it.skipIf(ROOTED_OPS_REFUSED)('keeps a directory placed where the file was', async () => {
  const tx = new FileTransaction(state);
  await write(tx);
  rmSync(target);
  mkdirSync(target);
  const userFile = path.join(target, 'contents');
  writeFileSync(userFile, 'user');
  abandon(tx);
  await expectConflict(tx);
  expect(read(userFile)).toBe('user');
});

it.skipIf(ROOTED_OPS_REFUSED)('keeps a symlink placed where the file was', async () => {
  const tx = new FileTransaction(state);
  await write(tx);
  const userFile = path.join(base, 'user-file');
  writeFileSync(userFile, 'pending');
  rmSync(target);
  symlinkSync(userFile, target);
  abandon(tx);
  await expectConflict(tx);
  expect(lstatSync(target).isSymbolicLink()).toBe(true);
  expect(read(userFile)).toBe('pending');
});

it.skipIf(ROOTED_OPS_REFUSED)('keeps a replacement user file at a recorded temp path', async () => {
  const tx = new FileTransaction(state);
  const temp = await crashBeforeRename(tx);
  const userFile = path.join(folder, 'user-file');
  writeFileSync(userFile, 'user');
  renameSync(userFile, temp);
  const [journal] = await recover();
  expect(journal?.report.restored).toEqual([]);
  expect(journal?.leftoverTemps).toEqual([{ path: temp, identityMatches: false }]);
  expect(read(temp)).toBe('user');
  expect(read(target)).toBe('original');
});

it.skipIf(ROOTED_OPS_REFUSED)('keeps later user content written in place at the recorded temp path', async () => {
  pinTempMtime(vi, oldTime);
  const tx = new FileTransaction(state);
  const temp = await crashBeforeRename(tx);
  const before = stats(temp);
  await new Promise((resolve) => setTimeout(resolve, 20));
  writeFileSync(temp, 'usernew');
  utimesSync(temp, oldTime, oldTime);
  expect(partialId(stats(temp))).toBe(partialId(before));
  expect(stats(temp).ctimeNs).not.toBe(before.ctimeNs);
  const [journal] = await recover();
  // Adjusted: nothing is deleted; the leftover is reported, here still matching the recorded temp identity.
  expect({ leftover: journal?.leftoverTemps, bytes: existsSync(temp) ? read(temp) : '<deleted>' })
    .toEqual({ leftover: [{ path: temp, identityMatches: true }], bytes: 'usernew' });
});

it.skipIf(ROOTED_OPS_REFUSED)('leaves a changed directory and its files alone when its old path is a symlink', async () => {
  const tx = new FileTransaction(state);
  const temp = await crashBeforeRename(tx);
  const moved = path.join(base, 'elsewhere');
  renameSync(folder, moved);
  symlinkSync(moved, folder, 'dir');
  const [journal] = await recover();
  expect(journal?.report.restored).toEqual([]);
  expect(isKept(tx)).toBe(true);
  expect(lstatSync(folder).isSymbolicLink()).toBe(true);
  expect(read(target)).toBe('original');
  // Adjusted: nothing is deleted, through the symlink or otherwise.
  expect(existsSync(path.join(moved, path.basename(temp)))).toBe(true);
});

it.skipIf(ROOTED_OPS_REFUSED).each([{ middle: 'two' }, { middle: 'one' }])('restores only the newest record when the middle wrote $middle', async ({ middle }) => {
  const first = new FileTransaction(state);
  const second = new FileTransaction(state);
  const third = new FileTransaction(state);
  await write(first, 'one');
  await write(second, middle);
  await write(third, 'three');
  for (const tx of [first, second, third]) abandon(tx);
  const journals = await recover();
  expect(journals.find((journal) => journal.id === third.id)?.report).toEqual({ restored: [target], skipped: [] });
  for (const tx of [first, second]) {
    expect(journals.find((journal) => journal.id === tx.id)?.report).toEqual({
      restored: [],
      skipped: [expect.objectContaining({ path: target, reason: 'changed-externally' })],
    });
    expect(isKept(tx)).toBe(true);
  }
  expect(isKept(third)).toBe(false);
  expect(read(target)).toBe(middle);
});


it.skipIf(ROOTED_OPS_REFUSED)('fstats and syncs the same directory handle during finalization', async () => {
  const tx = new FileTransaction(state);
  await write(tx);
  const open = fs.open.bind(fs);
  const events: string[] = [];
  vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
    const handle = await open(file, flags, mode);
    if (file !== folder) return handle;
    events.push('open');
    const stat = handle.stat.bind(handle);
    const sync = handle.sync.bind(handle);
    vi.spyOn(handle, 'stat').mockImplementation((options) => {
      events.push('fstat');
      return stat(options);
    });
    vi.spyOn(handle, 'sync').mockImplementation(() => {
      events.push('fsync');
      return sync();
    });
    return handle;
  });
  await tx.dispose();
  expect(events).toEqual(['open', 'fstat', 'fsync']);
});
