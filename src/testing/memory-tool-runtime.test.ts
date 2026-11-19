import { describe, expect, it, vi } from 'vitest';
import { ToolError } from '../core/errors.js';
import { parseToolCall } from '../core/schemas.js';
import type { PolicySnapshot, SessionContext } from '../core/types.js';
import { makeContext } from './context.js';
import { MAX_DIFF_LINES, MAX_EDIT_REPLACEMENTS, MemoryToolRuntime, simpleDiff } from './memory-tool-runtime.js';

const workers = vi.hoisted(() => ({ live: 0, max: 0 }));
vi.mock('node:worker_threads', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:worker_threads')>();
  class CountingWorker extends real.Worker {
    constructor(...args: ConstructorParameters<typeof real.Worker>) {
      super(...args);
      workers.live++;
      workers.max = Math.max(workers.max, workers.live);
      this.once('exit', () => workers.live--);
    }
  }
  return { ...real, Worker: CountingWorker };
});

const policy: PolicySnapshot = { host: 'generic', bashContainment: { mode: 'none' }, protectedPaths: [], payload: null };
let nextId = 1;

async function prepare(tools: MemoryToolRuntime, tool: string, args: unknown, ctx: SessionContext = makeContext('/ws')) {
  const call = parseToolCall(tool, args, `c${nextId++}`);
  if (call instanceof ToolError) throw call;
  return tools.prepare(call, ctx, policy);
}

describe('MemoryToolRuntime', () => {
  it('resolves paths against the session cwd and keeps disjoint roots apart', async () => {
    const tools = new MemoryToolRuntime({});
    const a = makeContext('/client/a');
    const b = makeContext('/client/b');
    await tools.commit(await prepare(tools, 'write', { path: 'notes.txt', content: 'a' }, a), new AbortController().signal);
    expect(tools.files.get('/client/a/notes.txt')).toBe('a');

    await expect(prepare(tools, 'read', { path: '/client/a/notes.txt' }, b)).rejects.toMatchObject({ code: 'outside-workspace' });
    await expect(prepare(tools, 'read', { path: 'notes.txt' }, b)).rejects.toMatchObject({ code: 'not-found' });
    const listed = await tools.commit(await prepare(tools, 'glob', { pattern: '**' }, b), new AbortController().signal);
    expect(listed).toEqual({ files: [], truncated: false });
    const extraRoot = makeContext('/client/b', { roots: ['/client/b', '/client/a'] });
    expect(await prepare(tools, 'read', { path: '/client/a/notes.txt' }, extraRoot)).toMatchObject({ effect: { absPath: '/client/a/notes.txt' } });
    expect(await prepare(tools, 'read', { path: 'C:\\ws\\a.txt' }, makeContext('C:\\ws')).catch((e: unknown) => e)).toMatchObject({ code: 'not-found', message: '/C:/ws/a.txt does not exist' });
  });

  it('keeps a later write of the same text by someone else on rollback', async () => {
    const tools = new MemoryToolRuntime({ root: '/ws', files: { 'a.txt': 'original' } });
    const tx = tools.beginTransaction();
    await tools.commit(await prepare(tools, 'write', { path: 'a.txt', content: 'shared' }), new AbortController().signal, tx);
    const other = tools.beginTransaction();
    await tools.commit(await prepare(tools, 'write', { path: 'a.txt', content: 'other' }), new AbortController().signal, other);
    await tools.commit(await prepare(tools, 'write', { path: 'a.txt', content: 'shared' }), new AbortController().signal, other);
    await other.dispose();

    expect(await tx.rollback()).toEqual({ restored: [], skipped: [{ path: '/ws/a.txt', reason: 'changed-externally' }] });
    expect(tools.read('a.txt')).toBe('shared');
  });

  it('reads seeded files under an explicit Windows root', async () => {
    const root = 'C:\\workspace';
    const file = `${root}\\notes.txt`;
    const tools = new MemoryToolRuntime({ root, files: { [file]: 'hello' } });
    const read = await prepare(tools, 'read', { path: 'notes.txt' }, makeContext(root));
    expect(await tools.commit(read, new AbortController().signal)).toMatchObject({ content: 'hello' });
    expect(tools.read(file)).toBe('hello');
  });

  it('allows two overlapping writes to roll back in reverse order', async () => {
    const tools = new MemoryToolRuntime({ root: '/ws', files: { 'notes.txt': 'original' } });
    const outer = tools.beginTransaction();
    const inner = tools.beginTransaction();
    const signal = new AbortController().signal;
    await tools.commit(await prepare(tools, 'write', { path: 'notes.txt', content: 'first' }), signal, outer);
    await tools.commit(await prepare(tools, 'write', { path: 'notes.txt', content: 'second' }), signal, inner);
    expect(await inner.rollback()).toMatchObject({ restored: ['/ws/notes.txt'] });
    expect(await outer.rollback()).toMatchObject({ restored: ['/ws/notes.txt'], skipped: [] });
    expect(tools.read('notes.txt')).toBe('original');
  });

  it('searches off the main thread, stops at the first extra match and can be stopped', async () => {
    const atRoot = new MemoryToolRuntime({ files: { '/a.txt': 'one' } });
    expect(await atRoot.commit(await prepare(atRoot, 'glob', { pattern: '*.txt' }, makeContext('/')), new AbortController().signal)).toEqual({ files: ['/a.txt'], truncated: false });
    const tools = new MemoryToolRuntime({ root: '/ws', files: { 'a.txt': 'one\ntwo\none', 'src/b.ts': 'one', 'src/c.md': 'one' } });
    const found = await tools.commit(await prepare(tools, 'grep', { pattern: 'o.e', glob: '*.ts' }), new AbortController().signal);
    expect(found).toEqual({ matches: [{ file: '/ws/src/b.ts', line: 1, text: 'one' }], truncated: false });
    const capped = await tools.commit(await prepare(tools, 'grep', { pattern: 'ONE', ignoreCase: true, maxResults: 1 }), new AbortController().signal);
    expect(capped).toEqual({ matches: [{ file: '/ws/a.txt', line: 1, text: 'one' }], truncated: true });

    const controller = new AbortController();
    const pending = tools.commit(await prepare(tools, 'grep', { pattern: 'one' }), controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('caps concurrent search workers, cancels queued searches and reuses freed slots', async () => {
    const tools = new MemoryToolRuntime({ root: '/ws', files: { 'a.txt': 'one', 'b.ts': 'one' } });
    await vi.waitFor(() => expect(workers.live).toBe(0));
    workers.max = 0;
    const signal = new AbortController().signal;
    const searches = await Promise.all(Array.from({ length: 10 }, () => prepare(tools, 'grep', { pattern: 'one' })));
    const queued = new AbortController();
    const running = searches.map((call) => tools.commit(call, signal));
    const cancelled = tools.commit(await prepare(tools, 'glob', { pattern: '*' }), queued.signal);
    queued.abort();
    await expect(cancelled).rejects.toMatchObject({ code: 'cancelled' });
    for (const result of await Promise.all(running)) expect(result).toMatchObject({ matches: [{ line: 1 }, { line: 1 }], truncated: false });
    expect(workers.max).toBeGreaterThan(0);
    expect(workers.max).toBeLessThanOrEqual(4);
    await expect(tools.commit(await prepare(tools, 'glob', { pattern: '*.ts' }), signal)).resolves.toEqual({ files: ['/ws/b.ts'], truncated: false });
  });

  it('copies only the content a search needs and rejects a search over the size limit', async () => {
    const big = 'x'.repeat(11_000_000);
    const tools = new MemoryToolRuntime({ root: '/ws', files: { 'a.txt': big, 'b.txt': big, 'c.ts': 'one' } });
    const signal = new AbortController().signal;
    expect(await tools.commit(await prepare(tools, 'grep', { pattern: 'one', glob: '*.ts' }), signal)).toEqual({ matches: [{ file: '/ws/c.ts', line: 1, text: 'one' }], truncated: false });
    await expect(tools.commit(await prepare(tools, 'grep', { pattern: 'one' }), signal)).rejects.toMatchObject({ code: 'tool-error', message: expect.stringContaining('narrow') });
  });

  it('edits literally and diffs without per-line arrays', async () => {
    const tools = new MemoryToolRuntime({ root: '/ws', files: { 'a.txt': 'a-a\na' } });
    const edit = await prepare(tools, 'edit', { path: 'a.txt', oldString: 'a', newString: '$&$1', replaceAll: true });
    expect(edit).toMatchObject({ effect: { afterContent: '$&$1-$&$1\n$&$1', replacements: 3 } });
    expect(simpleDiff('/f', 'x\n\n', 'y')).toBe('--- a/f\n+++ b/f\n@@ -1,2 +1,1 @@\n-x\n-\n+y\n\\ No newline at end of file\n');
    await expect(prepare(tools, 'edit', { path: 'a.txt', oldString: 'a', newString: 'b' })).rejects.toMatchObject({ message: expect.stringContaining('3 times') });
  });

  it('refuses network-share (UNC) roots and paths before preparing a call', async () => {
    for (const share of ['\\\\server\\share', '//server/share']) {
      expect(() => new MemoryToolRuntime({ root: share })).toThrow(expect.objectContaining({ code: 'outside-workspace', message: expect.stringContaining('network share') }));
      expect(() => new MemoryToolRuntime({ root: '/ws', files: { [`${share}/a.txt`]: 'x' } })).toThrow(expect.objectContaining({ code: 'outside-workspace' }));
      const tools = new MemoryToolRuntime({ files: { '/server/share/a.txt': 'x' } });
      const write = { path: 'a.txt', content: 'y' };
      await expect(prepare(tools, 'write', write, makeContext(share))).rejects.toMatchObject({ code: 'outside-workspace', message: expect.stringContaining('network share') });
      await expect(prepare(tools, 'write', write, makeContext('/server/share', { roots: [share] }))).rejects.toMatchObject({ code: 'outside-workspace' });
      await expect(prepare(tools, 'write', { ...write, path: `${share}/a.txt` }, makeContext('/'))).rejects.toMatchObject({ code: 'outside-workspace' });
      await expect(prepare(new MemoryToolRuntime({ root: '/' }), 'read', { path: 'a.txt' }, makeContext(share))).rejects.toMatchObject({ code: 'outside-workspace' });
    }
  });

  it('refuses an edit over the replacement or diff budget before building its text or diff', async () => {
    const tooMany = 'a'.repeat(MAX_EDIT_REPLACEMENTS + 1);
    const tooLong = `head\n${'x\n'.repeat(MAX_DIFF_LINES / 2 - 1)}`;
    const tools = new MemoryToolRuntime({ root: '/ws', files: { 'many.txt': tooMany, 'long.txt': tooLong } });
    const replaceAll = vi.spyOn(String.prototype, 'replaceAll');
    const replace = vi.spyOn(String.prototype, 'replace');
    try {
      await expect(prepare(tools, 'edit', { path: 'many.txt', oldString: 'a', newString: 'b', replaceAll: true })).rejects.toMatchObject({
        code: 'invalid-args',
        message: expect.stringContaining(`more than ${MAX_EDIT_REPLACEMENTS}`),
      });
      await expect(prepare(tools, 'edit', { path: 'long.txt', oldString: 'head', newString: 'y' })).rejects.toMatchObject({
        code: 'invalid-args',
        message: expect.stringContaining(`more than ${MAX_DIFF_LINES} lines`),
      });
      await expect(prepare(tools, 'write', { path: 'long.txt', content: tooLong })).rejects.toMatchObject({ code: 'invalid-args' });
      expect(replaceAll).not.toHaveBeenCalled();
      expect(replace.mock.contexts.filter((self) => self === tooMany || self === tooLong)).toEqual([]);
    } finally {
      replaceAll.mockRestore();
      replace.mockRestore();
    }
    expect(tools.read('many.txt')).toBe(tooMany);
    expect(tools.read('long.txt')).toBe(tooLong);
  });

  it('prepares an edit just under the budget with the same text and diff as before', async () => {
    const many = 'a'.repeat(MAX_EDIT_REPLACEMENTS);
    const lines = MAX_DIFF_LINES / 2 - 1;
    const long = `head\n${'x\n'.repeat(lines - 1)}`;
    const tools = new MemoryToolRuntime({ root: '/ws', files: { 'many.txt': many, 'long.txt': long } });
    const wide = await prepare(tools, 'edit', { path: 'many.txt', oldString: 'a', newString: 'b', replaceAll: true });
    const after = 'b'.repeat(MAX_EDIT_REPLACEMENTS);
    expect(wide).toMatchObject({ effect: { afterContent: after, replacements: MAX_EDIT_REPLACEMENTS } });
    expect(wide.tool === 'edit' && wide.effect.diff).toBe(
      `--- a/ws/many.txt\n+++ b/ws/many.txt\n@@ -1,1 +1,1 @@\n-${many}\n\\ No newline at end of file\n+${after}\n\\ No newline at end of file\n`,
    );
    const tall = await prepare(tools, 'edit', { path: 'long.txt', oldString: 'head', newString: 'y' });
    expect(tall).toMatchObject({ effect: { afterContent: `y${long.slice(4)}`, replacements: 1 } });
    expect(tall.tool === 'edit' && tall.effect.diff).toBe(
      `--- a/ws/long.txt\n+++ b/ws/long.txt\n@@ -1,${lines} +1,${lines} @@\n-head\n${'-x\n'.repeat(lines - 1)}+y\n${'+x\n'.repeat(lines - 1)}`,
    );
  });
});
