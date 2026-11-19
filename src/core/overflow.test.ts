import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OVERFLOW_TTL_MS, OverflowStore, READ_OVERFLOW_DEFAULT_LIMIT, READ_OVERFLOW_MAX_LIMIT, removeLegacyOverflowFiles } from './overflow.js';
import type { CallReply } from './types.js';

function slice(reply: CallReply): { text: string; offset: number; totalChars: number; truncated: boolean } {
  if (!reply.ok || !('totalChars' in reply.value)) throw new Error(`expected a slice, got ${JSON.stringify(reply)}`);
  return reply.value;
}

function failure(reply: CallReply): { code: string; message: string } {
  if (reply.ok) throw new Error('expected a failure');
  return reply.error;
}

describe('OverflowStore', () => {
  it('returns opaque random ids and reads back slices by offset and limit', () => {
    const store = new OverflowStore();
    const text = Array.from({ length: 1_000 }, (_, i) => `${i}`).join(',');
    const id = store.put(text) ?? '';
    expect(id).toMatch(/^ov_[A-Za-z0-9_-]{22}$/);
    expect(store.put(text)).not.toBe(id);
    expect(slice(store.read({ id }))).toEqual({ text, offset: 0, totalChars: text.length, truncated: false });
    expect(slice(store.read({ id, offset: 4, limit: 3 }))).toEqual({ text: text.slice(4, 7), offset: 4, totalChars: text.length, truncated: true });
    expect(slice(store.read({ id, offset: text.length + 10 }))).toMatchObject({ text: '', truncated: false });
  });

  it('applies the default limit', () => {
    const store = new OverflowStore();
    const id = store.put('x'.repeat(READ_OVERFLOW_DEFAULT_LIMIT + 5)) ?? '';
    expect(slice(store.read({ id }))).toMatchObject({ truncated: true, totalChars: READ_OVERFLOW_DEFAULT_LIMIT + 5 });
    expect(slice(store.read({ id })).text).toHaveLength(READ_OVERFLOW_DEFAULT_LIMIT);
  });

  it('rejects invalid arguments at the boundary', () => {
    const store = new OverflowStore();
    const id = store.put('abc') ?? '';
    for (const args of [undefined, null, 'id', { id: 1 }, {}, { id, offset: -1 }, { id, offset: 1.5 }, { id, limit: 0 }, { id, limit: READ_OVERFLOW_MAX_LIMIT + 1 }, { id, extra: true }, { id: 'x'.repeat(100) }]) {
      expect(failure(store.read(args)).code).toBe('invalid-args');
    }
  });

  it('rejects unknown ids, expired ids and ids of another server session', () => {
    let now = 0;
    const store = new OverflowStore({ now: () => now });
    const other = new OverflowStore({ now: () => now });
    const id = store.put('secret') ?? '';
    expect(failure(other.read({ id })).code).toBe('not-found');
    expect(failure(store.read({ id: 'ov_AAAAAAAAAAAAAAAAAAAAAA' })).code).toBe('not-found');
    expect(failure(store.read({ id: '../state/run-1.json' })).code).toBe('not-found');
    now = OVERFLOW_TTL_MS - 1;
    expect(slice(store.read({ id })).text).toBe('secret');
    now = OVERFLOW_TTL_MS;
    expect(failure(store.read({ id })).message).toMatch(/unknown or expired/);
    expect(store.size).toBe(0);
  });

  it('drops the oldest entries past its size and refuses an entry larger than all of it', () => {
    const store = new OverflowStore({ maxChars: 10 });
    const a = store.put('aaaa') ?? '';
    const b = store.put('bbbb') ?? '';
    const c = store.put('cccc') ?? '';
    expect(failure(store.read({ id: a })).code).toBe('not-found');
    expect(slice(store.read({ id: b })).text).toBe('bbbb');
    expect(slice(store.read({ id: c })).text).toBe('cccc');
    expect(store.put('x'.repeat(11))).toBeUndefined();
    store.clear();
    expect(store.size).toBe(0);
  });
});

describe('removeLegacyOverflowFiles', () => {
  it('removes only the overflow files older versions wrote', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'acm-legacy-'));
    try {
      await writeFile(path.join(dir, 'run-1794816485423-78a1c4afd792.json'), '{}');
      await writeFile(path.join(dir, 'run-1-aaaaaaaaaaaa.json'), '{}');
      await writeFile(path.join(dir, 'run-notes.json'), '{}');
      await writeFile(path.join(dir, 'journal-x.json'), '{}');
      expect(await removeLegacyOverflowFiles(dir)).toBe(2);
      expect((await readdir(dir)).sort()).toEqual(['journal-x.json', 'run-notes.json']);
      expect(await removeLegacyOverflowFiles(path.join(dir, 'missing'))).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
