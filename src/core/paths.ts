/**
 * Path pattern matching shared by the tool runtimes (protected paths, glob).
 *
 * Patterns use `/` as separator. `**` matches any number of characters
 * including `/`; a trailing `/**` also matches the directory itself. `*`
 * matches inside one segment, `?` one character inside a segment. Everything
 * else is literal. Backslashes in both the path and the pattern are treated as
 * separators so Windows paths match too.
 */

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
