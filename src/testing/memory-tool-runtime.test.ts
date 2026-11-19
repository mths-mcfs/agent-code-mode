import { describe, expect, it } from 'vitest';
import { ToolError } from '../core/errors.js';
import { parseToolCall } from '../core/schemas.js';
import type { PolicySnapshot, SessionContext } from '../core/types.js';
import { makeContext } from './context.js';
import { MemoryToolRuntime } from './memory-tool-runtime.js';

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
});
