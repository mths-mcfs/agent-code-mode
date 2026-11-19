/**
 * Translation of Rust `regex` crate patterns (what Codex uses for hook
 * matchers) to JavaScript RegExp, for the subset whose meaning is the same
 * on tool names. Returns undefined when the pattern uses anything that
 * cannot be translated exactly; the caller then treats the hook as matching
 * everything, so a blocking hook never silently stops matching.
 *
 * Translated: literals and escaped metacharacters, `.`, `^`, `$` (both match
 * only at the ends of the text without the `m` flag, in both engines), `\A`,
 * `\z`, `\b`, `\B`, `\d \D \w \W \s \S` (tool names are ASCII, where the
 * Unicode and ASCII classes agree), `\n \t \r \f \v`, `\xHH`, `\x{H..}`,
 * `\u{H..}`, `\p{..}`/`\P{..}` and `\pL` forms, groups `( )`, `(?: )`,
 * `(?P<name> )`, `(?<name> )`, alternation, greedy and lazy quantifiers,
 * bracket classes with ranges, escapes and `[:alpha:]`-style ASCII classes,
 * and leading flag groups `(?i)`, `(?s)`, `(?m)`, `(?U)` absent (see below).
 *
 * Not translated (undefined): flag groups other than at the very start or
 * with `x`, `U`, `R` or negation, scoped flags `(?i: )`, nested classes and
 * class set operations (`&&`, `--`, `~~`), `\Z`, `\Q..\E`, `\<`, `\>`,
 * `\b{..}`, octal escapes, `{,n}` quantifiers, and anything Rust rejects.
 */

const POSIX_CLASSES: Record<string, string> = {
  alnum: '0-9A-Za-z',
  alpha: 'A-Za-z',
  ascii: '\\x00-\\x7F',
  blank: '\\t ',
  cntrl: '\\x00-\\x1F\\x7F',
  digit: '0-9',
  graph: '!-~',
  lower: 'a-z',
  print: ' -~',
  punct: '!-\\/:-@\\[-`{-~',
  space: '\\t\\n\\v\\f\\r ',
  upper: 'A-Z',
  word: '0-9A-Za-z_',
  xdigit: '0-9A-Fa-f',
};

const META = new Set([...'\\.+*?()|[]{}^$#&-~']);
const JS_SYNTAX = new Set([...'^$\\.*+?()[]{}|/']);

export interface JsRegex {
  readonly source: string;
  readonly flags: string;
}

class Untranslatable extends Error {}

function hexChar(hex: string): string {
  if (!/^[0-9A-Fa-f]{1,8}$/.test(hex)) throw new Untranslatable();
  const code = Number.parseInt(hex, 16);
  if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new Untranslatable();
  return `\\u{${code.toString(16)}}`;
}

/** Reads an escape at `p[i] === '\\'`; returns [js, next index, isClassEscape]. */
function escape(p: string, i: number, inClass: boolean): [string, number] {
  const c = p[i + 1];
  if (c === undefined) throw new Untranslatable();
  switch (c) {
    case 'A':
      if (inClass) throw new Untranslatable();
      return ['^', i + 2];
    case 'z':
      if (inClass) throw new Untranslatable();
      return ['$', i + 2];
    case 'b':
    case 'B':
      if (inClass || p[i + 2] === '{') throw new Untranslatable();
      return [`\\${c}`, i + 2];
    case 'd':
    case 'D':
    case 'w':
    case 'W':
    case 's':
    case 'S':
    case 'n':
    case 't':
    case 'r':
    case 'f':
    case 'v':
      return [`\\${c}`, i + 2];
    case 'a':
      return ['\\x07', i + 2];
    case 'x':
    case 'u':
    case 'U': {
      if (p[i + 2] === '{') {
        const end = p.indexOf('}', i + 3);
        if (end < 0) throw new Untranslatable();
        return [hexChar(p.slice(i + 3, end)), end + 1];
      }
      const len = c === 'x' ? 2 : c === 'u' ? 4 : 8;
      return [hexChar(p.slice(i + 2, i + 2 + len).padEnd(len, 'g')), i + 2 + len];
    }
    case 'p':
    case 'P': {
      if (p[i + 2] === '{') {
        const end = p.indexOf('}', i + 3);
        if (end < 0) throw new Untranslatable();
        const name = p.slice(i + 3, end);
        if (!/^[A-Za-z_][A-Za-z0-9_]*(=[A-Za-z0-9_]+)?$/.test(name)) throw new Untranslatable();
        return [`\\${c}{${name}}`, end + 1];
      }
      const one = p[i + 2];
      if (one === undefined || !/[A-Za-z]/.test(one)) throw new Untranslatable();
      return [`\\${c}{${one}}`, i + 3];
    }
    default:
      if (META.has(c) || c === ' ') {
        if (JS_SYNTAX.has(c) || (inClass && (c === '-' || c === ']'))) return [`\\${c}`, i + 2];
        return [c, i + 2];
      }
      throw new Untranslatable();
  }
}

function literal(c: string, inClass: boolean): string {
  if (inClass) return c === '\\' || c === ']' || c === '[' || c === '^' || c === '-' ? `\\${c}` : c;
  return JS_SYNTAX.has(c) ? `\\${c}` : c;
}

/** Translates a bracket class starting at `p[i] === '['`. */
function bracket(p: string, i: number): [string, number] {
  let j = i + 1;
  let out = '[';
  if (p[j] === '^') {
    out += '^';
    j++;
  }
  let first = true;
  for (;;) {
    const c = p[j];
    if (c === undefined) throw new Untranslatable();
    if (c === ']' && !first) return [`${out}]`, j + 1];
    first = false;
    if (c === '[') {
      const m = /^\[:(\^?)([a-z]+):\]/.exec(p.slice(j));
      const cls = m ? POSIX_CLASSES[m[2] ?? ''] : undefined;
      if (!m || cls === undefined || m[1] === '^') throw new Untranslatable();
      out += cls;
      j += m[0].length;
      continue;
    }
    if ((c === '&' || c === '-' || c === '~') && p[j + 1] === c) throw new Untranslatable();
    if (c === '\\') {
      const [js, next] = escape(p, j, true);
      out += js;
      j = next;
      continue;
    }
    if (c === '-' && p[j + 1] !== ']' && out.length > 1 && out !== '[^') {
      out += '-';
      j++;
      continue;
    }
    out += literal(c, true);
    j++;
  }
}

/** Translates a Rust regex pattern, or returns undefined when it cannot be done exactly. */
export function rustRegexToJs(pattern: string): JsRegex | undefined {
  try {
    let i = 0;
    let flags = 'u';
    // Leading flag group, e.g. `(?i)` or `(?is)`.
    const lead = /^\(\?([a-zA-Z-]+)\)/.exec(pattern);
    if (lead) {
      for (const f of lead[1] ?? '') {
        if (f === 'i' || f === 's' || f === 'm') {
          if (!flags.includes(f)) flags += f;
        } else throw new Untranslatable();
      }
      i = lead[0].length;
    }
    let out = '';
    let depth = 0;
    let canQuantify = false;
    while (i < pattern.length) {
      const c = pattern[i] ?? '';
      if (c === '\\') {
        const [js, next] = escape(pattern, i, false);
        out += js;
        canQuantify = js !== '^' && js !== '$' && js !== '\\b' && js !== '\\B';
        i = next;
      } else if (c === '[') {
        const [js, next] = bracket(pattern, i);
        out += js;
        canQuantify = true;
        i = next;
      } else if (c === '(') {
        if (pattern[i + 1] === '?') {
          const named = /^\(\?P?<([A-Za-z_][A-Za-z0-9_]*)>/.exec(pattern.slice(i));
          if (named) {
            out += '(';
            i += named[0].length;
          } else if (pattern[i + 2] === ':') {
            out += '(?:';
            i += 3;
          } else throw new Untranslatable();
        } else {
          out += '(';
          i++;
        }
        depth++;
        canQuantify = false;
      } else if (c === ')') {
        if (depth === 0) throw new Untranslatable();
        depth--;
        out += ')';
        canQuantify = true;
        i++;
      } else if (c === '*' || c === '+' || c === '?') {
        if (!canQuantify) throw new Untranslatable();
        out += c;
        i++;
        if (pattern[i] === '?') {
          out += '?';
          i++;
        }
        canQuantify = false;
      } else if (c === '{') {
        const m = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i));
        if (!m || !canQuantify) throw new Untranslatable();
        out += m[0];
        i += m[0].length;
        if (pattern[i] === '?') {
          out += '?';
          i++;
        }
        canQuantify = false;
      } else if (c === '|') {
        out += '|';
        canQuantify = false;
        i++;
      } else if (c === '^' || c === '$') {
        out += c;
        canQuantify = false;
        i++;
      } else if (c === '.') {
        out += '.';
        canQuantify = true;
        i++;
      } else {
        // A literal; `}` and `]` alone are literals in Rust.
        out += literal(c, false);
        canQuantify = true;
        i += c.length;
      }
    }
    if (depth !== 0) return undefined;
    new RegExp(out, flags);
    return { source: out, flags };
  } catch {
    return undefined;
  }
}
