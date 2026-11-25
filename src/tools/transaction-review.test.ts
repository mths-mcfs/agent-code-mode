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
import { ROOTED_OPS_REFUSED } from '../testing/platform.js';

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

describe.skipIf(windows)('transaction journal', () => {
  it('undoes prior writes and new directories after an uncaught call error', async () => {
    writeFileSync(ws('first.txt'), 'original');
    const result = await runTransaction(new FakeSandbox(), JSON.stringify([
      { throwOnError: true },
      { tool: 'write', args: { path: 'first.txt', content: 'changed' } },
      { tool: 'write', args: { path: 'new/deep/file.txt', content: 'created' } },
      { tool: 'read', args: { path: 'missing.txt' } },
      { tool: 'write', args: { path: 'later.txt', content: 'never reached' } },
    ]));

    expect(result).toMatchObject({ ok: false, error: { kind: 'error' }, rolledBack: { skipped: [] } });
    expect(result.rolledBack?.restored).toEqual([ws('new/deep/file.txt'), ws('first.txt')]);
    expect(read('first.txt')).toBe('original');
    expect(existsSync(ws('new'))).toBe(false);
    expect(existsSync(ws('later.txt'))).toBe(false);
  });

  it('keeps the successful run’s writes when an overlapping run fails', async () => {
    writeFileSync(ws('first.txt'), 'first original');
    writeFileSync(ws('second.txt'), 'second original');
    const firstWrote = deferred<boolean>();
    const finishFirst = deferred<void>();
    const failing = runTransaction({
      run: async (_code, options) => {
        const reply = await options.onCall('write', { path: 'first.txt', content: 'first changed' });
        firstWrote.resolve(reply.ok);
        await finishFirst.promise;
        return { ok: false, kind: 'error', error: { name: 'Error', message: 'stop first run' } };
      },
    });

    try {
      expect(await firstWrote.promise).toBe(true);
      const successful = await runTransaction(new FakeSandbox(), JSON.stringify([
        { throwOnError: true },
        { tool: 'write', args: { path: 'second.txt', content: 'second committed' } },
      ]));
      expect(successful.ok).toBe(true);
    } finally {
      finishFirst.resolve();
      await failing;
    }

    expect((await failing).ok).toBe(false);
    expect(read('first.txt')).toBe('first original');
    expect(read('second.txt')).toBe('second committed');
  });

  it('preserves an external deletion and a replacement of a file', async () => {
    writeFileSync(ws('deleted.txt'), 'original deleted');
    writeFileSync(ws('replaced.txt'), 'original replaced');
    const tx = tools.beginTransaction();
    await write('deleted.txt', 'transaction bytes', tx);
    await write('replaced.txt', 'transaction bytes', tx);
    unlinkSync(ws('deleted.txt'));
    writeFileSync(ws('from-editor.txt'), 'user replacement');
    renameSync(ws('from-editor.txt'), ws('replaced.txt'));

    const report = await tx.rollback();

    expect(report.skipped.map(({ path, reason }) => ({ path, reason }))).toEqual([
      { path: ws('replaced.txt'), reason: 'changed-externally' },
      { path: ws('deleted.txt'), reason: 'changed-externally' },
    ]);
    expect(existsSync(ws('deleted.txt'))).toBe(false);
    expect(read('replaced.txt')).toBe('user replacement');
  });

  it('preserves a user’s replacement directory at a name the transaction created', async () => {
    const tx = tools.beginTransaction();
    await write('fresh/file.txt', 'transaction bytes', tx);
    renameSync(ws('fresh'), ws('moved'));
    mkdirSync(ws('fresh'));

    await tx.rollback();

    expect(read('moved/file.txt')).toBe('transaction bytes');
    expect(existsSync(ws('fresh'))).toBe(true);
  });

  it('removes new directories after the filesystem refuses to install the new file', async () => {
    const tx = tools.beginTransaction();
    const noSpace = Object.assign(new Error('simulated filesystem out of space'), { code: 'ENOSPC' });
    vi.spyOn(nodeFs, 'linkSync').mockImplementationOnce(() => {
      throw noSpace;
    });

    await expect(write('fresh/deep/file.txt', 'new bytes', tx)).rejects.toThrow(/out of space/);
    await tx.rollback();

    expect(existsSync(ws('fresh/deep/file.txt'))).toBe(false);
    expect(existsSync(ws('fresh'))).toBe(false);
  });

  it('recovers a valid manifest beside a torn update and does nothing on the next pass', async () => {
    writeFileSync(ws('one.txt'), 'one original');
    writeFileSync(ws('two.txt'), 'two original');
    const tx = tools.beginTransaction();
    if (!(tx instanceof FileTransaction)) throw new Error('expected an on-disk journal');
    await write('one.txt', 'one uncommitted', tx);

    // Simulate a process gone after the new manifest began writing, before its rename.
    const exitedPid = Number(execFileSync(process.execPath, ['-p', 'process.pid'], { encoding: 'utf8' }));
    const manifestPath = path.join(tx.dir, 'manifest.json');
    const manifest = readFileSync(manifestPath, 'utf8');
    const priorOwner = `"pid":${process.pid},`;
    expect(manifest).toContain(priorOwner);
    writeFileSync(manifestPath, manifest.replace(priorOwner, `"pid":${exitedPid},`));
    writeFileSync(path.join(tx.dir, 'manifest.json.next'), '{"version":1,"entries":[');
    const staleDir = tx.dir.replace(`-${process.pid}-`, `-${exitedPid}-`);
    renameSync(tx.dir, staleDir);

    const first = await recoverStaleJournals(stateDir, [workspace], []);
    expect(first.map(({ report }) => report)).toEqual([{ restored: [ws('one.txt')], skipped: [] }]);
    expect(read('one.txt')).toBe('one original');
    expect(read('two.txt')).toBe('two original');
    writeFileSync(ws('one.txt'), 'user edit after recovery');
    expect(await recoverStaleJournals(stateDir, [workspace], [])).toEqual([]);
    expect(read('one.txt')).toBe('user edit after recovery');
  });

  it('treats a journal-like path inside the workspace as an ordinary file', async () => {
    mkdirSync(ws('journal'));
    writeFileSync(ws('journal/manifest.json'), 'workspace document');
    const tx = tools.beginTransaction();
    await write('journal/manifest.json', 'edited document', tx);

    expect(read('journal/manifest.json')).toBe('edited document');
    expect((await tx.rollback()).restored).toEqual([ws('journal/manifest.json')]);
    expect(read('journal/manifest.json')).toBe('workspace document');
  });
});

describe('workspace paths', () => {
  it.skipIf(ROOTED_OPS_REFUSED)('resolves an existing parent segment but refuses one after a missing directory', async () => {
    mkdirSync(ws('sub'));
    writeFileSync(ws('file.txt'), 'workspace document');

    await expect(runtimeCall({ id: 'existing', tool: 'read', args: { path: 'sub/../file.txt' } }))
      .resolves.toMatchObject({ path: ws('file.txt'), content: 'workspace document' });
    await expect(runtimeCall({ id: 'missing', tool: 'read', args: { path: 'absent/../file.txt' } }))
      .rejects.toMatchObject({ code: 'not-found' });
  });

  it.skipIf(windows)('refuses to read an ordinary fixture through a link outside the workspace', async () => {
    const sibling = path.join(base, 'sibling.txt');
    writeFileSync(sibling, 'sibling fixture');
    symlinkSync(sibling, ws('shortcut.txt'));

    await expect(runtimeCall({ id: 'shortcut', tool: 'read', args: { path: 'shortcut.txt' } }))
      .rejects.toMatchObject({ code: 'outside-workspace' });
    expect(readFileSync(sibling, 'utf8')).toBe('sibling fixture');
  });

  it.skipIf(ROOTED_OPS_REFUSED)('follows the workspace volume’s filename case rules', async () => {
    writeFileSync(ws('Report.txt'), 'mixed case');
    if (!existsSync(ws('report.txt'))) writeFileSync(ws('report.txt'), 'lower case');
    const actual = read('report.txt');

    await expect(runtimeCall({ id: 'upper', tool: 'read', args: { path: 'Report.txt' } }))
      .resolves.toMatchObject({ content: 'mixed case' });
    await expect(runtimeCall({ id: 'lower', tool: 'read', args: { path: 'report.txt' } }))
      .resolves.toMatchObject({ content: actual });
  });
});

describe('tolerant edit', () => {
  it.skipIf(ROOTED_OPS_REFUSED)('refuses two loose CRLF matches and keeps the original bytes', async () => {
    const source = 'one\r\n  option  \r\ntwo\r\n  option \r\n';
    writeFileSync(ws('options.txt'), source);

    await expect(runtimeCall({ id: 'ambiguous', tool: 'edit', args: {
      path: 'options.txt', oldString: '  option\n', newString: '  setting\n',
    } })).rejects.toMatchObject({ code: 'invalid-args' });
    expect(read('options.txt')).toBe(source);
  });

  it.skipIf(ROOTED_OPS_REFUSED)('preserves CRLF and replaces only the original matches when the replacement repeats the search text', async () => {
    writeFileSync(ws('options.txt'), 'name\r\nvalue\r\nseparator\r\nname\r\nvalue\r\n');

    await expect(runtimeCall({ id: 'edit', tool: 'edit', args: {
      path: 'options.txt', oldString: 'name\nvalue', newString: 'name\nvalue\nextra', replaceAll: true,
    } })).resolves.toMatchObject({ replacements: 2 });
    expect(read('options.txt')).toBe('name\r\nvalue\r\nextra\r\nseparator\r\nname\r\nvalue\r\nextra\r\n');
  });
});

describe('output limits', () => {
  it.skipIf(ROOTED_OPS_REFUSED)('counts UTF-8 bytes for read and lets the next window retrieve the rest', async () => {
    const line = 'é'.repeat(50_000);
    writeFileSync(ws('lines.txt'), `${line}\n${line}\n${line}\n`);
    await expect(runtimeCall({ id: 'read-1', tool: 'read', args: { path: 'lines.txt' } }))
      .resolves.toMatchObject({ content: `${line}\n${line}`, totalLines: 3, truncated: true });
    await expect(runtimeCall({ id: 'read-2', tool: 'read', args: { path: 'lines.txt', offset: 3 } }))
      .resolves.toMatchObject({ content: line, startLine: 3, totalLines: 3, truncated: false });
  });

  it.skipIf(ROOTED_OPS_REFUSED)('sets the grep truncation flag only when a further match exists', async () => {
    writeFileSync(ws('a.txt'), 'needle\n');
    writeFileSync(ws('b.txt'), 'unrelated\nneedle\n');
    const args = { pattern: 'needle', maxResults: 2 };
    await expect(runtimeCall({ id: 'exact', tool: 'grep', args })).resolves.toMatchObject({ truncated: false });
    writeFileSync(ws('c.txt'), 'needle\n');
    await expect(runtimeCall({ id: 'overflow', tool: 'grep', args })).resolves.toEqual({
      matches: [
        { file: ws('a.txt'), line: 1, text: 'needle' },
        { file: ws('b.txt'), line: 2, text: 'needle' },
      ],
      truncated: true,
      filtered: 0,
    });
  });

  it.skipIf(ROOTED_OPS_REFUSED)('caps glob after sorting and distinguishes exact fit from truncation', async () => {
    for (const name of ['z.txt', 'a.txt', 'b.txt']) writeFileSync(ws(name), '');
    await expect(runtimeCall({ id: 'fit', tool: 'glob', args: { pattern: '*.txt', maxResults: 3 } }))
      .resolves.toEqual({ files: [ws('a.txt'), ws('b.txt'), ws('z.txt')], truncated: false, filtered: 0 });
    await expect(runtimeCall({ id: 'spill', tool: 'glob', args: { pattern: '*.txt', maxResults: 2 } }))
      .resolves.toEqual({ files: [ws('a.txt'), ws('b.txt')], truncated: true, filtered: 0 });
  });

  it.skipIf(windows)('keeps returned stdout and stderr within the byte cap after UTF-8 decoding', async () => {
    tools = new NodeToolRuntime({ stateDir, bashOutputCapBytes: 3 });
    const result = await runtimeCall({ id: 'bash', tool: 'bash', args: { command: "printf 'abé'; printf 'cdé' >&2" } });

    expect(result).toMatchObject({ exitCode: 0, truncated: true });
    if (!('stdout' in result)) throw new Error('expected a bash result');
    expect(result.stdout.startsWith('ab') && result.stderr.startsWith('cd')).toBe(true);
    expect(Math.max(Buffer.byteLength(result.stdout), Buffer.byteLength(result.stderr))).toBeLessThanOrEqual(3);
  });
});
