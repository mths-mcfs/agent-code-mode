import { describe, expect, it } from 'vitest';
import { applyHunk, generatePatch, lineTexts, parsePatch, PatchError } from './apply-patch.js';

function roundTrip(before: string | null, after: string): { patch: string; result: string; exact: boolean } {
  const { patch, exact } = generatePatch('src/file.txt', before, after);
  const { hunks } = parsePatch(patch);
  expect(hunks).toHaveLength(1);
  const hunk = hunks[0];
  if (hunk === undefined) throw new Error('no hunk');
  expect(hunk.path).toBe('src/file.txt');
  return { patch, result: applyHunk(hunk.kind === 'add' ? null : before, hunk), exact };
}

const lines = (n: number, f: (i: number) => string): string => Array.from({ length: n }, (_, i) => `${f(i)}\n`).join('');

describe('apply_patch exactness', () => {
  it('refuses a patch whose reparsed path is not the prepared file', () => {
    expect(() => generatePatch('a.txt ', null, 'x\n')).toThrow(PatchError);
  });

  it('refuses a trailing update chunk without lines', () => {
    expect(() => parsePatch('*** Begin Patch\n*** Update File: a\n@@\n x\n+y\n@@\n*** End Patch')).toThrow(/does not contain any lines/);
  });
});

describe('apply_patch generation round-trip', () => {
  it('adds a file', () => {
    const { patch, result, exact } = roundTrip(null, 'one\ntwo\n');
    expect(patch).toBe('*** Begin Patch\n*** Add File: src/file.txt\n+one\n+two\n*** End Patch');
    expect(result).toBe('one\ntwo\n');
    expect(exact).toBe(true);
  });

  it('updates with several hunks', () => {
    const before = lines(40, (i) => `line ${i}`);
    const after = before.replace('line 2\n', 'LINE 2\n').replace('line 20\n', 'line 20\ninserted\n').replace('line 35\n', '');
    const { patch, result, exact } = roundTrip(before, after);
    expect(patch.match(/^@@$/gm)).toHaveLength(3);
    expect(patch).toContain('-line 2\n+LINE 2');
    expect(result).toBe(after);
    expect(exact).toBe(true);
  });

  it('keeps CRLF line endings', () => {
    const before = 'a\r\nb\r\nc\r\nd\r\n';
    const after = 'a\r\nB\r\nc\r\nd\r\nnew\r\n';
    const { patch, result, exact } = roundTrip(before, after);
    expect(patch).not.toContain('\r');
    expect(result).toBe(after);
    expect(exact).toBe(true);
  });

  it('handles a file without a trailing newline (Codex always terminates the last line)', () => {
    const before = 'a\nb\nc';
    const after = 'a\nB\nc';
    const { result, exact } = roundTrip(before, after);
    expect(lineTexts(result)).toEqual(lineTexts(after));
    expect(result).toBe('a\nB\nc\n');
    expect(exact).toBe(false);
    expect(roundTrip(before, 'a\nB\nc\n').exact).toBe(true);
  });

  it('falls back to a whole-file chunk when context is ambiguous', () => {
    const block = 'x\nx\nx\nx\n';
    const before = `${block}target\n${block}target\n${block}`;
    const after = `${block}target\n${block}changed\n${block}`;
    const { result } = roundTrip(before, after);
    expect(result).toBe(after);
  });

  it('handles empty files, identical content and full deletion', () => {
    expect(roundTrip('', 'x\n').result).toBe('x\n');
    expect(roundTrip('a\n', 'a\n').result).toBe('a\n');
    expect(roundTrip('a\nb\n', '').result).toBe('');
    expect(roundTrip(null, '').result).toBe('');
    expect(roundTrip('', '').result).toBe('');
  });

  it('keeps lines that look like patch markers', () => {
    const after = '*** End Patch\n@@\n*** End of File\n+plus\n-minus\n   \n\n';
    expect(roundTrip(null, after).result).toBe(after);
    expect(roundTrip('keep\n', `keep\n${after}`).result).toBe(`keep\n${after}`);
  });

  it('round-trips random edits', () => {
    let seed = 7;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let t = 0; t < 2000; t++) {
      const variants = ['l1', 'l1 ', ' l1', 'l\u20131', 'l2', '', 'l3'];
      const a = Array.from({ length: rand(30) }, () => variants[rand(variants.length)] ?? '');
      const b = [...a];
      for (let k = rand(5); k > 0; k--) {
        const op = rand(3);
        const at = rand(b.length + 1);
        if (op === 0) b.splice(at, 0, `n${rand(4)}`);
        else if (op === 1) b.splice(at, 1);
        else b[at] = `c${rand(4)}`;
      }
      const before = a.map((l) => `${l}\n`).join('');
      const after = b.filter((l) => l !== undefined).map((l) => `${l}\n`).join('');
      expect(roundTrip(before, after).result, `${before}=>${after}`).toBe(after);
    }
  });
});

describe('apply_patch parsing', () => {
  it('parses what Codex models write, including heredoc wrapping', () => {
    const p = parsePatch("<<'EOF'\n*** Begin Patch\n*** Update File: a.py\n@@ def f():\n-    return 1\n+    return 2\n*** End Patch\nEOF\n");
    expect(p.hunks[0]).toMatchObject({ kind: 'update', path: 'a.py' });
    expect(applyHunk('def f():\n    return 1\n', p.hunks[0] ?? { kind: 'delete', path: '' })).toBe('def f():\n    return 2\n');
  });

  it('rejects malformed patches', () => {
    for (const bad of ['*** Begin Patch\n*** Update File: a\n*** End Patch', 'nope', '*** Begin Patch\n*** Add File: a\n+x', '*** Begin Patch\n*** Frob File: a\n*** End Patch']) {
      expect(() => parsePatch(bad), bad).toThrow(PatchError);
    }
  });
});
