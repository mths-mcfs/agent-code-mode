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
const FILE_WRITERS = new Set(['tee', 'touch', 'truncate', 'rm', 'rmdir', 'unlink', 'shred', 'mkdir', 'chmod', 'chown', 'chgrp', 'ln']);

/** Commands that read some operands and write others: every operand is both. */
const FILE_COPIERS = new Set(['cp', 'mv', 'rsync', 'install', 'scp', 'dd']);

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
    const ctx = { source, depth };
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

  #text(node: Node, ctx: { source: string }): string {
    return ctx.source.slice(node.start, node.end);
  }

  #word(word: Word, ctx: { source: string }): WordValue {
    const { value, glob } = partsValue(word.parts, false);
    return { value, raw: this.#text(word, ctx), glob };
  }

  #declClause(decl: DeclClause, ctx: { source: string; depth: number }): void {
    // `export`, `declare`, `local`, `readonly`, `typeset`, `nameref`: their own
    // words are assignments; nested substitutions are walked generically.
    const name = decl.variant?.value ?? 'declare';
    const raw = this.#text(decl, ctx);
    this.#commands.push({ raw, denyForms: [raw, name], allowForm: undefined, staticPrefixes: [name], dynamic: true });
  }

  #redirect(redir: Redirect, ctx: { source: string; depth: number }): void {
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
    if (REDIR_OUT.has(redir.op)) this.#files.push({ access: 'write', path });
    else if (REDIR_IN.has(redir.op)) this.#files.push({ access: 'read', path });
    else if (REDIR_INOUT.has(redir.op)) {
      this.#files.push({ access: 'read', path });
      this.#files.push({ access: 'write', path });
    }
    // Here-strings (`<<<`) carry no file.
  }

  #callExpr(call: CallExpr, ctx: { source: string; depth: number }): void {
    const raw = this.#text(call, ctx);
    const words = call.args.map((w) => this.#word(w, ctx));
    if (words.length === 0) return; // pure assignment, e.g. `A=$(rm x)`: nested commands are walked
    this.#addCommand(raw, words, call.assigns.length > 0, ctx);
  }

  #fileOperands(base: string, operands: readonly WordValue[]): void {
    const reads = FILE_READERS.has(base) || FILE_COPIERS.has(base);
    let writes = FILE_WRITERS.has(base) || FILE_COPIERS.has(base);
    if (base === 'sed' && operands.some((o) => o.value !== undefined && (o.value === '-i' || o.value.startsWith('--in-place') || /^-[a-zA-Z]*i/.test(o.value)))) writes = true;
    if (!reads && !writes) return;
    for (let k = 0; k < operands.length; k++) {
      const operand = operands[k];
      if (!operand) continue;
      if (operand.raw.startsWith('<(') || operand.raw.startsWith('>(')) continue;
      let value = operand.value;
      if (value !== undefined && value.startsWith('-')) {
        // `-n 5`: skip a numeric option value; `--file=x`, `-fX`: the value may be a file.
        const next = operands[k + 1]?.value;
        if (next !== undefined && /^\d+$/.test(next)) k++;
        const eq = value.indexOf('=');
        if (eq === -1) continue;
        value = value.slice(eq + 1);
      }
      if (base === 'dd' && value !== undefined) {
        const m = /^(if|of)=(.*)$/s.exec(value);
        if (!m) continue;
        value = m[2];
      }
      const path = value !== undefined && !operand.glob ? value : undefined;
      if (reads) this.#files.push({ access: 'read', path });
      if (writes) this.#files.push({ access: 'write', path });
    }
  }

  #addCommand(raw: string, words: readonly WordValue[], hasAssigns: boolean, ctx: { source: string; depth: number }): void {
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
    this.#commands.push({ raw, denyForms: [...denyForms], allowForm, staticPrefixes: [...staticPrefixes], dynamic });
  }

  /**
   * `env -S 'cmd args'` / `env --split-string=...`: the string is split into a
   * command line. Returns true when the invocation had one (it was analyzed).
   */
  #envSplitString(words: readonly WordValue[], ctx: { source: string; depth: number }): boolean {
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

  #shell(words: readonly WordValue[], ctx: { source: string; depth: number }): void {
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

  #findExec(words: readonly WordValue[], ctx: { source: string; depth: number }): void {
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
