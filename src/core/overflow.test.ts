import { describe, expect, it } from 'vitest';
import { OverflowStore } from './overflow.js';

describe('OverflowStore', () => {
  it('returns slices of a kept result', () => {
    const store = new OverflowStore();
    const id = store.put('abcdefghij') ?? '';
    expect(store.read({ id, offset: 2, limit: 3 })).toEqual({ ok: true, value: { text: 'cde', offset: 2, totalChars: 10, truncated: true } });
    expect(store.read({ id, offset: 8 })).toEqual({ ok: true, value: { text: 'ij', offset: 8, totalChars: 10, truncated: false } });
  });

  it('never ends a page inside a surrogate pair, and the pages join back exactly', () => {
    const store = new OverflowStore();
    const text = 'a😀b😀c';
    const id = store.put(text) ?? '';
    const pages: string[] = [];
    for (let offset = 0; offset < text.length; ) {
      const r = store.read({ id, offset, limit: 1 });
      if (!r.ok || !('totalChars' in r.value)) throw new Error('expected a slice');
      expect(r.value.text).not.toMatch(/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/);
      pages.push(r.value.text);
      offset += r.value.text.length;
    }
    expect(pages.join('')).toBe(text);
  });

  it('refuses invalid arguments and unknown or expired ids', () => {
    let now = 0;
    const store = new OverflowStore({ ttlMs: 1_000, now: () => now });
    const id = store.put('x') ?? '';
    expect(store.read({ id, limit: 0 })).toMatchObject({ ok: false, error: { code: 'invalid-args' } });
    expect(store.read({ id, extra: 1 })).toMatchObject({ ok: false, error: { code: 'invalid-args' } });
    expect(store.read({ id: 'ov_unknown' })).toMatchObject({ ok: false, error: { code: 'not-found' } });
    now = 1_000;
    expect(store.read({ id })).toMatchObject({ ok: false, error: { code: 'not-found' } });
  });

  it('drops the oldest entries to stay within its size', () => {
    const store = new OverflowStore({ maxChars: 10 });
    const first = store.put('12345') ?? '';
    const second = store.put('12345') ?? '';
    const third = store.put('123') ?? '';
    expect(store.read({ id: first }).ok).toBe(false);
    expect(store.read({ id: second }).ok).toBe(true);
    expect(store.read({ id: third }).ok).toBe(true);
    expect(store.put('x'.repeat(11))).toBeUndefined();
  });
});
