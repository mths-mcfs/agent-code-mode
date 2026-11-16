/**
 * Path pattern matching shared by the tool runtimes (protected paths, glob).
 *
 * Patterns use `/` as separator. `**` matches any number of characters
 * including `/`; a trailing `/**` also matches the directory itself. `*`
 * matches inside one segment, `?` one character inside a segment. Everything
 * else is literal. Backslashes in both the path and the pattern are treated as
 * separators so Windows paths match too.
 */

import path from 'node:path';

const cache = new Map<string, RegExp>();

function toRegExp(pattern: string, caseInsensitive: boolean): RegExp {
  const key = `${caseInsensitive ? 'i' : 's'}:${pattern}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const p = normalizeSeparators(pattern);
  let src = '';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i] ?? '';
    if (ch === '*') {
      if (p[i + 1] === '*') {
        // `/**` at the end matches the directory itself and anything below.
        if (src.endsWith('/') && i + 2 === p.length) {
          src = `${src.slice(0, -1)}(?:/.*)?`;
        } else if (p[i + 2] === '/') {
          // `**/` matches zero or more whole segments.
          src += '(?:.*/)?';
          i++;
        } else {
          src += '.*';
        }
        i++;
      } else {
        src += '[^/]*';
      }
    } else if (ch === '?') {
      src += '[^/]';
    } else {
      src += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  const re = new RegExp(`^${src}$`, caseInsensitive ? 'i' : '');
  cache.set(key, re);
  return re;
}

/** Replaces `\` with `/`. */
export function normalizeSeparators(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Whether file names on this platform are usually case-insensitive. */
export const DEFAULT_CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32';

/** Whether `path` matches `pattern`. Case-insensitive by default on macOS and Windows. */
export function matchesPathPattern(path: string, pattern: string, caseInsensitive = DEFAULT_CASE_INSENSITIVE): boolean {
  return toRegExp(pattern, caseInsensitive).test(normalizeSeparators(path));
}

/** The first pattern `path` matches, or undefined. */
export function findMatchingPattern(
  path: string,
  patterns: readonly string[],
  caseInsensitive = DEFAULT_CASE_INSENSITIVE,
): string | undefined {
  return patterns.find((pattern) => matchesPathPattern(path, pattern, caseInsensitive));
}

function insideOrEqual(root: string, abs: string): string | undefined {
  const rel = path.relative(root, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)) ? rel : undefined;
}

/**
 * How a workspace file is named in diffs and `changedFiles`: relative to the
 * session cwd when inside it; inside another root (client root, additional
 * directory) as `<root basename>/<path in that root>`, choosing the deepest
 * root that holds it; otherwise the absolute path. Always `/`-separated, so a
 * diff header reads `b/src/a.ts` or `b/extra/x`, never `b//abs/path`.
 */
export function workspaceDisplayPath(abs: string, cwd: string, roots: readonly string[]): string {
  const toPosix = (p: string): string => p.split(path.sep).join('/');
  const inCwd = insideOrEqual(cwd, abs);
  if (inCwd !== undefined) return inCwd === '' ? '.' : toPosix(inCwd);
  const holder = [...roots]
    .filter((r) => path.basename(r) !== '' && insideOrEqual(r, abs) !== undefined)
    .sort((a, b) => b.length - a.length)[0];
  if (holder !== undefined) {
    const rel = insideOrEqual(holder, abs) ?? '';
    return toPosix(rel === '' ? path.basename(holder) : path.join(path.basename(holder), rel));
  }
  return toPosix(abs);
}
