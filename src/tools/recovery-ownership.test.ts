import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runScript } from '../core/run.js';
import type { PolicySnapshot, Sandbox, ToolCall, Transaction } from '../core/types.js';
import { FakeSandbox, makeContext, StaticHostAdapter } from '../testing/index.js';
import { FileTransaction, recoverStaleJournals } from './journal.js';
import { NodeToolRuntime } from './runtime.js';

const policy: PolicySnapshot = { host: 'generic', bashContainment: { mode: 'none' }, protectedPaths: [], payload: null };
const signal = new AbortController().signal;
const windows = process.platform === 'win32';
let base: string;
let workspace: string;
let stateDir: string;
let tools: NodeToolRuntime;
let callNumber: number;

const ws = (relative: string): string => path.join(workspace, relative);
const read = (relative: string): string => readFileSync(ws(relative), 'utf8');

function runtimeCall(call: ToolCall, tx?: Transaction) {
  return tools.prepare(call, makeContext(workspace), policy).then((prepared) => tools.commit(prepared, signal, tx));
}

function write(relative: string, content: string, tx: Transaction) {
  return runtimeCall({ id: String(++callNumber), tool: 'write', args: { path: relative, content } }, tx);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function runTransaction(sandbox: Sandbox, code = '') {
  return runScript({ code, transaction: true, timeoutMs: 10_000 }, {
    sandbox, tools, ctx: makeContext(workspace), adapter: new StaticHostAdapter({ protectedPaths: [] }),
  });
}

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'acm-l1-review-')));
  workspace = path.join(base, 'workspace');
  stateDir = path.join(base, 'state');
  mkdirSync(workspace);
  tools = new NodeToolRuntime({ stateDir });
  callNumber = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(base, { recursive: true, force: true });
});

function start(): FileTransaction {
  const tx = tools.beginTransaction();
  if (!(tx instanceof FileTransaction)) throw new Error('expected a disk journal');
  return tx;
}

function abandon(tx: FileTransaction): void {
  const pid = Number(execFileSync(process.execPath, ['-p', 'process.pid'], { encoding: 'utf8' }));
  const manifest = path.join(tx.dir, 'manifest.json');
  const raw = readFileSync(manifest, 'utf8');
  expect(raw).toContain(`"pid":${process.pid},`);
  writeFileSync(manifest, raw.replace(`"pid":${process.pid},`, `"pid":${pid},`));
}

const recover = () => recoverStaleJournals(stateDir, [workspace], []);

// Adjusted for the strict rule: the newest journal is undone, and the older one then sees a file it did not install.
it('undoes the newest of two unfinished journals on the same file and reports the older one as a conflict', async () => {
  writeFileSync(ws('a'), 'original');
  const one = start();
  await write('a', 'first', one);
  const two = start();
  await write('a', 'second', two);
  abandon(one);
  abandon(two);
  const result = await recover();
  expect(result.flatMap((r) => r.report.restored)).toEqual([ws('a')]);
  expect(result.flatMap((r) => r.report.skipped.map((s) => s.reason))).toEqual(['changed-externally']);
  expect(read('a')).toBe('first');
});

// Adjusted for the strict rule: equal bytes in another file are a conflict, and the file is left as it is.
it('leaves a manual restoration of the original bytes in place and reports it as a conflict', async () => {
  writeFileSync(ws('a'), 'original');
  const one = start();
  await write('a', 'first', one);
  writeFileSync(ws('manual'), 'original');
  renameSync(ws('manual'), ws('a'));
  abandon(one);
  const result = await recover();
  expect(result[0]?.report.skipped[0]?.reason).toBe('changed-externally');
  expect(read('a')).toBe('original');
  expect((await recover())[0]?.report.skipped[0]?.reason).toBe('changed-externally');
});

it('reports conflict when the bytes match but the inode was replaced', async () => {
  writeFileSync(ws('a'), 'original');
  const one = start();
  await write('a', 'first', one);
  writeFileSync(ws('replacement'), 'first');
  renameSync(ws('replacement'), ws('a'));
  abandon(one);
  const result = await recover();
  expect(result[0]?.report.skipped[0]?.reason).toBe('changed-externally');
  expect(read('a')).toBe('first');
  expect((await recover())[0]?.report.skipped[0]?.reason).toBe('changed-externally');
});

it('preserves a committed write between two unfinished journals with matching bytes', async () => {
  writeFileSync(ws('a'), 'original');
  const one = start();
  await write('a', 'first', one);
  const committed = start();
  await write('a', 'intermediate', committed);
  await write('a', 'first', committed);
  await committed.dispose();
  const two = start();
  await write('a', 'second', two);
  abandon(one);
  abandon(two);
  const result = await recover();
  console.log('interleaved recovery', JSON.stringify(result), 'bytes', read('a'));
  expect(read('a')).toBe('first');
});

it('preserves later committed bytes after an earlier prepared write failed to land', async () => {
  const one = start();
  vi.spyOn(nodeFs, 'linkSync').mockImplementationOnce(() => {
    throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
  });
  await expect(write('a', 'first', one)).rejects.toThrow(/no space/);
  const committed = start();
  await write('a', 'first', committed);
  await committed.dispose();
  abandon(one);
  const result = await recover();
  console.log('unconfirmed recovery', JSON.stringify(result), 'exists', existsSync(ws('a')));
  expect(existsSync(ws('a'))).toBe(true);
  expect(read('a')).toBe('first');
});

it('refuses finalization when the changed directory was moved and replaced', async () => {
  mkdirSync(ws('nested'));
  const one = start();
  await write('nested/file', 'first', one);
  renameSync(ws('nested'), ws('moved'));
  mkdirSync(ws('nested'));
  await expect(one.dispose()).rejects.toMatchObject({ committed: false });
  expect(read('moved/file')).toBe('first');
});
