import { parse, walk } from 'sh-syntax/sync';
import type { CallExpr, DeclClause, File, Node, Redirect, Word, WordPart } from 'sh-syntax/sync';

/**
 * Splits a Bash command line into the simple commands it would run, the way
 * Claude Code does before it matches Bash permission rules, but stricter.
 *
 * Parser: `sh-syntax` (mvdan/sh, the parser behind shfmt, compiled to WASM
 * with a synchronous Node entry). It understands the full bash grammar, so
 * commands nested in `&&`, `||`, `;`, `|`, `&`, subshells, blocks, control
 * flow, `$(...)`, backticks, process substitution and here-documents are all
 * found. On top of the parse tree this module:
 * - strips leading `VAR=value` assignments and process wrappers (`timeout`,
 *   `time`, `nice`, `nohup`, `stdbuf`, `command`, `builtin`, `noglob`, `exec`,
 *   `env`, `sudo`, `xargs`, `find -exec`) and offers every stripped form to
 *   deny/ask matching;
 * - parses the inner string of `bash -c`/`sh -c` (and other shells) and adds
 *   its commands;
 * - collects redirection targets (`> f`, `< f`, `tee f`) so file rules can
 *   check them;
 * - reports constructs it cannot evaluate statically (`eval`, `source`, a
 *   dynamic command name, a shell reading commands from stdin, a here-document
 *   with substitutions, a parse error) as `uncertain`, which callers treat as
 *   `ask`.
 */

/** One simple command, as matching sees it. */
export interface SimpleCommand {
  /** Source text of the command as written (assignments included). */
  readonly raw: string;
  /** Every text deny/ask rules are matched against: normalized forms with and without wrappers. */
  readonly denyForms: readonly string[];
  /**
   * Text allow rules are matched against: the command after stripping only
   * the wrappers Claude Code documents (`timeout`, `time`, `nice`, `nohup`,
   * `stdbuf`, `command`, `builtin`, `noglob`, bare `xargs`). Undefined when the
   * command cannot be approved by an allow rule (dynamic words, leading
   * assignments, unknown command name).
   */
  readonly allowForm: string | undefined;
  /**
   * For each form (as written, each stripped wrapper level, each basename
   * variant): the words before the first word only known at run time.
   */
  readonly staticPrefixes: readonly string[];
  /** True when some word's value is only known at run time. */
  readonly dynamic: boolean;
  /** True when some word is an unquoted glob, so bash may hand the command other words. */
  readonly globbed: boolean;
  /** The command's words as matching sees them (value undefined: only known at run time). */
  readonly words: readonly Operand[];
}

/** A file a command reads or writes by name (redirection or `tee`). */
export interface FileTarget {
  readonly access: 'read' | 'write';
  /** The path as written, or undefined when it is only known at run time. */
  readonly path: string | undefined;
  /** For a glob (path undefined): the pattern as bash sees it, before expansion. */
  readonly pattern?: string;
  /**
   * Written only if this path (as written) is a directory when the command
   * runs: `cp src dest` writes `dest/src` when `dest` is one.
   */
  readonly whenDirectory?: string;
}

export interface BashAnalysis {
  readonly commands: readonly SimpleCommand[];
  readonly files: readonly FileTarget[];
  /** Reasons the command cannot be evaluated statically. Non-empty means `ask`. */
  readonly uncertain: readonly string[];
  /** True when a `cd` appears, so relative file targets may not resolve against the call's cwd. */
  readonly changesDirectory: boolean;
  /** Every `rm`/`rmdir` invocation, for the critical-path check. */
  readonly removals: readonly Removal[];
}

/** An operand of a command: its value when static, else undefined. */
export interface Operand {
  readonly value: string | undefined;
  readonly raw: string;
  /** Unquoted glob characters appear. */
  readonly glob: boolean;
}

/** One `rm` or `rmdir` call. */
export interface Removal {
  readonly recursive: boolean;
  readonly targets: readonly Operand[];
}

/** Commands longer than this are not analyzed (treated as uncertain). */
export const MAX_ANALYZED_COMMAND_CHARS = 100_000;

/** How deep `bash -c '...'` strings are followed. */
const MAX_SHELL_NESTING = 4;

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'busybox']);

/** Shell options followed by a separate operand (`bash -O extglob -c ...`). */
const SHELL_OPTIONS_WITH_OPERAND = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file', '--debugger-file']);

/** Builtins whose arguments become shell code: always uncertain. */
const CODE_EVALUATORS = new Set(['eval', 'source', '.', 'trap', 'fc']);

/**
 * Commands whose operands may be files they read, for Read rules. Every
 * non-option operand is treated as a possible file (a `sed` script or a `grep`
 * pattern too): matching a pattern text against path rules is harmless, and
 * missing a file is not.
 */
const FILE_READERS = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'most', 'nl', 'tac', 'rev', 'strings', 'xxd', 'od', 'hexdump', 'base64', 'base32',
  'sed', 'awk', 'gawk', 'mawk', 'nawk', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'zcat', 'zgrep', 'zless', 'bzcat', 'xzcat',
  'cut', 'sort', 'uniq', 'wc', 'diff', 'cmp', 'comm', 'join', 'paste', 'column', 'fold', 'fmt', 'pr', 'expand', 'unexpand',
  'jq', 'yq', 'xmllint', 'file', 'md5sum', 'sha1sum', 'sha256sum', 'sha512sum', 'cksum', 'b2sum', 'iconv', 'dos2unix',
  'vi', 'vim', 'nano', 'view', 'emacs', 'openssl', 'gpg', 'tar', 'zip', 'unzip', 'gzip', 'gunzip', 'bzip2', 'xz', 'curl', 'wget', 'scp',
]);

/** Commands that write (or delete) the files they name, for Edit rules. */
const FILE_WRITERS = new Set(['tee', 'touch', 'truncate', 'rm', 'rmdir', 'unlink', 'shred', 'mkdir', 'chmod', 'chown', 'chgrp']);

/** Commands that read some operands and write others: every operand is both (dd: `if=` read, `of=` written). */
// Rule: acm asks for writes into sensitive locations even where the host's parser misses them (`-t`, `dd of=`, rsync into .git).
const FILE_COPIERS = new Set(['rsync', 'scp', 'dd']);

/**
 * Commands of the form `cmd [opts] SOURCE... DEST` or `cmd [opts] -t DIR SOURCE...`.
 * Every operand is read and written, as Claude Code checks them (measured on
 * 2.1.326: `cp .git/config /tmp/x` asks for `.git/config`); the `-t` directory,
 * in any spelling, is written. For each, its short options that take a value.
 */
interface SourceDestSpec {
  /** Short options without a value. */
  readonly shortFlags: string;
  /** Short options taking a value (`-tDIR`, `-t DIR`, `-rt DIR`). */
  readonly shortValue: string;
  /** Long options and their argument: none, optional (`=` only) or required (`=` or the next word). */
  readonly long: Readonly<Record<string, 'none' | 'optional' | 'required'>>;
}
const COMMON_LONG = { backup: 'optional', suffix: 'required', 'target-directory': 'required', 'no-target-directory': 'none', verbose: 'none', help: 'none', version: 'none', debug: 'none' } as const;
const SOURCE_DEST: ReadonlyMap<string, SourceDestSpec> = new Map<string, SourceDestSpec>([
  ['cp', { shortFlags: 'abdfHilLnPpRrsTuvxZ', shortValue: 'St', long: { ...COMMON_LONG, archive: 'none', 'attributes-only': 'none', 'copy-contents': 'none', dereference: 'none', force: 'none', interactive: 'none', link: 'none', 'no-dereference': 'none', 'no-clobber': 'none', 'no-preserve': 'required', 'one-file-system': 'none', parents: 'none', preserve: 'optional', recursive: 'none', reflink: 'optional', 'remove-destination': 'none', sparse: 'required', 'strip-trailing-slashes': 'none', 'symbolic-link': 'none', update: 'optional', 'keep-directory-symlink': 'none', context: 'optional', exchange: 'none' } }],
  ['mv', { shortFlags: 'bfinTuvZ', shortValue: 'St', long: { ...COMMON_LONG, force: 'none', interactive: 'none', 'no-clobber': 'none', 'no-copy': 'none', 'strip-trailing-slashes': 'none', update: 'optional', context: 'none', exchange: 'none' } }],
  ['ln', { shortFlags: 'bdFfiLnPrsTv', shortValue: 'St', long: { ...COMMON_LONG, directory: 'none', force: 'none', interactive: 'none', logical: 'none', 'no-dereference': 'none', physical: 'none', relative: 'none', symbolic: 'none' } }],
  ['install', { shortFlags: 'bcCdDpsTvZ', shortValue: 'gmoSt', long: { ...COMMON_LONG, compare: 'none', directory: 'none', group: 'required', mode: 'required', owner: 'required', 'preserve-timestamps': 'none', 'preserve-context': 'none', strip: 'none', 'strip-program': 'required', context: 'optional' } }],
]);

/**
 * The GNU long option a word names: an exact name, or a prefix of exactly
 * one of `names` (getopt accepts any unambiguous abbreviation). Undefined
 * when it names none, or several.
 */
function longOption(name: string, names: readonly string[]): string | undefined {
  if (names.includes(name)) return name;
  const hits = names.filter((n) => n.startsWith(name));
  return hits.length === 1 ? hits[0] : undefined;
}

/**
 * Where GNU sed may write the backup of `file` for an in-place suffix: `file`
 * + suffix; with `*` in the suffix, each `*` replaced by the file name as
 * written (GNU sed 4.9: `bak-*` on `sub/f` renames to `bak-sub/f`, relative
 * to the working directory). Other versions and the documentation use the
 * base name, placed in the working directory or next to the file; all
 * readings are returned (a superset is safe). The suffix is not
 * shell-expanded, so a leading `~` is a plain name.
 */
export function sedBackups(file: string, suffix: string): string[] {
  const literal = (p: string): string => (p.startsWith('~') ? `./${p}` : p);
  if (!suffix.includes('*')) return [literal(file + suffix)];
  const slash = file.lastIndexOf('/');
  const dir = slash === -1 ? '' : file.slice(0, slash + 1);
  const byBase = suffix.split('*').join(file.slice(slash + 1));
  const byName = suffix.split('*').join(file);
  return [...new Set([literal(byName), literal(byBase), byBase.startsWith('/') ? byBase : literal(dir + byBase)])];
}

/** GNU sed's long options; `expression`, `file` and `line-length` take a value, `in-place` an optional `=SUFFIX`. */
const SED_LONG = ['quiet', 'silent', 'debug', 'expression', 'file', 'follow-symlinks', 'in-place', 'line-length', 'posix', 'regexp-extended', 'separate', 'sandbox', 'unbuffered', 'null-data', 'binary', 'zero-terminated', 'help', 'version'];

/** Wrapper levels stripped before the command is reported as uncertain. */
const MAX_WRAPPER_LEVELS = 64;

/** Builtins that rebind a command name: the commands after them cannot be matched by name. */
const NAME_REBINDERS = new Set(['alias', 'hash', 'enable']);

// Redirect operators (sh-syntax RedirOperator values).
const REDIR_OUT = new Set([63, 64, 69, 70, 74, 75, 76, 77]); // > >> >| >>| &> &>| &>> &>>|
const REDIR_IN = new Set([65]); // <
const REDIR_INOUT = new Set([66]); // <>
const REDIR_HDOC = new Set([71, 72]); // << <<-
const REDIR_DUP = new Set([67, 68]); // <& >&

type WordValue = Operand;

function decodeUnquoted(lit: string): string {
  let out = '';
  for (let i = 0; i < lit.length; i++) {
    const ch = lit[i];
    if (ch === '\\' && i + 1 < lit.length) {
      const next = lit[i + 1];
      i++;
      if (next !== '\n') out += next;
    } else {
      out += ch;
    }
  }
  return out;
}

function decodeDoubleQuoted(lit: string): string {
  let out = '';
  for (let i = 0; i < lit.length; i++) {
    const ch = lit[i];
    const next = lit[i + 1];
    if (ch === '\\' && next !== undefined && '$`"\\\n'.includes(next)) {
      i++;
      if (next !== '\n') out += next;
    } else {
      out += ch;
    }
  }
  return out;
}

const ANSI_ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v' };

/** Decodes `$'...'`; undefined when an escape is not a simple one. */
function decodeAnsi(lit: string): string | undefined {
  let out = '';
  for (let i = 0; i < lit.length; i++) {
    const ch = lit[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = lit[i + 1];
    const mapped = next === undefined ? undefined : ANSI_ESCAPES[next];
    if (mapped === undefined) return undefined;
    out += mapped;
    i++;
  }
  return out;
}

const UNQUOTED_GLOB = /(^|[^\\])[*?[]/;

function partsValue(parts: readonly WordPart[], quoted: boolean): { value: string | undefined; glob: boolean } {
  let value: string | undefined = '';
  let glob = false;
  for (const part of parts) {
    let piece: string | undefined;
    switch (part.type) {
      case 'Lit':
        if (!quoted && UNQUOTED_GLOB.test(part.value)) glob = true;
        piece = quoted ? decodeDoubleQuoted(part.value) : decodeUnquoted(part.value);
        break;
      case 'SglQuoted':
        piece = part.dollar ? decodeAnsi(part.value) : part.value;
        break;
      case 'DblQuoted': {
        if (part.dollar) {
          piece = undefined; // $"..." is locale translation
          break;
        }
        const inner = partsValue(part.parts, true);
        piece = inner.value;
        break;
      }
      default:
        piece = undefined;
    }
    if (piece === undefined || value === undefined) value = undefined;
    else value += piece;
  }
  return { value, glob };
}

/** Source being analyzed. sh-syntax positions are byte offsets into its UTF-8 form. */
interface Ctx {
  readonly source: string;
  readonly bytes: Buffer;
  readonly depth: number;
}

/**
 * One character of a static word and whether quoting (or a backslash) made it
 * literal. An empty `''` or `""` leaves a zero-width quoted marker (`c: ''`):
 * it adds no text but still stops a tilde-prefix or an assignment name.
 */
interface WordChar {
  readonly c: string;
  readonly quoted: boolean;
}

/**
 * The characters of a word, or undefined when part of it is only known at
 * run time. `opaque` parts (substitutions) are kept as a placeholder so brace
 * detection still sees the unquoted text around them.
 */
function wordChars(parts: readonly WordPart[]): { chars: WordChar[]; static: boolean } {
  const chars: WordChar[] = [];
  let isStatic = true;
  const push = (text: string, quoted: boolean): void => {
    if (text === '' && quoted) chars.push({ c: '', quoted });
    for (const c of text) chars.push({ c, quoted });
  };
  for (const part of parts) {
    switch (part.type) {
      case 'Lit': {
        const lit = part.value;
        for (let i = 0; i < lit.length; i++) {
          const c = lit[i] ?? '';
          if (c === '\\' && i + 1 < lit.length) {
            const next = lit[i + 1] ?? '';
            i++;
            if (next !== '\n') chars.push({ c: next, quoted: true });
            continue;
          }
          chars.push({ c, quoted: false });
        }
        break;
      }
      case 'SglQuoted': {
        const v = part.dollar ? decodeAnsi(part.value) : part.value;
        if (v === undefined) {
          isStatic = false;
          chars.push({ c: '\0', quoted: true });
        } else push(v, true);
        break;
      }
      case 'DblQuoted': {
        const inner = part.dollar ? undefined : partsValue(part.parts, true).value;
        if (inner === undefined) {
          isStatic = false;
          chars.push({ c: '\0', quoted: true });
        } else push(inner, true);
        break;
      }
      default:
        isStatic = false;
        chars.push({ c: '\0', quoted: true });
    }
  }
  return { chars, static: isStatic };
}

/** Whether bash may brace-expand the word (`{a,b}`, `{1..3}`, `x{,}`); `{}` and `a{b}c` stay as written. */
function hasBraceExpansion(chars: readonly WordChar[]): boolean {
  // Any unquoted `{`, then a `,` or `..`, then a `}`: a superset of what bash expands (its pairing rules are subtle).
  let stage = 0;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (!ch || ch.quoted) continue;
    if (stage === 0 && ch.c === '{') stage = 1;
    else if (stage === 1 && (ch.c === ',' || (ch.c === '.' && chars[i + 1]?.c === '.' && chars[i + 1]?.quoted === false))) stage = 2;
    else if (stage === 2 && ch.c === '}') return true;
  }
  return false;
}

/**
 * Where bash looks for a tilde-prefix in a word (bash `general.c`
 * `assignment` and `subst.c` tilde handling, outside POSIX mode):
 * - at the start of the word, when its first character is an unquoted `~`
 *   (an empty `''` or `""` in front makes it quoted);
 * - in a word that is an assignment as written, `NAME=` or `NAME+=` with
 *   every character unquoted, right after that `=` and after each unquoted
 *   `:` of the value. `declare`, `export`, `local` and plain arguments follow
 *   the same rule.
 * A subscripted assignment (`a[1]=~`) is reported as unknown: bash parses the
 * subscript with its own rules.
 */
function tildeStarts(chars: readonly WordChar[]): { starts: number[]; assignment: boolean } | 'unknown' {
  const starts: number[] = [];
  if (chars[0]?.c === '~' && !chars[0].quoted) starts.push(0);
  const unquoted = (i: number, test: (c: string) => boolean): boolean => {
    const ch = chars[i];
    return ch !== undefined && !ch.quoted && test(ch.c);
  };
  let i = 0;
  if (!unquoted(0, (c) => /^[A-Za-z_]$/.test(c))) return { starts, assignment: false };
  while (unquoted(i + 1, (c) => /^[A-Za-z0-9_]$/.test(c))) i++;
  i++;
  if (unquoted(i, (c) => c === '[')) return chars.some((ch) => ch.c === '~') ? 'unknown' : { starts, assignment: false };
  if (unquoted(i, (c) => c === '+')) i++;
  if (!unquoted(i, (c) => c === '=')) return { starts, assignment: false };
  for (let j = i; j < chars.length; j++) {
    if ((j === i || unquoted(j, (c) => c === ':')) && unquoted(j + 1, (c) => c === '~')) starts.push(j + 1);
  }
  return { starts, assignment: true };
}

/**
 * Applies bash's tilde expansion to a static word (see `tildeStarts`). Bash
 * reads the tilde word up to the next unquoted `/` (in an assignment, also
 * `:`); when any of its characters is quoted (`~''`, `~"x"`, `~:\x`) it stays
 * as written. The user name inside it ends at a `:` (`~:x` is the home and
 * `:x`). An empty name becomes `home`; any other (`~user`, `~+`, `~-`, `~1`)
 * is reported as unknown.
 */
function expandTilde(chars: readonly WordChar[], home: string | undefined): { value: string } | { unknown: string } | undefined {
  const found = tildeStarts(chars);
  if (found === 'unknown') return { unknown: 'in a subscripted assignment' };
  if (found.starts.length === 0) return undefined;
  let out = '';
  let from = 0;
  for (const at of found.starts) {
    let end = at + 1;
    while (end < chars.length) {
      const ch = chars[end];
      if (!ch || (!ch.quoted && (ch.c === '/' || (found.assignment && ch.c === ':')))) break;
      end++;
    }
    const tildeWord = chars.slice(at + 1, end);
    if (tildeWord.some((c) => c.quoted)) continue; // a quoted tilde word is not expanded
    const colon = tildeWord.findIndex((c) => c.c === ':');
    const name = colon === -1 ? tildeWord : tildeWord.slice(0, colon);
    if (name.length > 0) return { unknown: `~${name.map((c) => c.c).join('')}` };
    if (home === undefined) return { unknown: '~' };
    out += chars.slice(from, at).map((c) => c.c).join('') + home;
    from = at + 1;
  }
  return { value: out + chars.slice(from).map((c) => c.c).join('') };
}

export interface AnalyzeOptions {
  /** Home directory bash expands `~` to; without it a `~` word is uncertain. */
  readonly home?: string;
}

export class BashAnalyzer {
  readonly #commands: SimpleCommand[] = [];
  readonly #home: string | undefined;
  readonly #files: FileTarget[] = [];
  readonly #uncertain: string[] = [];
  #changesDirectory = false;
  readonly #removals: Removal[] = [];

  private constructor(home: string | undefined) {
    this.#home = home;
  }

  static analyze(command: string, opts: AnalyzeOptions = {}): BashAnalysis {
    const analyzer = new BashAnalyzer(opts.home);
    analyzer.#analyzeSource(command, 0);
    return {
      commands: analyzer.#commands,
      files: analyzer.#files,
      uncertain: [...new Set(analyzer.#uncertain)],
      changesDirectory: analyzer.#changesDirectory,
      removals: analyzer.#removals,
    };
  }

  #analyzeSource(source: string, depth: number): void {
    if (source.includes('\0')) {
      this.#uncertain.push('command contains a NUL byte');
      return;
    }
    if (source.length > MAX_ANALYZED_COMMAND_CHARS) {
      this.#uncertain.push(`command is longer than ${MAX_ANALYZED_COMMAND_CHARS} characters`);
      return;
    }
    let file: File;
    try {
      file = parse(source);
    } catch (err) {
      this.#uncertain.push(`command could not be parsed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const ctx: Ctx = { source, bytes: Buffer.from(source, 'utf8'), depth };
    walk(file, (node) => {
      switch (node.type) {
        case 'CallExpr':
          this.#callExpr(node, ctx);
          break;
        case 'DeclClause':
          this.#declClause(node, ctx);
          break;
        case 'Redirect':
          this.#redirect(node, ctx);
          break;
        case 'Stmt':
          if (node.coprocess) this.#uncertain.push('coprocesses are not analyzed');
          break;
        case 'CoprocClause':
          this.#uncertain.push('coprocesses are not analyzed');
          break;
        default:
          break;
      }
    });
  }

  #text(node: Node, ctx: Ctx): string {
    return ctx.bytes.subarray(node.start, node.end).toString('utf8');
  }

  /**
   * The word as the command receives it. Expansions bash applies to text
   * that looks static are resolved exactly (backslashes, quotes, `~` and
   * `~/` with the known home) or reported as uncertain (brace expansion,
   * `~user`, `~+`, `~-`): the rules must never check a word bash would change.
   */
  #word(word: Word, ctx: Ctx): WordValue {
    const parsed = partsValue(word.parts, false);
    const raw = this.#text(word, ctx);
    const { chars, static: isStatic } = wordChars(word.parts);
    if (hasBraceExpansion(chars)) this.#uncertain.push(`${JSON.stringify(raw)} uses brace expansion, which turns one word into several`);
    if (!isStatic || parsed.value === undefined) return { value: parsed.value, raw, glob: parsed.glob };
    const tilde = expandTilde(chars, this.#home);
    if (tilde === undefined) return { value: parsed.value, raw, glob: parsed.glob };
    if ('unknown' in tilde) {
      this.#uncertain.push(`${JSON.stringify(raw)} uses the tilde expansion ${tilde.unknown}, only known at run time`);
      return { value: undefined, raw, glob: parsed.glob };
    }
    return { value: tilde.value, raw, glob: parsed.glob };
  }

  #declClause(decl: DeclClause, ctx: Ctx): void {
    // `export`, `declare`, `local`, `readonly`, `typeset`, `nameref`: their own
    // words are assignments; nested substitutions are walked generically.
    const name = decl.variant?.value ?? 'declare';
    const raw = this.#text(decl, ctx);
    this.#commands.push({ raw, denyForms: [raw, name], allowForm: undefined, staticPrefixes: [name], dynamic: true, globbed: false, words: [] });
  }

  #redirect(redir: Redirect, ctx: Ctx): void {
    if (REDIR_HDOC.has(redir.op)) {
      const body = redir.hdoc;
      if (body && body.parts.some((p) => p.type !== 'Lit')) {
        this.#uncertain.push('here-document with substitutions');
      }
      return;
    }
    if (REDIR_DUP.has(redir.op) || redir.word === null) return;
    const target = this.#word(redir.word, ctx);
    const path = target.value !== undefined && !target.glob ? target.value : undefined;
    if (path === '/dev/null' || path === '/dev/stdout' || path === '/dev/stderr') return;
    const pattern = target.glob && target.value !== undefined ? { pattern: target.value } : {};
    if (REDIR_OUT.has(redir.op)) this.#files.push({ access: 'write', path, ...pattern });
    else if (REDIR_IN.has(redir.op)) this.#files.push({ access: 'read', path, ...pattern });
    else if (REDIR_INOUT.has(redir.op)) {
      this.#files.push({ access: 'read', path, ...pattern });
      this.#files.push({ access: 'write', path, ...pattern });
    }
    // Here-strings (`<<<`) carry no file.
  }

  #callExpr(call: CallExpr, ctx: Ctx): void {
    const raw = this.#text(call, ctx);
    const words = call.args.map((w) => this.#word(w, ctx));
    if (words.length === 0) return; // pure assignment, e.g. `A=$(rm x)`: nested commands are walked
    this.#addCommand(raw, words, call.assigns.length > 0, ctx);
  }

  #fileOperands(base: string, operands: readonly WordValue[]): void {
    if (SOURCE_DEST.has(base)) {
      this.#sourceDestOperands(base, operands);
      return;
    }
    if (base === 'sed') {
      this.#sedOperands(operands);
      return;
    }
    const reads = FILE_READERS.has(base) || FILE_COPIERS.has(base);
    const writes = FILE_WRITERS.has(base) || FILE_COPIERS.has(base);
    if (!reads && !writes) return;
    let endOfOptions = false;
    for (let k = 0; k < operands.length; k++) {
      const operand = operands[k];
      if (!operand) continue;
      if (operand.raw.startsWith('<(') || operand.raw.startsWith('>(')) continue;
      let value = operand.value;
      if (!endOfOptions && value === '--') {
        // Every later word is an operand, even `-n` or `5`.
        endOfOptions = true;
        continue;
      }
      if (!endOfOptions && value !== undefined && value.startsWith('-')) {
        // `-n 5`: skip a numeric option value; `--file=x`, `-fX`: the value may be a file.
        const next = operands[k + 1]?.value;
        if (next !== undefined && /^\d+$/.test(next)) k++;
        const eq = value.indexOf('=');
        if (eq === -1) continue;
        value = value.slice(eq + 1);
      }
      let access: { read: boolean; write: boolean } = { read: reads, write: writes };
      if (base === 'dd' && value !== undefined) {
        const m = /^(if|of)=(.*)$/s.exec(value);
        if (!m) continue;
        value = m[2];
        access = { read: m[1] === 'if', write: m[1] === 'of' };
      }
      this.#pushFile(operand, value, access);
    }
  }

  /**
   * GNU `sed`: the script (the first operand, unless `-e`/`-f` gave one) and
   * a `-f` script file are read; the other operands are read, and written
   * with `-i`/`--in-place`. Option values are taken as getopt does: `-l 5`,
   * `-f1`, `-ne SCRIPT`, `-i.bak` (an attached in-place suffix), abbreviated
   * long options.
   */
  #sedOperands(operands: readonly WordValue[]): void {
    let inPlace = false;
    const suffixes: string[] = [];
    let scriptByOption = false;
    let endOfOptions = false;
    const positional: { operand: WordValue; value: string | undefined }[] = [];
    const scriptFiles: { operand: WordValue; value: string | undefined }[] = [];
    for (let k = 0; k < operands.length; k++) {
      const operand = operands[k];
      if (!operand) continue;
      if (operand.raw.startsWith('<(') || operand.raw.startsWith('>(')) continue;
      const value = operand.value;
      if (endOfOptions || value === undefined || !value.startsWith('-') || value === '-') {
        positional.push({ operand, value });
        continue;
      }
      if (value === '--') {
        endOfOptions = true;
        continue;
      }
      const next = operands[k + 1];
      if (value.startsWith('--')) {
        const eq = value.indexOf('=');
        const name = longOption(value.slice(2, eq === -1 ? undefined : eq), SED_LONG);
        if (name === 'in-place') {
          inPlace = true;
          if (eq !== -1 && eq + 1 < value.length) suffixes.push(value.slice(eq + 1));
        }
        if (name !== 'expression' && name !== 'file' && name !== 'line-length') continue;
        const given = eq === -1 ? next : { ...operand, value: value.slice(eq + 1) };
        if (eq === -1) k++;
        if (name !== 'line-length') scriptByOption = true;
        if (name === 'file' && given !== undefined) scriptFiles.push({ operand: given, value: given.value });
        continue;
      }
      // A short cluster: `i` takes the rest as its suffix; `e`, `f`, `l` take the rest or the next word.
      for (let c = 1; c < value.length; c++) {
        const letter = value[c] ?? '';
        if (letter === 'i') {
          inPlace = true;
          if (c + 1 < value.length) suffixes.push(value.slice(c + 1));
          break;
        }
        if (letter !== 'e' && letter !== 'f' && letter !== 'l') continue;
        const rest = value.slice(c + 1);
        const given = rest !== '' ? { ...operand, value: rest } : next;
        if (rest === '') k++;
        if (letter !== 'l') scriptByOption = true;
        if (letter === 'f' && given !== undefined) scriptFiles.push({ operand: given, value: given.value });
        break;
      }
    }
    // Without `-e`/`-f`, the first operand is the script: a word such as `$S` could be anything, so it stays a file.
    const first = positional[0];
    const files = !scriptByOption && first !== undefined && first.value !== undefined ? positional.slice(1) : positional;
    for (const f of scriptFiles) this.#pushFile(f.operand, f.value, { read: true, write: false });
    for (const f of files) {
      this.#pushFile(f.operand, f.value, { read: true, write: inPlace });
      for (const suffix of inPlace ? suffixes : []) {
        if (f.value === undefined || f.operand.glob) {
          this.#files.push({ access: 'write', path: undefined });
          continue;
        }
        for (const backup of sedBackups(f.value, suffix)) this.#files.push({ access: 'write', path: backup });
      }
    }
  }

  #pushFile(operand: WordValue, value: string | undefined, access: { readonly read: boolean; readonly write: boolean }): void {
    const path = value !== undefined && !operand.glob ? value : undefined;
    const pattern = operand.glob && value !== undefined ? { pattern: value } : {};
    if (access.read) this.#files.push({ access: 'read', path, ...pattern });
    if (access.write) this.#files.push({ access: 'write', path, ...pattern });
  }

  /**
   * `cp`, `mv`, `ln`, `install`: every operand is read and written, and so is
   * every value any `-t`/`--target-directory` occurrence could take (a union:
   * a later `-t` never hides an earlier one). Options are read as GNU getopt
   * does; where the arity of a long option is not known for sure, the next
   * word is read both as its value and as an operand. A symbolic `ln` with an
   * explicit link name does not write its targets (host row: `ln -s .git
   * gitlink` is allowed), but only when nothing in the parse is ambiguous.
   */
  #sourceDestOperands(base: string, operands: readonly WordValue[]): void {
    const spec = SOURCE_DEST.get(base);
    if (spec === undefined) return;
    const files: { operand: WordValue; value: string | undefined }[] = [];
    const targets: { operand: WordValue; value: string | undefined }[] = [];
    let symbolic = false;
    let ambiguous = false;
    let endOfOptions = false;
    // Backups: `-b`, `--backup[=CONTROL]`, `-S`/`--suffix` (which implies one).
    let backupAsked = false;
    let control: string | undefined;
    let suffix: { value: string | undefined } | undefined;
    let backupUnclear = false;
    const longNames = Object.keys(spec.long);
    for (let k = 0; k < operands.length; k++) {
      const operand = operands[k];
      if (!operand) continue;
      const value = operand.value;
      if (endOfOptions || value === undefined || !value.startsWith('-') || value === '-') {
        // A word only known at run time may be an option: it stays a file (path unknown), so the call cannot be approved by rule.
        if (value === undefined) ambiguous = true;
        files.push({ operand, value });
        continue;
      }
      if (value === '--') {
        endOfOptions = true;
        continue;
      }
      const next = operands[k + 1];
      const nextWord = next === undefined ? undefined : { operand: next, value: next.value };
      if (value.startsWith('--')) {
        const eq = value.indexOf('=');
        const name = value.slice(2, eq === -1 ? undefined : eq);
        const candidates = longNames.filter((n) => n === name || n.startsWith(name));
        const exact = longNames.includes(name) ? name : candidates.length === 1 ? candidates[0] : undefined;
        if (exact === undefined) {
          // Unknown or ambiguous: any reading may hold.
          ambiguous = true;
          if (candidates.includes('backup') || candidates.includes('suffix')) backupUnclear = true;
          if (candidates.includes('target-directory')) {
            if (eq !== -1) targets.push({ operand, value: value.slice(eq + 1) });
            else if (nextWord !== undefined) targets.push(nextWord);
          }
          continue;
        }
        if (exact === 'symbolic' || exact === 'symbolic-link') symbolic = base === 'ln' || symbolic;
        if (exact === 'backup') {
          backupAsked = true;
          control = eq === -1 ? undefined : value.slice(eq + 1);
        }
        if (spec.long[exact] !== 'required') continue;
        const given = eq !== -1 ? { operand, value: value.slice(eq + 1) } : nextWord;
        if (eq === -1) k++;
        if (exact === 'target-directory' && given !== undefined) targets.push(given);
        if (exact === 'suffix') suffix = { value: given?.value };
        continue;
      }
      // A short option cluster: the first option taking a value takes the rest of the word, or the next word.
      for (let c = 1; c < value.length; c++) {
        const letter = value[c] ?? '';
        if (base === 'ln' && letter === 's') symbolic = true;
        if (spec.shortValue.includes(letter)) {
          const rest = value.slice(c + 1);
          const given = rest !== '' ? { operand, value: rest } : nextWord;
          if (rest === '') k++;
          if (letter === 't' && given !== undefined) targets.push(given);
          if (letter === 'S') suffix = { value: given?.value };
          break;
        }
        if (letter === 'b') {
          backupAsked = true;
          control = undefined;
        }
        if (!spec.shortFlags.includes(letter)) ambiguous = true;
      }
    }
    // A symbolic link with an explicit link name (`ln -s TARGET... NAME`): the targets are only named, never written.
    const linkTargets = base === 'ln' && symbolic && !ambiguous && targets.length === 0 && files.length >= 2 ? files.slice(0, -1) : [];
    for (const f of files) this.#pushFile(f.operand, f.value, { read: true, write: !linkTargets.includes(f) });
    for (const t of targets) this.#pushFile(t.operand, t.value, { read: false, write: true });
    const simple = control === 'simple' || control === 'never';
    const off = control === 'none' || control === 'off';
    const backup = {
      // `none`/`off` disable backups, even with a suffix (GNU makes none).
      on: backupUnclear || (!off && (suffix !== undefined || backupAsked)),
      // Numbered or `existing` control: `.~N~`, a name that depends on what exists. Without `-S`, SIMPLE_BACKUP_SUFFIX
      // picks the suffix. With `-S` and no control, the simple `<dest><suffix>` (host row rCpSuffix allows `cp --suffix=.git`).
      unknown: backupUnclear || suffix?.value === undefined || (control !== undefined && !simple && !off),
      suffix: suffix?.value,
    };
    // What the command creates: the destination, and `<dir>/<basename(source)>` when it is a directory.
    const created: FileTarget[] = [];
    const inside = (dir: string | undefined, source: { operand: WordValue; value: string | undefined }, whenDirectory?: string): FileTarget => {
      const name = source.value === undefined || source.operand.glob ? undefined : (source.value.replace(/\/+$/, '').split('/').pop() ?? '');
      const path = dir === undefined || name === undefined || name === '' ? undefined : `${dir.replace(/\/+$/, '')}/${name}`;
      return { access: 'write', path, ...(whenDirectory === undefined ? {} : { whenDirectory }) };
    };
    if (targets.length > 0) {
      for (const t of targets) for (const f of files) created.push(inside(t.operand.glob ? undefined : t.value, f));
    } else if (files.length >= 2) {
      const dest = files[files.length - 1];
      const sources = files.slice(0, -1);
      if (dest !== undefined) {
        const destPath = dest.operand.glob ? undefined : dest.value;
        created.push({ access: 'write', path: destPath });
        // A trailing slash or several sources: certainly a directory. Otherwise only if it is one when the command runs.
        const certain = sources.length > 1 || (destPath?.endsWith('/') ?? false);
        for (const f of sources) created.push(inside(destPath, f, certain || destPath === undefined ? undefined : destPath));
      }
    } else if (base === 'ln' && files[0] !== undefined) {
      // `ln -s /x/y` makes `./y`.
      created.push(inside('.', files[0]));
    }
    for (const c of created) {
      if (c !== created[0] || targets.length > 0 || files.length < 2) this.#files.push(c);
      if (!backup.on) continue;
      // `.~N~` (numbered), the default suffix (`SIMPLE_BACKUP_SUFFIX`) or an unknown control: the name cannot be known.
      if (backup.unknown || c.path === undefined) this.#files.push({ access: 'write', path: undefined });
      if (c.path !== undefined) this.#files.push({ ...c, path: c.path + (backup.suffix ?? '~') });
    }
  }


  #addCommand(raw: string, words: readonly WordValue[], hasAssigns: boolean, ctx: Ctx): void {
    const denyForms = new Set<string>([raw]);
    const staticPrefixes = new Set<string>();
    const dynamic = words.some((w) => w.value === undefined);
    const globbed = words.some((w) => w.glob);
    const text = (ws: readonly WordValue[]): string => ws.map((w) => w.value ?? w.raw).join(' ');
    // Words before the first one bash may change at run time (a substitution or a glob).
    const prefix = (ws: readonly WordValue[]): string => {
      const i = ws.findIndex((w) => w.value === undefined || w.glob);
      return (i === -1 ? ws : ws.slice(0, i)).map((w) => w.value ?? '').join(' ');
    };
    const addForm = (ws: readonly WordValue[]): void => {
      denyForms.add(text(ws));
      // `cat -- x` is matched as `cat x` too (deny/ask only: the marker does not change what is read).
      const marker = ws.findIndex((w, i) => i > 0 && w.value === '--');
      if (marker !== -1) denyForms.add(text([...ws.slice(0, marker), ...ws.slice(marker + 1)]));
      staticPrefixes.add(prefix(ws));
      const head = ws[0];
      if (head?.value !== undefined) {
        const base = basename(head.value);
        if (base !== head.value) {
          // `/usr/bin/git push` is matched as `git push` too.
          const renamed = [{ ...head, value: base, raw: base }, ...ws.slice(1)];
          denyForms.add(text(renamed));
          staticPrefixes.add(prefix(renamed));
        }
      }
    };
    addForm(words);

    // Strip wrappers one level at a time; every level is a deny/ask candidate.
    let current = words;
    let allowStripped: readonly WordValue[] | undefined = hasAssigns ? undefined : words;
    let allowChainIntact = !hasAssigns;
    for (let level = 0; ; level++) {
      if (level >= MAX_WRAPPER_LEVELS) {
        this.#uncertain.push(`more than ${MAX_WRAPPER_LEVELS} nested command wrappers`);
        allowStripped = undefined;
        break;
      }
      const head = current[0];
      if (!head) break;
      if (head.value === undefined || head.glob) {
        this.#uncertain.push(`command name ${JSON.stringify(head.raw)} is only known at run time`);
        allowStripped = undefined;
        break;
      }
      const base = basename(head.value);
      const operands = current.slice(1);
      if (base === 'cd' || base === 'pushd' || base === 'popd') this.#changesDirectory = true;
      if (CODE_EVALUATORS.has(base)) this.#uncertain.push(`\`${base}\` runs code that is only known at run time`);
      if (base === 'shopt') this.#uncertain.push('`shopt` changes how bash expands later words (extglob, globstar, dotglob ...)');
      if (NAME_REBINDERS.has(base) && operands.length > 0) this.#uncertain.push(`\`${base}\` rebinds command names, so later commands cannot be matched by name`);
      this.#fileOperands(base, operands);
      if (base === 'rm' || base === 'rmdir') {
        // An unquoted run-time word may split into flags such as `-rf`.
        const recursive = operands.some((o) => (o.value === undefined ? !/^["']/.test(o.raw) : /^-[a-zA-Z]*[rR]/.test(o.value) || o.value === '--recursive'));
        this.#removals.push({ recursive, targets: operands.filter((o) => o.value === undefined || !o.value.startsWith('-')) });
      }
      if (SHELLS.has(base)) this.#shell(current, ctx);
      if (base === 'find') this.#findExec(current, ctx);
      if (base === 'env' && this.#envSplitString(current, ctx)) {
        allowStripped = undefined;
        break;
      }

      const unwrapped = unwrap(base, current);
      if (unwrapped === undefined) break;
      if (unwrapped.inner.length === 0) break;
      current = unwrapped.inner;
      addForm(current);
      if (allowChainIntact && unwrapped.documented) allowStripped = current;
      else allowChainIntact = false;
      // `timeout 1 A=1 rm x`: strip assignment-like words too (strict: the wrapper would run `A=1`).
      let skip = 0;
      while (skip < current.length - 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(current[skip]?.value ?? '')) skip++;
      if (skip > 0) {
        current = current.slice(skip);
        addForm(current);
        allowChainIntact = false;
        allowStripped = undefined;
      }
    }

    const allowForm = allowStripped !== undefined && !dynamic ? text(allowStripped) : undefined;
    this.#commands.push({ raw, denyForms: [...denyForms], allowForm, staticPrefixes: [...staticPrefixes], dynamic, globbed, words });
  }

  /**
   * `env -S 'cmd args'` / `env --split-string=...`: the string is split into a
   * command line. Returns true when the invocation had one (it was analyzed).
   */
  #envSplitString(words: readonly WordValue[], ctx: Ctx): boolean {
    for (let i = 1; i < words.length; i++) {
      const w = words[i];
      if (!w) break;
      const v = w.value;
      if (v === undefined) return false;
      let script: WordValue | undefined;
      let restFrom = i + 1;
      if (v === '-S' || v === '--split-string') {
        script = words[i + 1];
        restFrom = i + 2;
      } else if (v.startsWith('--split-string=')) {
        script = { value: v.slice('--split-string='.length), raw: v, glob: false };
      } else if (/^-[a-zA-Z]*S./s.test(v) && !v.startsWith('--')) {
        script = { value: v.slice(v.indexOf('S') + 1), raw: v, glob: false };
      } else if (v.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(v)) {
        continue;
      } else {
        return false;
      }
      if (!script || script.value === undefined) {
        this.#uncertain.push('`env -S` string is only known at run time');
        return true;
      }
      if (ctx.depth >= MAX_SHELL_NESTING) {
        this.#uncertain.push('`env -S` nested too deeply');
        return true;
      }
      const rest = words.slice(restFrom).map((r) => r.raw);
      this.#analyzeSource([script.value, ...rest].join(' '), ctx.depth + 1);
      return true;
    }
    return false;
  }

  #shell(words: readonly WordValue[], ctx: Ctx): void {
    // Find `-c <script>` (flags may be combined, e.g. `-ec`, `-lc`).
    let script: WordValue | undefined;
    let sawScript = false;
    for (let i = 1; i < words.length; i++) {
      const w = words[i];
      if (!w) break;
      if (w.value === undefined) {
        this.#uncertain.push('shell invocation with arguments only known at run time');
        return;
      }
      if (w.value === '--') {
        sawScript = i + 1 < words.length;
        break;
      }
      if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(w.value)) {
        script = words[i + 1];
        if (!script) {
          this.#uncertain.push('shell `-c` without a script');
          return;
        }
        break;
      }
      if (w.value === '-s' || w.value === '-i') break;
      if (w.value === '-O' || w.value === '+O') {
        this.#uncertain.push('a shell started with `-O` changes how bash expands words');
        return;
      }
      if (w.value.startsWith('-') || w.value.startsWith('+')) {
        // Options that take an operand: skip it so it is not taken for a script file.
        if (SHELL_OPTIONS_WITH_OPERAND.has(w.value)) i++;
        continue;
      }
      sawScript = true; // `bash script.sh`: runs a file, like native Bash
      break;
    }
    if (script) {
      if (script.value === undefined) {
        this.#uncertain.push('shell `-c` script is only known at run time');
        return;
      }
      if (ctx.depth >= MAX_SHELL_NESTING) {
        this.#uncertain.push('shell `-c` nested too deeply');
        return;
      }
      this.#analyzeSource(script.value, ctx.depth + 1);
      return;
    }
    if (!sawScript) {
      // The shell reads its commands from stdin (a pipe, a here-document): unknown code.
      this.#uncertain.push('a shell reads commands from stdin');
    }
  }

  #findExec(words: readonly WordValue[], ctx: Ctx): void {
    for (let i = 1; i < words.length; i++) {
      const v = words[i]?.value;
      if (v === '-exec' || v === '-execdir' || v === '-ok' || v === '-okdir') {
        const inner: WordValue[] = [];
        let j = i + 1;
        for (; j < words.length; j++) {
          const w = words[j];
          if (!w) break;
          if (w.value === ';' || w.value === '+') break;
          inner.push(w);
        }
        if (inner.length > 0) this.#addCommand(inner.map((w) => w.raw).join(' '), inner, false, ctx);
        i = j;
      }
    }
  }
}

function basename(name: string): string {
  const i = name.lastIndexOf('/');
  return i === -1 ? name : name.slice(i + 1);
}

/** Wrappers Claude Code itself strips before matching allow rules. */
const DOCUMENTED_WRAPPERS = new Set(['timeout', 'time', 'nice', 'nohup', 'stdbuf', 'command', 'builtin', 'noglob']);

/** Options taking a value, per wrapper. */
const OPTIONS_WITH_VALUE: Record<string, ReadonlySet<string>> = {
  timeout: new Set(['-s', '--signal', '-k', '--kill-after']),
  nice: new Set(['-n', '--adjustment']),
  stdbuf: new Set(['-i', '-o', '-e', '--input', '--output', '--error']),
  sudo: new Set(['-u', '--user', '-g', '--group', '-C', '--close-from', '-D', '--chdir', '-h', '--host', '-p', '--prompt', '-r', '--role', '-t', '--type', '-T', '--command-timeout', '-U', '--other-user']),
  env: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']),
  exec: new Set(['-a']),
  xargs: new Set(['-I', '-L', '-n', '-P', '-s', '-d', '-E', '-a', '--max-lines', '--max-args', '--max-procs', '--max-chars', '--delimiter', '--eof', '--arg-file', '--replace']),
  time: new Set(['-f', '--format', '-o', '--output']),
};

/**
 * Removes one wrapper level. Returns undefined when `name` is not a wrapper.
 * `documented` is true when Claude Code strips this wrapper for allow rules.
 */
function unwrap(name: string, words: readonly WordValue[]): { inner: readonly WordValue[]; documented: boolean } | undefined {
  const isWrapper = DOCUMENTED_WRAPPERS.has(name) || name === 'xargs' || name === 'sudo' || name === 'env' || name === 'exec' || name === 'doas';
  if (!isWrapper) return undefined;
  const withValue = OPTIONS_WITH_VALUE[name] ?? new Set<string>();
  let i = 1;
  let sawFlag = false;
  for (; i < words.length; i++) {
    const v = words[i]?.value;
    if (v === undefined) return { inner: words.slice(i), documented: false };
    if (v === '--') {
      i++;
      break;
    }
    if (name === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(v)) {
      sawFlag = true;
      continue;
    }
    if (name === 'nice' && /^-\d+$/.test(v)) {
      sawFlag = true;
      continue;
    }
    if (v.startsWith('-') && v.length > 1) {
      sawFlag = true;
      if (name === 'command' && (v === '-v' || v === '-V')) {
        // `command -v x` only looks `x` up; still offered to deny rules (strictness).
      }
      const flag = v.includes('=') ? v.slice(0, v.indexOf('=')) : v;
      if (withValue.has(flag) && !v.includes('=')) i++;
      continue;
    }
    break;
  }
  // `timeout DURATION cmd`: skip the duration.
  if (name === 'timeout' && i < words.length) i++;
  const inner = words.slice(i);
  const documented = DOCUMENTED_WRAPPERS.has(name) ? !(name === 'command' && sawFlag) : name === 'xargs' && !sawFlag;
  return { inner, documented };
}
