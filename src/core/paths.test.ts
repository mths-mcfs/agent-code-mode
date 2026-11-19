import { describe, expect, it } from 'vitest';
import { matchesPathPattern } from './paths.js';

describe('matchesPathPattern', () => {
  it.each([
    ['/ws/.claude/settings.json', '/ws/.claude/settings*.json', true],
    ['/ws/.claude/settings.local.json', '/ws/.claude/settings*.json', true],
    ['/ws/.claude/sub/settings.json', '/ws/.claude/settings*.json', false],
    ['/ws/.claude/hooks', '/ws/.claude/hooks/**', true],
    ['/ws/.claude/hooks/a/b.sh', '/ws/.claude/hooks/**', true],
    ['/ws/.claude/hooksx', '/ws/.claude/hooks/**', false],
    ['/ws/src/a/b/c.ts', '/ws/src/**/*.ts', true],
    ['/ws/src/week\n1/example.ts', '/ws/src/**/*.ts', true],
    ['/ws/src/c.ts', '/ws/src/**/*.ts', true],
    ['C:\\ws\\.codex\\config.toml', 'C:/ws/.codex/**', true],
    ['/C:/ws/project/notes.txt', 'C:\\ws\\project\\*.txt', true],
    ['/ws/a+b.txt', '/ws/a+b.txt', true],
    ['/ws/aab.txt', '/ws/a+b.txt', false],
    ['/ws/.claude/settings.json', '///ws/.claude/settings*.json', true],
    ['/ws/.claude/hooks/a.sh', '////ws/.claude/hooks/**', true],
    ['///ws/.claude/hooks/a.sh', '/ws/.claude/hooks/**', true],
    ['//ws/.claude/settings.json', '/ws/.claude/settings*.json', false],
    ['/ws/.claude/settings.json', '//ws/.claude/settings*.json', false],
    ['/ws/.claude/settings.json', '///ws\\.claude\\settings*.json', false],
  ])('%s vs %s → %s', (p, pattern, expected) => {
    expect(matchesPathPattern(p, pattern, false)).toBe(expected);
  });

  it('can match case-insensitively', () => {
    expect(matchesPathPattern('/ws/.Claude/Settings.json', '/ws/.claude/settings*.json', true)).toBe(true);
    expect(matchesPathPattern('/ws/.Claude/Settings.json', '/ws/.claude/settings*.json', false)).toBe(false);
  });
});
