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
  /** Words before the first word whose value is only known at run time. */
  readonly staticPrefix: string;
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
}

/** Commands longer than this are not analyzed (treated as uncertain). */
export const MAX_ANALYZED_COMMAND_CHARS = 100_000;

/** How deep `bash -c '...'` strings are followed. */
const MAX_SHELL_NESTING = 4;

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'busybox']);

/** Builtins whose arguments become shell code: always uncertain. */
const CODE_EVALUATORS = new Set(['eval', 'source', '.', 'trap', 'fc']);

/** Commands whose operands are files they read, for Read rules. */
const FILE_READERS = new Set(['cat', 'head', 'tail', 'less', 'more', 'nl', 'tac', 'strings', 'xxd', 'od', 'base64']);

/** Options of those readers that take a separate value (`head -n 5 file`). */
const READER_OPTIONS_WITH_VALUE = new Set(['-n', '-c', '--lines', '--bytes', '-s', '-w', '-b', '-t', '-j', '-N']);

// Redirect operators (sh-syntax RedirOperator values).
const REDIR_OUT = new Set([63, 64, 69, 70, 74, 75, 76, 77]); // > >> >| >>| &> &>| &>> &>>|
const REDIR_IN = new Set([65]); // <
const REDIR_INOUT = new Set([66]); // <>
const REDIR_HDOC = new Set([71, 72]); // << <<-
const REDIR_DUP = new Set([67, 68]); // <& >&

interface WordValue {
  /** Shell value when fully static, else undefined. */
  readonly value: string | undefined;
  /** Source text. */
  readonly raw: string;
  /** True when an unquoted glob character appears (the shell may expand it). */
  readonly glob: boolean;
}

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

  static analyze(command: string): BashAnalysis {
    const analyzer = new BashAnalyzer();
    analyzer.#analyzeSource(command, 0);
    return {
      commands: analyzer.#commands,
      files: analyzer.#files,
      uncertain: [...new Set(analyzer.#uncertain)],
      changesDirectory: analyzer.#changesDirectory,
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
    this.#commands.push({ raw, denyForms: [raw, name], allowForm: undefined, staticPrefix: name, dynamic: true });
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

  #addCommand(raw: string, words: readonly WordValue[], hasAssigns: boolean, ctx: { source: string; depth: number }): void {
    const denyForms = new Set<string>([raw]);
    const dynamic = words.some((w) => w.value === undefined);
    const firstDynamic = words.findIndex((w) => w.value === undefined);
    const staticWords = (firstDynamic === -1 ? words : words.slice(0, firstDynamic)).map((w) => w.value ?? '');
    const staticPrefix = staticWords.join(' ');
    const text = (ws: readonly WordValue[]): string => ws.map((w) => w.value ?? w.raw).join(' ');

    denyForms.add(text(words));

    // Strip wrappers one level at a time; every level is a deny/ask candidate.
    let current = words;
    let allowStripped: readonly WordValue[] | undefined = hasAssigns ? undefined : words;
    let allowChainIntact = !hasAssigns;
    for (let guard = 0; guard < 16; guard++) {
      const head = current[0];
      if (!head) break;
      if (head.value === undefined || head.glob) {
        this.#uncertain.push(`command name ${JSON.stringify(head.raw)} is only known at run time`);
        allowStripped = undefined;
        break;
      }
      const name = head.value;
      const base = basename(name);
      if (base !== name) {
        // `/bin/rm x` is matched as `rm x` too.
        denyForms.add(text([{ ...head, value: base, raw: base }, ...current.slice(1)]));
      }
      if (base === 'cd' || base === 'pushd' || base === 'popd') this.#changesDirectory = true;
      if (CODE_EVALUATORS.has(base)) this.#uncertain.push(`\`${base}\` runs code that is only known at run time`);
      if (FILE_READERS.has(base)) {
        const operands = current.slice(1);
        for (let k = 0; k < operands.length; k++) {
          const operand = operands[k];
          if (!operand) continue;
          if (operand.raw.startsWith('<(') || operand.raw.startsWith('>(')) continue;
          if (operand.value !== undefined && operand.value.startsWith('-')) {
            if (READER_OPTIONS_WITH_VALUE.has(operand.value)) k++;
            continue;
          }
          this.#files.push({ access: 'read', path: operand.value !== undefined && !operand.glob ? operand.value : undefined });
        }
      }
      if (base === 'tee') {
        for (const operand of current.slice(1)) {
          if (operand.value !== undefined && operand.value.startsWith('-')) continue;
          this.#files.push({ access: 'write', path: operand.value !== undefined && !operand.glob ? operand.value : undefined });
        }
      }
      if (SHELLS.has(base)) this.#shell(current, ctx);
      if (base === 'find') this.#findExec(current, ctx);

      const unwrapped = unwrap(base, current);
      if (unwrapped === undefined) break;
      if (unwrapped.inner.length === 0) break;
      current = unwrapped.inner;
      denyForms.add(text(current));
      if (allowChainIntact && unwrapped.documented) allowStripped = current;
      else allowChainIntact = false;
    }

    const allowForm = allowStripped !== undefined && !dynamic ? text(allowStripped) : undefined;
    this.#commands.push({ raw, denyForms: [...denyForms], allowForm, staticPrefix, dynamic });
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
        if (w.value === '-o' || w.value === '+o') i++; // option name follows
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
