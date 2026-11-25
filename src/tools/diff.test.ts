import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { quotePath, unifiedDiff } from './diff.js';

const hasGit = spawnSync('git', ['--version']).status === 0;

/**
 * Environment for a `git` that sees no repository above `dir` and none of the
 * caller's `GIT_*` variables or system and global config, which otherwise
 * decide where `git apply` writes (a temp dir inside a repository, a hook's GIT_DIR).
 */
function isolatedGitEnv(dir: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  return { ...env, GIT_CEILING_DIRECTORIES: path.dirname(dir), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull };
}

/** Applies `diff` with `git apply` in a scratch directory and returns the result. */
function gitApply(before: string | null, diff: string): string {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'acm-diff-')));
  try {
    if (before !== null) writeFileSync(path.join(dir, 'f.txt'), before);
    writeFileSync(path.join(dir, 'p.diff'), diff);
    const r = spawnSync('git', ['-c', 'core.autocrlf=false', 'apply', '--unsafe-paths', '--whitespace=nowarn', 'p.diff'], {
      cwd: dir,
      encoding: 'utf8',
      env: isolatedGitEnv(dir),
    });
    if (r.status !== 0) throw new Error(`git apply failed: ${r.stderr}\n${diff}`);
    return readFileSync(path.join(dir, 'f.txt'), 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function randomText(rand: () => number): string {
  const lines: string[] = [];
  const n = Math.floor(rand() * 30);
  for (let i = 0; i < n; i++) lines.push(['a', 'b', 'c', 'd', '', 'x y'][Math.floor(rand() * 6)] ?? '');
  return lines.join('\n') + (rand() < 0.5 ? '\n' : '');
}

function mulberry(seed: number): () => number {
  let t = seed;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

describe('unifiedDiff', () => {
  it('produces a standard hunk with context', () => {
    const diff = unifiedDiff('src/a.ts', 'one\ntwo\nthree\n', 'one\n2\nthree\n');
    expect(diff).toBe('--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n one\n-two\n+2\n three\n');
  });

  it('marks creation and a missing final newline', () => {
    expect(unifiedDiff('n.txt', null, 'hi')).toBe('--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,1 @@\n+hi\n\\ No newline at end of file\n');
    expect(unifiedDiff('n.txt', 'same\n', 'same\n')).toBe('');
  });

  it.skipIf(!hasGit)('round-trips through git apply on random edits', () => {
    const rand = mulberry(42);
    for (let i = 0; i < 150; i++) {
      const before = randomText(rand);
      const after = randomText(rand);
      if (before === after) continue;
      const diff = unifiedDiff('f.txt', before, after);
      expect(gitApply(before, diff)).toBe(after);
    }
  });
});

describe('diff headers', () => {
  it('quotes a path that a quote, a backslash or a control character would change', () => {
    expect(unifiedDiff('plain name.txt', 'a\n', 'b\n')).toContain('--- a/plain name.txt\n+++ b/plain name.txt\n');
    expect(unifiedDiff('x\n+++ b/y', 'a\n', 'b\n')).toContain('--- "a/x\\n+++ b/y"\n+++ "b/x\\n+++ b/y"\n');
    expect(quotePath('a/q"b\\c\td')).toBe('"a/q\\"b\\\\c\\td"');
  });

  it.skipIf(!hasGit)('describes the creation of an empty file in a patch git applies', () => {
    const diff = unifiedDiff('f.txt', null, '');
    expect(diff).toContain('new file mode');
    expect(gitApply(null, diff)).toBe('');
  });
});
