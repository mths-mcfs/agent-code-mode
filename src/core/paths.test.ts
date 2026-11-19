import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { matchesPathPattern, workspaceDisplayPath } from './paths.js';

describe('matchesPathPattern', () => {
  it.each([
    ['/ws/.claude/settings.json', '/ws/.claude/settings*.json', true],
    ['/ws/.claude/settings.local.json', '/ws/.claude/settings*.json', true],
    ['/ws/.claude/sub/settings.json', '/ws/.claude/settings*.json', false],
    ['/ws/.claude/hooks', '/ws/.claude/hooks/**', true],
    ['/ws/.claude/hooks/a/b.sh', '/ws/.claude/hooks/**', true],
    ['/ws/.claude/hooksx', '/ws/.claude/hooks/**', false],
    ['/ws/src/a/b/c.ts', '/ws/src/**/*.ts', true],
    ['/ws/src/c.ts', '/ws/src/**/*.ts', true],
    ['C:\\ws\\.codex\\config.toml', 'C:/ws/.codex/**', true],
    ['/ws/a+b.txt', '/ws/a+b.txt', true],
    ['/ws/aab.txt', '/ws/a+b.txt', false],
  ])('%s vs %s → %s', (p, pattern, expected) => {
    expect(matchesPathPattern(p, pattern, false)).toBe(expected);
  });

  it('can match case-insensitively', () => {
    expect(matchesPathPattern('/ws/.Claude/Settings.json', '/ws/.claude/settings*.json', true)).toBe(true);
    expect(matchesPathPattern('/ws/.Claude/Settings.json', '/ws/.claude/settings*.json', false)).toBe(false);
  });
});

describe('workspaceDisplayPath', () => {
  const sep = (p: string): string => p.split('/').join(path.sep);
  it('is the path relative to the cwd, also for files in other roots', () => {
    const cwd = sep('/w/proj');
    expect(workspaceDisplayPath(sep('/w/proj/src/a.ts'), cwd)).toBe('src/a.ts');
    expect(workspaceDisplayPath(cwd, cwd)).toBe('.');
    expect(workspaceDisplayPath(sep('/w/extra/x'), cwd)).toBe('../extra/x');
    // A cwd folder and an additional root with the same name stay distinct.
    expect(workspaceDisplayPath(sep('/w/proj/extra/x'), cwd)).toBe('extra/x');
    expect(workspaceDisplayPath(sep('/data/deep/y'), cwd)).toBe('../../data/deep/y');
  });
});
