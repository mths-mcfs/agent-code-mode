/**
 * Path pattern matching shared by the tool runtimes (protected paths, glob).
 *
 * Patterns use `/` as separator. `**` matches any number of characters
 * including `/`; a trailing `/**` also matches the directory itself. `*`
 * matches inside one segment, `?` one character inside a segment. Everything
 * else is literal. On Windows, backslashes in both the path and the pattern are
 * treated as separators; on POSIX they are part of a name.
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

/** Replaces `\` with `/` on Windows; on POSIX a backslash is an ordinary file-name character. */
export function normalizeSeparators(p: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? p.replace(/\\/g, '/') : p;
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

/**
 * How a workspace file is named in diffs and `changedFiles`: its path
 * relative to the real session cwd, `/`-separated (`src/a.ts`, or
 * `../extra/x` for a file in an additional root). Unambiguous, and still a
 * valid diff path; absolute only when no relative path exists (another
 * Windows drive).
 */
export function workspaceDisplayPath(abs: string, cwd: string): string {
  const rel = path.relative(cwd, abs);
  if (rel === '') return '.';
  return (path.isAbsolute(rel) ? abs : rel).split(path.sep).join('/');
}
