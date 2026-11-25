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


describe.skipIf(IS_WINDOWS)('independent durability review', () => {
  it('keeps a later successful write when recovering an unfinished run on the same file', async () => {
    const earlier = new FileTransaction(stateDir);
    await write('a.txt', 'one', earlier);
    await write('a.txt', 'two', earlier);

    const later = new FileTransaction(stateDir, { syncDir: syncDirStrict, removeDir: () => Promise.resolve() });
    await write('a.txt', 'one', later);
    await later.dispose();
    expect(read('a.txt')).toBe('one');

    const pid = deadPid();
    const manifestPath = path.join(earlier.dir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { pid: number };
    manifest.pid = pid;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const [stamp, , hex] = path.basename(earlier.dir).split('-');
    renameSync(earlier.dir, path.join(path.dirname(earlier.dir), `${stamp}-${pid}-${hex}`));

    await recoverStaleJournals(stateDir, [ws], []);
    expect(read('a.txt')).toBe('one');
  });

  it('does not acknowledge durability when it cannot flush a directory changed by the run', async () => {
    mkdirSync(path.join(ws, 'nested'));
    const tx = new FileTransaction(stateDir);
    await write('nested/file.txt', 'new', tx);
    renameSync(path.join(ws, 'nested'), path.join(ws, 'moved'));
    await expect(tx.dispose()).rejects.toMatchObject({ committed: false });
  });
});
