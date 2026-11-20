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
  /** An exec wrapper or an effectful `find` action: only an exact allow rule approves it. */
  readonly exactOnly: boolean;
}

/** A file a command reads or writes by name (redirection or `tee`). */
export interface FileTarget {
  readonly access: 'read' | 'write';
  /** The path as written, or undefined when it is only known at run time. */
  readonly path: string | undefined;
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
  /** A leading `~` that is quoted or escaped (a file name), or a prefix other than `~`, `~/` (`~user`, `~+`) that expands to an unknown directory. */
  readonly tilde?: 'literal' | 'unknown';
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

type Access = 'read' | 'write' | 'both';

/**
 * How a command touches the files it names. `operands` is the access of positional operands: `copy` writes
 * the last one and reads the others, `pair` reads the first and writes the second (`uniq in out`). `files`
 * are options whose value is a file; `values` are options whose value is not one. Any other option with a
 * value attached (`-Xvalue`) may name a file: unknown.
 */
interface FileSpec {
  readonly operands: Access | 'copy' | 'pair';
  readonly files?: Readonly<Record<string, Access>>;
  readonly values?: readonly string[];
}

const BOTH: FileSpec = { operands: 'both' };
const FROM_FILE: FileSpec = { operands: 'read', files: { '-f': 'read', '--file': 'read' } };
const COPY: FileSpec = { operands: 'copy', files: { '-t': 'write', '--target-directory': 'write' } };

/**
 * Commands whose operands may be files. A non-option operand that is not a file (a `sed` script, a `grep`
 * pattern) is checked as a path too: matching a pattern text against path rules is harmless, missing a file is not.
 */
const FILE_SPECS: ReadonlyMap<string, FileSpec> = new Map<string, FileSpec>([
  ...['cat', 'head', 'tail', 'less', 'more', 'most', 'nl', 'tac', 'rev', 'strings', 'od', 'hexdump', 'base32', 'zcat', 'zless', 'bzcat', 'xzcat', 'wc', 'diff', 'cmp', 'comm', 'join', 'paste', 'column', 'fold', 'fmt', 'pr', 'expand', 'unexpand', 'file', 'md5sum', 'sha1sum', 'sha256sum', 'sha512sum', 'cksum', 'b2sum', 'wget'].map((c) => [c, { operands: 'read' }] as const),
  ...['grep', 'egrep', 'fgrep', 'zgrep', 'rg', 'ag', 'ack', 'sed'].map((c) => [c, FROM_FILE] as const),
  ...['awk', 'gawk', 'mawk', 'nawk'].map((c) => [c, { ...FROM_FILE, values: ['-F'] }] as const),
  ...['tee', 'touch', 'truncate', 'rm', 'rmdir', 'unlink', 'shred', 'mkdir', 'chmod', 'chown', 'chgrp', 'ln'].map((c) => [c, { operands: 'write' }] as const),
  ...['dos2unix', 'zip', 'gzip', 'gunzip', 'bzip2', 'xz', 'openssl', 'yq', 'vi', 'vim', 'nano', 'view', 'emacs', 'mv'].map((c) => [c, BOTH] as const),
  ...['cp', 'install'].map((c) => [c, COPY] as const),
  ...['rsync', 'scp'].map((c) => [c, { operands: 'copy' }] as const),
  ['cut', { operands: 'read', values: ['-d'] }],
  ['sort', { operands: 'read', files: { '-o': 'write', '--output': 'write', '-T': 'write', '--temporary-directory': 'write' }, values: ['-t'] }],
  ['uniq', { operands: 'pair', values: ['-f', '-s', '-w'] }],
  ['xxd', { operands: 'pair', values: ['-c', '-g', '-l', '-s'] }],
  ['iconv', { operands: 'read', files: { '-o': 'write', '--output': 'write' } }],
  ['base64', { operands: 'read', files: { '-i': 'read', '-o': 'write' } }],
  ['jq', { operands: 'read', files: { '-f': 'read', '--from-file': 'read' } }],
  ['xmllint', { operands: 'read', files: { '-o': 'write', '--output': 'write' } }],
  ['gpg', { operands: 'both', files: { '-o': 'write', '--output': 'write' } }],
  ['tar', { operands: 'both', files: { '-f': 'both', '--file': 'both', '-C': 'both', '--directory': 'both' } }],
  ['unzip', { operands: 'both', files: { '-d': 'write' } }],
  ['curl', { operands: 'read', files: { '-o': 'write', '--output': 'write', '-D': 'write', '--dump-header': 'write', '-c': 'write', '--cookie-jar': 'write', '-K': 'read', '--config': 'read', '-T': 'read', '--upload-file': 'read', '-b': 'read', '--cookie': 'read' } }],
]);

/** `find` actions that run, write or delete, and `-files0-from`, which reads its paths from a file: only an exact allow rule approves them. */
const FIND_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-rm', '-fprint', '-fprint0', '-fprintf', '-fls', '-files0-from']);

/** Exec wrappers that run their arguments as a command (https://code.claude.com/docs/en/permissions, "Exec wrappers"): only an exact allow rule approves them. */
const EXEC_WRAPPERS = new Set(['watch', 'setsid', 'ionice', 'flock']);

/** Wrapper levels stripped before the command is reported as uncertain. */
const MAX_WRAPPER_LEVELS = 64;

/** Builtins that rebind a command name: the commands after them cannot be matched by name. */
const NAME_REBINDERS = new Set(['alias', 'hash', 'enable']);

// Redirect operators (sh-syntax RedirOperator values).
const REDIR_OUT = new Set([63, 64, 68, 69, 70, 74, 75, 76, 77]); // > >> >& >| >>| &> &>| &>> &>>|
const REDIR_IN = new Set([65, 67]); // < <&
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

/** Whether raw unquoted text has one of `chars` that no backslash escapes (escape parity counted). */
function hasUnescaped(lit: string, chars: string): boolean {
  for (let i = 0; i < lit.length; i++) {
    const ch = lit[i] ?? '';
    if (ch === '\\') i++;
    else if (chars.includes(ch)) return true;
  }
  return false;
}

/** A file path an operand names, or undefined when the shell may expand it into something else. */
function pathOf(o: Operand): string | undefined {
  if (o.value === undefined || o.glob || o.tilde === 'unknown') return undefined;
  return o.tilde === 'literal' ? `./${o.value}` : o.value;
}

/** The path in an option's attached value (`-ofile`, `--file=x`); a leading `~` there may or may not expand. */
function attachedPath(value: string, o: Operand): string | undefined {
  return o.glob || value.startsWith('~') ? undefined : value;
}

type Ctx = { readonly bytes: Buffer; readonly depth: number };

function partsValue(parts: readonly WordPart[], quoted: boolean): { value: string | undefined; glob: boolean } {
  let value: string | undefined = '';
  let glob = false;
  for (const part of parts) {
    let piece: string | undefined;
    switch (part.type) {
      case 'Lit':
        if (!quoted && hasUnescaped(part.value, '*?[')) glob = true;
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

export class BashAnalyzer {
  readonly #commands: SimpleCommand[] = [];
  readonly #files: FileTarget[] = [];
  readonly #uncertain: string[] = [];
  #changesDirectory = false;
  readonly #removals: Removal[] = [];

  static analyze(command: string): BashAnalysis {
    const analyzer = new BashAnalyzer();
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
    // Node offsets are UTF-8 byte offsets: slice the encoded source, never the JavaScript string.
    const ctx: Ctx = { bytes: Buffer.from(source, 'utf8'), depth };
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

  #word(word: Word, ctx: Ctx): WordValue {
    const { value, glob } = partsValue(word.parts, false);
    const raw = this.#text(word, ctx);
    // Brace expansion (`{a,b}`, `{1..3}`) can turn one word into several: only known at run time.
    const brace = word.parts.some((p) => p.type === 'Lit' && hasUnescaped(p.value, '{')) && /\{[\s\S]*(,|\.\.)[\s\S]*\}/.test(raw);
    if (brace) return { value: undefined, raw, glob };
    // Bash expands a leading `~` only when it is unquoted: `~` alone or `~/` is home; other prefixes are unknown here.
    let tilde: Operand['tilde'];
    if (value?.startsWith('~')) {
      const first = word.parts[0];
      const lit = first?.type === 'Lit' ? first.value : '';
      if (!lit.startsWith('~')) tilde = 'literal';
      else if (!(lit === value ? /^~(\/|$)/.test(lit) : lit.startsWith('~/'))) tilde = 'unknown';
    }
    return { value, raw, glob, ...(tilde === undefined ? {} : { tilde }) };
  }

  #declClause(decl: DeclClause, ctx: Ctx): void {
    // `export`, `declare`, `local`, `readonly`, `typeset`, `nameref`: their own
    // words are assignments; nested substitutions are walked generically.
    const name = decl.variant?.value ?? 'declare';
    const raw = this.#text(decl, ctx);
    this.#commands.push({ raw, denyForms: [raw, name], allowForm: undefined, staticPrefixes: [name], dynamic: true, exactOnly: false });
  }

  #redirect(redir: Redirect, ctx: Ctx): void {
    if (REDIR_HDOC.has(redir.op)) {
      const body = redir.hdoc;
      if (body && body.parts.some((p) => p.type !== 'Lit')) {
        this.#uncertain.push('here-document with substitutions');
      }
      return;
    }
    if (redir.word === null) return;
    const target = this.#word(redir.word, ctx);
    // `>&2`, `<&0`, `>&-` duplicate or close descriptors; `>& file` opens a file.
    if (REDIR_DUP.has(redir.op) && target.value !== undefined && /^(\d+-?|-)$/.test(target.value)) return;
    const path = pathOf(target);
    if (path === '/dev/null' || path === '/dev/stdout' || path === '/dev/stderr') return;
    if (REDIR_OUT.has(redir.op)) this.#files.push({ access: 'write', path });
    else if (REDIR_IN.has(redir.op)) this.#files.push({ access: 'read', path });
    else if (REDIR_INOUT.has(redir.op)) {
      this.#files.push({ access: 'read', path });
      this.#files.push({ access: 'write', path });
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
    const push = (access: Access, path: string | undefined): void => {
      if (access !== 'write') this.#files.push({ access: 'read', path });
      if (access !== 'read') this.#files.push({ access: 'write', path });
    };
    if (base === 'dd') {
      // `if=` is read and `of=` written; other operands are not files.
      for (const o of operands) {
        const m = o.value === undefined ? undefined : /^(if|of)=(.*)$/s.exec(o.value);
        if (o.value === undefined) push('both', undefined);
        else if (m?.[2] !== undefined) push(m[1] === 'if' ? 'read' : 'write', attachedPath(m[2], o));
      }
      return;
    }
    let spec = FILE_SPECS.get(base);
    if (spec === undefined) return;
    if (base === 'sed' && operands.some((o) => o.value !== undefined && /^(-[a-zA-Z]*i|--in-place)/.test(o.value))) spec = BOTH;
    if (base === 'rsync' && operands.some((o) => o.value === undefined || o.value.startsWith('--remove-source'))) spec = BOTH;
    // `wget url`, `curl -O url`: the file name comes from the server.
    if (base === 'wget' || (base === 'curl' && operands.some((o) => o.value === undefined || /^-[a-zA-Z]*[OJ]|^--remote-name/.test(o.value)))) {
      this.#files.push({ access: 'write', path: undefined });
    }
    const { operands: mode, files = {}, values = [] } = spec;
    const unknownAccess: Access = mode === 'read' ? 'read' : 'both';
    const positional: (string | undefined)[] = [];
    let options = true;
    for (let i = 0; i < operands.length; i++) {
      const o = operands[i];
      if (!o || o.raw.startsWith('<(') || o.raw.startsWith('>(')) continue;
      const v = o.value;
      if (v === '-') continue;
      if (options && v === '--') {
        options = false;
        continue;
      }
      if (!options || v === undefined || !v.startsWith('-')) {
        positional.push(pathOf(o));
        continue;
      }
      if (v.startsWith('--')) {
        const eq = v.indexOf('=');
        const access = files[eq === -1 ? v : v.slice(0, eq)];
        if (eq !== -1) push(access ?? unknownAccess, attachedPath(v.slice(eq + 1), o));
        else if (access !== undefined) {
          const next = operands[++i];
          if (next) push(access, pathOf(next));
        }
        continue;
      }
      // A short cluster: flags up to the first option that takes a value, attached or as the next word.
      for (let k = 1; k < v.length; k++) {
        const flag = `-${v[k] ?? ''}`;
        const access = files[flag];
        const rest = v.slice(k + 1);
        if (access !== undefined || values.includes(flag)) {
          const next = rest === '' ? operands[++i] : undefined;
          if (access !== undefined) push(access, rest !== '' ? attachedPath(rest, o) : next ? pathOf(next) : undefined);
          break;
        }
        if (!/[A-Za-z]/.test(v[k] ?? '')) {
          // An option outside the tables with a value attached: a count (`-n5`) is no file, anything else may be.
          if (!/^[0-9][0-9,.:+-]*$/.test(v.slice(k))) push(unknownAccess, undefined);
          break;
        }
      }
    }
    positional.forEach((p, n) => push(mode === 'copy' ? (n === positional.length - 1 ? 'write' : 'read') : mode === 'pair' ? (n === 1 ? 'write' : 'read') : mode, p));
  }

  #addCommand(raw: string, words: readonly WordValue[], hasAssigns: boolean, ctx: Ctx): void {
    const denyForms = new Set<string>([raw]);
    const staticPrefixes = new Set<string>();
    const dynamic = words.some((w) => w.value === undefined);
    const text = (ws: readonly WordValue[]): string => ws.map((w) => w.value ?? w.raw).join(' ');
    const prefix = (ws: readonly WordValue[]): string => {
      const i = ws.findIndex((w) => w.value === undefined);
      return (i === -1 ? ws : ws.slice(0, i)).map((w) => w.value ?? '').join(' ');
    };
    const addForm = (ws: readonly WordValue[]): void => {
      denyForms.add(text(ws));
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
    let exactOnly = false;
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
      if (base === 'cd' || base === 'pushd' || base === 'popd' || changesChildDir(base, operands)) this.#changesDirectory = true;
      if (base === 'find' && operands.some((o) => o.value === undefined || FIND_ACTIONS.has(o.value))) exactOnly = true;
      if (CODE_EVALUATORS.has(base)) this.#uncertain.push(`\`${base}\` runs code that is only known at run time`);
      if (NAME_REBINDERS.has(base) && operands.length > 0) this.#uncertain.push(`\`${base}\` rebinds command names, so later commands cannot be matched by name`);
      this.#fileOperands(base, operands);
      if (base === 'rm' || base === 'rmdir') {
        // An unquoted run-time word may split into flags such as `-rf`.
        const recursive = operands.some((o) => (o.value === undefined ? !/^["']/.test(o.raw) : /^-[a-zA-Z]*[rR]/.test(o.value) || o.value === '--recursive'));
        const targets = operands.filter((o) => o.value === undefined || !o.value.startsWith('-'));
        this.#removals.push({ recursive, targets: targets.map((o) => (o.tilde === undefined ? o : { ...o, value: pathOf(o) })) });
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

    // An exec wrapper left after stripping the documented ones runs another command.
    const allowHead = allowStripped?.[0]?.value;
    if (allowStripped !== undefined && allowHead !== undefined && (EXEC_WRAPPERS.has(basename(allowHead)) || unwrap(basename(allowHead), allowStripped) !== undefined)) exactOnly = true;
    // Allow rules see the words as written, so word boundaries survive (`a 'b c'` is not `a b c`).
    const allowForm = allowStripped !== undefined && !dynamic ? allowStripped.map((w) => w.raw).join(' ') : undefined;
    this.#commands.push({ raw, denyForms: [...denyForms], allowForm, staticPrefixes: [...staticPrefixes], dynamic, exactOnly });
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

/**
 * Whether the child of `env`, `sudo` or `find` may run in another directory, or that cannot be told, from the
 * wrapper's own options (`env -iCdir`, `env -S`, `sudo -D dir`, `sudo -i`, `find -execdir`).
 */
function changesChildDir(base: string, operands: readonly WordValue[]): boolean {
  if (base === 'find') return operands.some((o) => o.value === undefined || o.value === '-execdir' || o.value === '-okdir');
  if (base !== 'env' && base !== 'sudo') return false;
  const short = base === 'env' ? 'CS' : 'Di';
  const withValue = OPTIONS_WITH_VALUE[base] ?? new Set<string>();
  for (let i = 0; i < operands.length; i++) {
    const v = operands[i]?.value;
    if (v === undefined) return true;
    if (base === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(v)) continue;
    if (v === '--' || v === '-' || !v.startsWith('-')) return false;
    // Long options may be abbreviated (`--ch`): any of them may change the directory.
    if (v.startsWith('--')) return true;
    for (let k = 1; k < v.length; k++) {
      if (short.includes(v[k] ?? '')) return true;
      if (withValue.has(`-${v[k] ?? ''}`)) {
        if (k === v.length - 1) i++;
        break;
      }
    }
  }
  return false;
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
