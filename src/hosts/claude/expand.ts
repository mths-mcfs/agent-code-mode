import { parse, walk } from 'sh-syntax/sync';
import type { CallExpr, File, Stmt, Word } from 'sh-syntax/sync';
import type { BashGlob, BashGlobPlan } from '../../core/types.js';
import { BashAnalyzer } from './bash.js';

/**
 * Plans the expansion of relative globs read by a pure reader (`cat`, `head`,
 * `tail`, `wc`, `ls`), so the command can name each file literally before it
 * is authorized. The tool runtime expands the plan (I/O) and validates every
 * match; this module only parses.
 *
 * A reader call is planned only when it is certain what bash would do with
 * it:
 * - it is a plain call reached through `;`, `&&`, `||`, `|` and `|&` from the
 *   top of the command (not inside a subshell, block, loop, function or a
 *   substitution), without assignments or redirections;
 * - the command name is the bare reader name;
 * - every word is made of literal text and quotes only (no `$VAR`, `$(...)`,
 *   backticks, brace expansion or a leading `~`);
 * - every option is in that reader's grammar (`READERS`), and options come
 *   before the operands (no permutation);
 * - each glob is relative and has no `..` and no `**`;
 * - the whole command has no `cd`, no function definition and nothing the
 *   analyzer cannot evaluate statically.
 * Anything else: no plan, and the command stays as written.
 *
 * The rewrite puts `--` before the first operand (every reader accepts it)
 * and each match in single quotes, so a file named `-n` or with a space,
 * quote or newline is one operand. The matches and their order come from the
 * bash that runs the command, with the same environment (see
 * `expandBashGlobs`), so the reader gets what bash would have passed.
 */

/** Option grammar of one reader. */
interface Grammar {
  /** Single-letter options without a value; may be combined (`-ln`). */
  readonly flags: string;
  /** Single-letter options with a value (`-n 5`, `-n5`) and what the value must look like. */
  readonly valued: Readonly<Record<string, RegExp>>;
  /** Long options without a value. */
  readonly long: ReadonlySet<string>;
  /** Long options with a value (`--lines=5`, `--lines 5`). */
  readonly longValued: Readonly<Record<string, RegExp>>;
  /** `-5`: a count as an option (head, tail). */
  readonly count: boolean;
  /** Matches may be directories (`ls`, never recursive). */
  readonly directories: boolean;
}

const COUNT = /^[+-]?\d{1,18}[A-Za-z]{0,3}$/;

/**
 * Accepted options. Left out on purpose: `tail -f/-F/--follow/--pid/-s`
 * (never ends), `wc --files0-from` (reads file names from a file), `ls -R`
 * (recursive), `ls -L/-H/--dereference*` (follows links of listed entries),
 * and every option that names a file or a program.
 */
export const READERS: Readonly<Record<string, Grammar>> = {
  cat: {
    flags: 'AbeEnstTuv',
    valued: {},
    long: new Set(['number', 'number-nonblank', 'show-all', 'show-ends', 'show-nonprinting', 'show-tabs', 'squeeze-blank']),
    longValued: {},
    count: false,
    directories: false,
  },
  head: {
    flags: 'qvz',
    valued: { n: COUNT, c: COUNT },
    long: new Set(['quiet', 'silent', 'verbose', 'zero-terminated']),
    longValued: { lines: COUNT, bytes: COUNT },
    count: true,
    directories: false,
  },
  tail: {
    flags: 'qvz',
    valued: { n: COUNT, c: COUNT },
    long: new Set(['quiet', 'silent', 'verbose', 'zero-terminated']),
    longValued: { lines: COUNT, bytes: COUNT },
    count: true,
    directories: false,
  },
  wc: {
    flags: 'clmwL',
    valued: {},
    long: new Set(['bytes', 'chars', 'lines', 'words', 'max-line-length']),
    longValued: {},
    count: false,
    directories: false,
  },
  ls: {
    flags: 'aAbBcCdfFgGhiklmnNopqQrsStuUvxX1',
    valued: {},
    long: new Set([
      'all', 'almost-all', 'human-readable', 'si', 'classify', 'directory', 'reverse', 'size', 'inode',
      'numeric-uid-gid', 'group-directories-first', 'no-group', 'literal', 'escape', 'quote-name', 'full-time',
    ]),
    longValued: { color: /^(never|auto|always)$/, sort: /^(none|size|time|version|extension|width)$/ },
    count: false,
    directories: true,
  },
};

/** One decoded character of a word and whether quoting made it literal. */
interface Ch {
  readonly c: string;
  readonly quoted: boolean;
}

const GLOB_META = new Set(['*', '?', '[']);

/** Characters of a word, or undefined when it holds anything but literal text and quotes. */
function wordChars(word: Word): Ch[] | undefined {
  const out: Ch[] = [];
  for (const part of word.parts) {
    switch (part.type) {
      case 'Lit': {
        const lit = part.value;
        for (let i = 0; i < lit.length; i++) {
          const c = lit[i] ?? '';
          if (c === '\\') {
            const next = lit[i + 1];
            if (next === undefined) return undefined;
            i++;
            if (next !== '\n') out.push({ c: next, quoted: true });
            continue;
          }
          out.push({ c, quoted: false });
        }
        break;
      }
      case 'SglQuoted':
        if (part.dollar) return undefined;
        for (const c of part.value) out.push({ c, quoted: true });
        break;
      case 'DblQuoted': {
        if (part.dollar) return undefined;
        for (const inner of part.parts) {
          if (inner.type !== 'Lit') return undefined;
          const lit = inner.value;
          for (let i = 0; i < lit.length; i++) {
            const c = lit[i] ?? '';
            const next = lit[i + 1];
            if (c === '\\' && next !== undefined && '$`"\\\n'.includes(next)) {
              i++;
              if (next !== '\n') out.push({ c: next, quoted: true });
              continue;
            }
            out.push({ c, quoted: true });
          }
        }
        break;
      }
      default:
        return undefined;
    }
  }
  // Brace expansion and a leading tilde change the word before globbing.
  if (out.some((ch) => !ch.quoted && (ch.c === '{' || ch.c === '}'))) return undefined;
  if (out[0] !== undefined && !out[0].quoted && out[0].c === '~') return undefined;
  return out;
}

const text = (chars: readonly Ch[]): string => chars.map((ch) => ch.c).join('');
const isGlob = (chars: readonly Ch[]): boolean => chars.some((ch) => !ch.quoted && GLOB_META.has(ch.c));

/**
 * The glob word as bash would read it; undefined when it is absolute, has a
 * `..` or empty segment (`a//b`, a trailing slash) or a `**` (globstar may be
 * on). Which entries it matches, and in what order, is left to bash itself.
 */
function compileGlob(chars: readonly Ch[], raw: string, directories: boolean): BashGlob | undefined {
  const segments: Ch[][] = [[]];
  for (const ch of chars) {
    if (ch.c === '/') segments.push([]);
    else segments[segments.length - 1]?.push(ch);
  }
  for (const seg of segments) {
    if (seg.length === 0 || text(seg) === '..') return undefined;
    if (seg.some((ch, i) => !ch.quoted && ch.c === '*' && seg[i + 1]?.c === '*' && seg[i + 1]?.quoted === false)) return undefined;
  }
  return { raw, directories };
}

/** A pending text change, in byte offsets of the source. */
interface Edit {
  readonly start: number;
  readonly end: number;
  /** Index into the plan's globs, or the literal text to insert. */
  readonly glob?: number;
  readonly insert?: string;
}

/** Plans one reader call; undefined when it does not qualify. Appends its globs and edits. */
function planCall(call: CallExpr, stmt: Stmt, source: Buffer, globs: BashGlob[], edits: Edit[]): void {
  if (call.assigns.length > 0 || stmt.redirs.length > 0) return;
  const [head, ...rest] = call.args;
  if (!head || head.parts.length !== 1 || head.parts[0]?.type !== 'Lit') return;
  const name = head.parts[0].value;
  const grammar = Object.hasOwn(READERS, name) ? READERS[name] : undefined;
  if (!grammar) return;
  const words: { word: Word; chars: Ch[] }[] = [];
  for (const word of rest) {
    const chars = wordChars(word);
    if (!chars) return;
    words.push({ word, chars });
  }
  let i = 0;
  let sawEnd = false;
  // Options.
  for (; i < words.length; i++) {
    const w = words[i];
    if (!w) return;
    const t = text(w.chars);
    if (t === '--') {
      sawEnd = true;
      i++;
      break;
    }
    if (!t.startsWith('-') || t === '-') break;
    if (isGlob(w.chars)) return;
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      const opt = eq === -1 ? t.slice(2) : t.slice(2, eq);
      if (eq === -1 && grammar.long.has(opt)) continue;
      const valueRe = Object.hasOwn(grammar.longValued, opt) ? grammar.longValued[opt] : undefined;
      if (!valueRe) return;
      if (eq !== -1) {
        if (!valueRe.test(t.slice(eq + 1))) return;
        continue;
      }
      const value = words[i + 1];
      if (!value || !valueRe.test(text(value.chars))) return;
      i++;
      continue;
    }
    if (grammar.count && /^-\d{1,18}$/.test(t)) continue;
    // A cluster of single-letter options; a valued one takes the rest or the next word.
    let k = 1;
    for (; k < t.length; k++) {
      const letter = t[k] ?? '';
      if (grammar.flags.includes(letter)) continue;
      const valueRe = Object.hasOwn(grammar.valued, letter) ? grammar.valued[letter] : undefined;
      if (!valueRe) return;
      const attached = t.slice(k + 1);
      if (attached !== '') {
        if (!valueRe.test(attached)) return;
      } else {
        const value = words[i + 1];
        if (!value || !valueRe.test(text(value.chars))) return;
        i++;
      }
      break;
    }
  }
  // Operands: no option may follow (GNU would permute it back into an option).
  const operands = words.slice(i);
  const planned: { word: Word; glob: BashGlob }[] = [];
  for (const o of operands) {
    const t = text(o.chars);
    if (!sawEnd && t.startsWith('-') && t !== '-') return;
    if (!isGlob(o.chars)) continue;
    const glob = compileGlob(o.chars, source.subarray(o.word.start, o.word.end).toString('utf8'), grammar.directories);
    if (!glob) return;
    planned.push({ word: o.word, glob });
  }
  if (planned.length === 0) return;
  const firstOperand = operands[0];
  if (!sawEnd && firstOperand) edits.push({ start: firstOperand.word.start, end: firstOperand.word.start, insert: '-- ' });
  for (const p of planned) {
    edits.push({ start: p.word.start, end: p.word.end, glob: globs.length });
    globs.push(p.glob);
  }
}

/** Plain calls reachable from the top through lists and pipelines. */
function topLevelCalls(stmts: readonly Stmt[], out: { call: CallExpr; stmt: Stmt }[]): void {
  for (const stmt of stmts) {
    const visit = (s: Stmt | null): void => {
      if (!s?.cmd) return;
      if (s.cmd.type === 'CallExpr') out.push({ call: s.cmd, stmt: s });
      else if (s.cmd.type === 'BinaryCmd' && s.redirs.length === 0) {
        visit(s.cmd.x);
        visit(s.cmd.y);
      }
    };
    visit(stmt);
  }
}

/** Quotes a string for POSIX sh as one word. */
function quote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The expansion plan of `command`, or undefined when no reader glob qualifies. */
export function planGlobExpansion(command: string): BashGlobPlan | undefined {
  if (command.includes('\0')) return undefined;
  const analysis = BashAnalyzer.analyze(command);
  if (analysis.uncertain.length > 0 || analysis.changesDirectory) return undefined;
  let file: File;
  try {
    file = parse(command);
  } catch {
    return undefined;
  }
  let defines = false;
  walk(file, (node) => {
    if (node.type === 'FuncDecl') defines = true;
  });
  if (defines) return undefined;
  const calls: { call: CallExpr; stmt: Stmt }[] = [];
  topLevelCalls(file.stmts, calls);
  // sh-syntax positions are byte offsets.
  const bytes = Buffer.from(command, 'utf8');
  const globs: BashGlob[] = [];
  const edits: Edit[] = [];
  for (const { call, stmt } of calls) planCall(call, stmt, bytes, globs, edits);
  if (globs.length === 0) return undefined;
  const ordered = [...edits].sort((a, b) => b.start - a.start || b.end - b.start - (a.end - a.start));
  return {
    globs,
    render(matches: readonly (readonly string[])[]): string {
      if (matches.length !== globs.length) throw new Error(`expected ${globs.length} match lists, got ${matches.length}`);
      let out = bytes;
      for (const edit of ordered) {
        const replacement = edit.glob === undefined ? (edit.insert ?? '') : (matches[edit.glob] ?? []).map(quote).join(' ');
        out = Buffer.concat([out.subarray(0, edit.start), Buffer.from(replacement, 'utf8'), out.subarray(edit.end)]);
      }
      return out.toString('utf8');
    },
  };
}
