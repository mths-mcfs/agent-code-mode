/**
 * Small POSIX shell helpers for the Codex adapter: quoting, and a splitter
 * that extracts the simple commands of a script so exec policy rules can be
 * evaluated on each argv.
 *
 * Codex itself (rust-v0.169.0, `shell-command/src/bash.rs`) parses
 * `bash -lc <script>` with tree-sitter and only splits "plain" scripts
 * (words, quotes, `&&`, `||`, `;`, `|`); anything else is evaluated as the
 * single argv `[bash, -lc, script]`. This splitter is stricter: it also
 * extracts commands inside `$(...)`, backticks, `<(...)`, subshells, unquoted
 * heredoc bodies, `$'...'` words, `sh -c` scripts and the wrappers it models.
 * Extra commands can only add matches. What it does not model (an unknown
 * wrapper option, `function`, `coproc`, aliases, a shell or `source` reading
 * standard input, a file descriptor or a process substitution) is reported as
 * unsure, and the adapter asks. A script it cannot tokenize is an error.
 *
 * Not inspected, as under Codex: the content of a script file (`bash ./x.sh`,
 * `source ./x.sh`) and configuration a program reads commands from (git's
 * diff.external or core.pager, an rg config file). A script or config the
 * run wrote earlier can start a forbidden program; the bash containment
 * still applies. A variable set on the command line that names such a
 * command or config file (GIT_PAGER, RIPGREP_CONFIG_PATH, ...) asks.
 */

export function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

export interface SplitResult {
  /** Every simple command found, as argv with quotes removed. Dynamic parts stay as their literal text. */
  readonly commands: readonly (readonly string[])[];
  /**
   * True when the script only uses what Codex calls a plain command sequence
   * (literal words and quotes joined by `&&`, `||`, `;`, `|` or newlines).
   */
  readonly plain: boolean;
  /** Wrapped commands this splitter could not resolve (unknown wrapper options). */
  readonly unsure: readonly string[];
  /** Commands with words expanded at run time (and what wrappers run from them): their real argv is unknown. */
  readonly dynamic: readonly (readonly string[])[];
  /** Variable assignments before a command or on their own (`A=1 cmd`, `A=1`), as written with quotes removed. */
  readonly assignments: readonly string[];
}

export class ShellParseError extends Error {
  override readonly name = 'ShellParseError';
}

const RESERVED_PREFIX = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}', 'fi', 'done', 'esac']);
const NON_COMMAND = new Set(['for', 'case', 'select']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash']);
const MAX_DEPTH = 16;

interface Word {
  text: string;
  dynamic: boolean;
  quoted: boolean;
}

type Token =
  | { readonly kind: 'word'; readonly word: Word }
  | { readonly kind: 'op'; readonly op: string }
  | { readonly kind: 'newline' };

interface PendingHeredoc {
  readonly delimiter: string;
  readonly stripTabs: boolean;
  readonly expand: boolean;
}

class Tokenizer {
  readonly tokens: Token[] = [];
  readonly nested: string[] = [];
  plain = true;
  #i = 0;
  readonly #pendingHeredocs: PendingHeredoc[] = [];

  constructor(private readonly src: string) {}

  run(): void {
    const s = this.src;
    while (this.#i < s.length) {
      const ch = s[this.#i] ?? '';
      if (ch === ' ' || ch === '\t') {
        this.#i++;
        continue;
      }
      if (ch === '\\' && s[this.#i + 1] === '\n') {
        this.plain = false;
        this.#i += 2;
        continue;
      }
      if (ch === '\n') {
        this.tokens.push({ kind: 'newline' });
        this.#i++;
        this.#readHeredocBodies();
        continue;
      }
      if (ch === '#') {
        // Codex rejects comment nodes for plain splitting.
        this.plain = false;
        while (this.#i < s.length && s[this.#i] !== '\n') this.#i++;
        continue;
      }
      // `<(...)` / `>(...)` process substitution starts a word, not a redirection.
      if ((ch === '<' || ch === '>') && s[this.#i + 1] === '(') {
        this.#readWord();
        continue;
      }
      const op = this.#readOperator();
      if (op !== undefined) {
        this.#handleOperator(op);
        continue;
      }
      this.#readWord();
    }
    if (this.#pendingHeredocs.length > 0) throw new ShellParseError('heredoc without a body');
  }

  #readOperator(): string | undefined {
    const s = this.src.slice(this.#i, this.#i + 3);
    for (const op of ['<<<', '<<-', '&>>', '&&', '||', ';;', '|&', '>>', '>|', '<>', '<&', '>&', '&>', '<<', ';', '&', '|', '(', ')', '<', '>']) {
      if (s.startsWith(op)) {
        this.#i += op.length;
        return op;
      }
    }
    return undefined;
  }

  #handleOperator(op: string): void {
    if (op === '&&' || op === '||' || op === ';' || op === '|') {
      this.tokens.push({ kind: 'op', op });
      return;
    }
    this.plain = false;
    if (op === ';;' || op === '&' || op === '|&' || op === '(' || op === ')') {
      this.tokens.push({ kind: 'op', op });
      return;
    }
    if (op === '<<' || op === '<<-') {
      const target = this.#nextWordRaw();
      const delimiter = target.word.text;
      this.#pendingHeredocs.push({ delimiter, stripTabs: op === '<<-', expand: !target.word.quoted });
    } else {
      this.#nextWordRaw();
    }
  }

  #nextWordRaw(): { word: Word } {
    const s = this.src;
    while (this.#i < s.length && (s[this.#i] === ' ' || s[this.#i] === '\t')) this.#i++;
    if (this.#i >= s.length || s[this.#i] === '\n') throw new ShellParseError('redirection without a target');
    const before = this.tokens.length;
    this.#readWord();
    const tok = this.tokens.pop();
    if (this.tokens.length !== before || tok === undefined || tok.kind !== 'word') throw new ShellParseError('redirection without a target');
    return { word: tok.word };
  }

  #readHeredocBodies(): void {
    const s = this.src;
    while (this.#pendingHeredocs.length > 0) {
      const doc = this.#pendingHeredocs.shift();
      if (doc === undefined) break;
      const body: string[] = [];
      let closed = false;
      while (this.#i < s.length) {
        let end = s.indexOf('\n', this.#i);
        if (end < 0) end = s.length;
        let line = s.slice(this.#i, end);
        this.#i = Math.min(end + 1, s.length);
        if (doc.stripTabs) line = line.replace(/^\t+/, '');
        if (line === doc.delimiter) {
          closed = true;
          break;
        }
        body.push(line);
      }
      if (!closed) throw new ShellParseError(`heredoc ${JSON.stringify(doc.delimiter)} is not terminated`);
      if (doc.expand) this.#collectSubstitutions(body.join('\n'));
    }
  }

  #collectSubstitutions(text: string): void {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '$' && text[i + 1] === '(') {
        const end = matchParen(text, i + 2);
        this.nested.push(text.slice(i + 2, end));
        i = end;
      } else if (ch === '`') {
        const end = matchBacktick(text, i + 1);
        this.nested.push(unescapeBacktick(text.slice(i + 1, end)));
        i = end;
      }
    }
  }

  #readWord(): void {
    const s = this.src;
    const word: Word = { text: '', dynamic: false, quoted: false };
    while (this.#i < s.length) {
      const ch = s[this.#i] ?? '';
      if (ch === ' ' || ch === '\t' || ch === '\n') break;
      if (';&|()<>'.includes(ch)) {
        if ((ch === '<' || ch === '>') && s[this.#i + 1] === '(') {
          const end = matchParen(s, this.#i + 2);
          this.nested.push(s.slice(this.#i + 2, end));
          word.text += s.slice(this.#i, end + 1);
          word.dynamic = true;
          this.plain = false;
          this.#i = end + 1;
          continue;
        }
        // `2>file`: a word made only of digits right before a redirection is an fd.
        if ((ch === '<' || ch === '>') && /^\d+$/.test(word.text) && !word.quoted) {
          word.text = '';
          return;
        }
        break;
      }
      if (ch === '\\') {
        const next = s[this.#i + 1];
        if (next === undefined) throw new ShellParseError('trailing backslash');
        this.plain = false;
        if (next !== '\n') word.text += next;
        word.quoted = true;
        this.#i += 2;
        continue;
      }
      if (ch === "'") {
        const end = s.indexOf("'", this.#i + 1);
        if (end < 0) throw new ShellParseError('unterminated single quote');
        word.text += s.slice(this.#i + 1, end);
        word.quoted = true;
        this.#i = end + 1;
        continue;
      }
      if (ch === '$' && s[this.#i + 1] === "'") {
        // ANSI-C quoting: bash decodes the escapes; the word is that decoded text.
        const end = findAnsiCEnd(s, this.#i + 2);
        const decoded = decodeAnsiC(s.slice(this.#i + 2, end));
        word.text += decoded.text;
        word.quoted = true;
        if (!decoded.exact) word.dynamic = true;
        this.plain = false;
        this.#i = end + 1;
        continue;
      }
      if (ch === '$' && s[this.#i + 1] === '"') {
        // Locale translation: the text may be replaced at run time.
        this.#i++;
        this.#readDoubleQuoted(word);
        word.dynamic = true;
        this.plain = false;
        continue;
      }
      if (ch === '"') {
        this.#readDoubleQuoted(word);
        continue;
      }
      if (ch === '$' || ch === '`') {
        this.#readExpansion(word);
        continue;
      }
      // Codex `is_literal_word_or_number`: these characters (or a leading `=`)
      // mean the word may expand, so the script is not plain.
      if ('{}*?[]~^#'.includes(ch) || (word.text === '' && !word.quoted && ch === '=')) this.plain = false;
      // Pathname, brace and tilde expansion change the argv at run time. An
      // unquoted `~` expands at the word start and after `=` or `:`, whatever
      // quoting came earlier in the word (`A="a":~/b`).
      if ('*?[{'.includes(ch) || (ch === '~' && ((word.text === '' && !word.quoted) || /[=:]$/.test(word.text)))) word.dynamic = true;
      word.text += ch;
      this.#i++;
    }
    if (word.text === '' && !word.quoted && !word.dynamic) return;
    this.tokens.push({ kind: 'word', word });
  }

  #readDoubleQuoted(word: Word): void {
    const s = this.src;
    word.quoted = true;
    this.#i++;
    while (true) {
      if (this.#i >= s.length) throw new ShellParseError('unterminated double quote');
      const ch = s[this.#i] ?? '';
      if (ch === '"') {
        this.#i++;
        return;
      }
      if (ch === '\\') {
        const next = s[this.#i + 1];
        if (next === undefined) throw new ShellParseError('unterminated double quote');
        this.plain = false;
        if ('$`"\\'.includes(next)) word.text += next;
        else if (next !== '\n') word.text += `\\${next}`;
        this.#i += 2;
        continue;
      }
      if (ch === '$' || ch === '`') {
        this.#readExpansion(word);
        continue;
      }
      word.text += ch;
      this.#i++;
    }
  }

  #readExpansion(word: Word): void {
    const s = this.src;
    const start = this.#i;
    const ch = s[this.#i];
    if (ch === '`') {
      const end = matchBacktick(s, this.#i + 1);
      this.nested.push(unescapeBacktick(s.slice(this.#i + 1, end)));
      this.#i = end + 1;
    } else if (s[this.#i + 1] === '(') {
      const end = matchParen(s, this.#i + 2);
      this.nested.push(s.slice(this.#i + 2, end));
      this.#i = end + 1;
    } else if (s[this.#i + 1] === '{') {
      const end = matchBrace(s, this.#i + 2);
      this.#collectSubstitutions(s.slice(this.#i + 2, end));
      this.#i = end + 1;
    } else if (/[A-Za-z0-9_@*#?$!-]/.test(s[this.#i + 1] ?? '')) {
      this.#i += 2;
      if (/[A-Za-z_]/.test(s[start + 1] ?? '')) {
        while (/[A-Za-z0-9_]/.test(s[this.#i] ?? '')) this.#i++;
      }
    } else {
      // A lone `$` is literal.
      word.text += '$';
      this.#i++;
      return;
    }
    word.text += s.slice(start, this.#i);
    word.dynamic = true;
    this.plain = false;
  }
}

const ANSI_C_SIMPLE: Readonly<Record<string, string>> = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };

/**
 * The text bash makes of a `$'...'` body. `exact` is false when the result
 * depends on the locale (`\u`, `\U`) or on escapes this decoder does not
 * reproduce (`\c`).
 */
export function decodeAnsiC(body: string): { text: string; exact: boolean } {
  let text = '';
  let exact = true;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] ?? '';
    if (ch !== '\\') {
      text += ch;
      continue;
    }
    const next = body[i + 1] ?? '';
    const simple = ANSI_C_SIMPLE[next];
    if (simple !== undefined) {
      text += simple;
      i++;
      continue;
    }
    const octal = /^[0-7]{1,3}/.exec(body.slice(i + 1))?.[0];
    if (octal !== undefined) {
      text += String.fromCharCode(parseInt(octal, 8) & 0xff);
      i += octal.length;
      continue;
    }
    const hex = next === 'x' ? /^[0-9A-Fa-f]{1,2}/.exec(body.slice(i + 2))?.[0] : undefined;
    if (hex !== undefined) {
      text += String.fromCharCode(parseInt(hex, 16));
      i += 1 + hex.length;
      continue;
    }
    if (next === 'u' || next === 'U' || next === 'c') exact = false;
    text += `\\${next}`;
    i++;
  }
  return { text, exact };
}

function findAnsiCEnd(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === "'") return i;
  }
  throw new ShellParseError('unterminated $\'...\' quote');
}

function matchParen(s: string, from: number): number {
  let depth = 1;
  for (let i = from; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') i++;
    else if (ch === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) throw new ShellParseError('unterminated single quote');
      i = end;
    } else if (ch === '"') {
      i = matchDoubleQuote(s, i + 1);
    } else if (ch === '`') {
      i = matchBacktick(s, i + 1);
    } else if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new ShellParseError('unterminated $( or (');
}

function matchDoubleQuote(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') i++;
    else if (ch === '"') return i;
    else if (ch === '$' && s[i + 1] === '(') i = matchParen(s, i + 2);
    else if (ch === '`') i = matchBacktick(s, i + 1);
  }
  throw new ShellParseError('unterminated double quote');
}

function matchBacktick(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '`') return i;
  }
  throw new ShellParseError('unterminated backtick');
}

function matchBrace(s: string, from: number): number {
  let depth = 1;
  for (let i = from; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') i++;
    else if (ch === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) throw new ShellParseError('unterminated single quote');
      i = end;
    } else if (ch === '"') i = matchDoubleQuote(s, i + 1);
    else if (ch === '$' && s[i + 1] === '(') i = matchParen(s, i + 2);
    else if (ch === '`') i = matchBacktick(s, i + 1);
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new ShellParseError('unterminated ${');
}

function unescapeBacktick(s: string): string {
  return s.replace(/\\([$`\\])/g, '$1');
}

function isAssignment(word: Word): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(word.text);
}

function basename(program: string): string {
  const i = program.lastIndexOf('/');
  return i >= 0 ? program.slice(i + 1) : program;
}

/** Long options of bash, sh, dash and zsh that take no value. */
const SHELL_LONG_FLAGS = new Set(['--login', '--norc', '--noprofile', '--posix', '--restricted', '--verbose', '--noediting', '--debugger', '--dump-strings', '--dump-po-strings', '--help', '--version', '--pretty-print', '--emulate']);

/** What a shell invocation runs: a `-c` script, a script file, standard input, or something this splitter cannot tell. */
type ShellRun =
  | { readonly kind: 'script'; readonly script: string }
  | { readonly kind: 'file'; readonly file: string }
  | { readonly kind: 'stdin' }
  | { readonly kind: 'unsure'; readonly reason: string };

/**
 * Reads a shell's options the way bash, sh, dash and zsh do: grouped short
 * flags (`-ec`), `-o`/`+o`/`-O`/`+O` taking the next word, `--rcfile` and
 * `--init-file` taking the next word, and `--` or `-` ending the options.
 * With `-c` the first operand is the script.
 */
function shellRun(argv: readonly string[]): ShellRun {
  let command = false;
  let stdin = false;
  let i = 1;
  for (; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--' || a === '-') {
      i++;
      break;
    }
    if (a === '--rcfile' || a === '--init-file') {
      i++;
      continue;
    }
    if (a.startsWith('--')) {
      if (SHELL_LONG_FLAGS.has(a)) continue;
      return { kind: 'unsure', reason: `unknown option ${a} of ${argv[0] ?? ''}` };
    }
    if (!/^[-+][A-Za-z]+$/.test(a)) break;
    for (const flag of a.slice(1)) {
      if (flag === 'o' || flag === 'O') i++;
      else if (a.startsWith('-') && flag === 'c') command = true;
      else if (a.startsWith('-') && flag === 's') stdin = true;
    }
  }
  const operand = argv[i];
  if (command) return operand === undefined ? { kind: 'unsure', reason: `${argv[0] ?? ''} -c without a script` } : { kind: 'script', script: operand };
  if (stdin || operand === undefined) return { kind: 'stdin' };
  return { kind: 'file', file: operand };
}

/**
 * A script path whose content is not a file this splitter could name:
 * standard input, a file descriptor, a process substitution or a word
 * expanded at run time.
 */
function isStreamScript(file: string): boolean {
  return /^(\/dev\/(stdin|fd\/)|\/proc\/[^/]+\/fd\/|[<>]\()/.test(file) || /[$`]/.test(file);
}

function buildCommands(tokens: readonly Token[], plainSoFar: boolean): { commands: string[][]; dynamic: boolean[]; assignments: string[]; plain: boolean } {
  const commands: string[][] = [];
  const assignments: string[] = [];
  const dynamic: boolean[] = [];
  let plain = plainSoFar;
  let current: Word[] = [];
  let skipRest = false;
  const flush = (): void => {
    if (!skipRest) {
      let words = current;
      while (words.length > 0) {
        const first = words[0];
        if (first === undefined) break;
        if (!first.quoted && RESERVED_PREFIX.has(first.text)) {
          plain = false;
          words = words.slice(1);
          continue;
        }
        if (isAssignment(first)) {
          plain = false;
          assignments.push(first.text);
          words = words.slice(1);
          continue;
        }
        break;
      }
      if (words.length > 0) {
        commands.push(words.map((w) => w.text));
        dynamic.push(words.some((w) => w.dynamic));
      }
    }
    current = [];
    skipRest = false;
  };
  let sawCommand = false;
  let pendingOp = false;
  for (const tok of tokens) {
    if (tok.kind === 'word') {
      if (current.length === 0 && !tok.word.quoted && NON_COMMAND.has(tok.word.text)) {
        plain = false;
        skipRest = true;
      }
      // Codex needs the command name to be a bare word.
      if (current.length === 0 && tok.word.quoted) plain = false;
      current.push(tok.word);
      sawCommand = true;
      pendingOp = false;
    } else {
      // An operator with no command before it is a syntax error for Codex's parser.
      if (tok.kind === 'op' && current.length === 0) plain = false;
      if (tok.kind === 'op' && tok.op !== ';') pendingOp = true;
      else if (current.length > 0) pendingOp = false;
      flush();
    }
  }
  if (pendingOp || !sawCommand) plain = false;
  flush();
  return { commands, dynamic, assignments, plain };
}

type Unwrapped = { readonly kind: 'argv'; readonly argv: readonly string[] } | { readonly kind: 'script'; readonly script: string } | { readonly kind: 'unsure'; readonly reason: string };

/**
 * Skips the options of a wrapper starting at `i`. `withValue` lists options
 * that take the next word as their value (or `--opt=value`, `-oVALUE`);
 * `flags` lists options without a value. Returns the index of the wrapped
 * command, or a reason when an option is unknown.
 */
function skipOptions(argv: readonly string[], i: number, withValue: readonly string[], flags: readonly string[]): number | { reason: string } {
  while (i < argv.length) {
    const a = argv[i] ?? '';
    if (a === '--') return i + 1;
    if (!a.startsWith('-') || a === '-') return i;
    const name = a.startsWith('--') ? a.split('=')[0] ?? a : a;
    if (a.startsWith('--') && a.includes('=') && (withValue.includes(name) || flags.includes(name))) {
      i++;
      continue;
    }
    if (withValue.includes(name)) {
      i += 2;
      continue;
    }
    if (flags.includes(name)) {
      i++;
      continue;
    }
    // Short options: `-uroot` (value attached) or grouped flags like `-ix`.
    if (!a.startsWith('--')) {
      const short = `-${a[1] ?? ''}`;
      if (withValue.includes(short)) {
        i += 1;
        continue;
      }
      if ([...a.slice(1)].every((c) => flags.includes(`-${c}`))) {
        i++;
        continue;
      }
    }
    return { reason: `unknown option ${a} of ${argv[0] ?? ''}` };
  }
  return i;
}

function rest(argv: readonly string[], skipped: number | { reason: string }): Unwrapped | undefined {
  if (typeof skipped !== 'number') return { kind: 'unsure', reason: skipped.reason };
  const inner = argv.slice(skipped);
  return inner.length > 0 ? { kind: 'argv', argv: inner } : undefined;
}

/**
 * The commands a wrapper runs: `command`, `builtin`, `exec`, `nohup`, `time`,
 * `nice`, `timeout`, `sudo`, `doas`, `env`, `stdbuf`, `xargs`, `find -exec`,
 * `eval`, `trap` actions and `sh -c` scripts. Codex itself does not unwrap
 * them for rules (its dangerous-command check unwraps `sudo`, `env` and
 * `trap`); doing it for every rule only adds matches.
 */
function unwrap(argv: readonly string[]): Unwrapped[] {
  const program = basename(argv[0] ?? '');
  const one = (u: Unwrapped | undefined): Unwrapped[] => (u === undefined ? [] : [u]);
  if (SHELLS.has(program)) {
    const run = shellRun(argv);
    switch (run.kind) {
      case 'script':
        return [{ kind: 'script', script: run.script }];
      case 'stdin':
        return [{ kind: 'unsure', reason: `${argv[0] ?? ''} reads its script from standard input` }];
      case 'unsure':
        return [run];
      case 'file':
        // A script file's content is not inspected, as under Codex; a stream is not a file.
        return isStreamScript(run.file) ? [{ kind: 'unsure', reason: `${argv[0] ?? ''} runs a script from ${run.file}` }] : [];
    }
  }
  switch (program) {
    case 'source':
    case '.': {
      const file = argv[1] === '--' ? argv[2] : argv[1];
      if (file === undefined || isStreamScript(file)) return [{ kind: 'unsure', reason: `${program} reads a script from ${file ?? 'nothing'}` }];
      return [];
    }
    case 'function':
    case 'coproc':
      return [{ kind: 'unsure', reason: `${program} runs commands this check does not model` }];
    case 'alias':
      return argv.slice(1).some((a) => a.includes('=')) ? [{ kind: 'unsure', reason: 'an alias definition can rename any command' }] : [];
    case 'shopt':
      return argv.includes('expand_aliases') ? [{ kind: 'unsure', reason: 'expand_aliases lets aliases rename commands' }] : [];
    case 'enable':
      return argv.some((a) => /^-[A-Za-z]*f/.test(a)) ? [{ kind: 'unsure', reason: 'enable -f loads a builtin from a file' }] : [];
    case 'busybox': {
      // `busybox <applet> args` runs the applet.
      const applet = argv[1];
      if (applet === undefined) return [];
      if (applet.startsWith('-')) return [{ kind: 'unsure', reason: `unknown option ${applet} of busybox` }];
      return [{ kind: 'argv', argv: argv.slice(1) }];
    }
    case 'command':
    case 'builtin': {
      const skipped = skipOptions(argv, 1, [], ['-p', '-v', '-V']);
      // `command -v` / `-V` only look the name up; nothing runs.
      if (program === 'command' && typeof skipped === 'number' && argv.slice(1, skipped).some((a) => a !== '--' && /[vV]/.test(a))) return [];
      return one(rest(argv, skipped));
    }
    case 'exec':
      return one(rest(argv, skipOptions(argv, 1, ['-a'], ['-c', '-l'])));
    case 'nohup':
      return one(rest(argv, skipOptions(argv, 1, [], [])));
    case 'time':
      return one(rest(argv, skipOptions(argv, 1, [], ['-p'])));
    case 'nice': {
      let i = 1;
      const a = argv[1] ?? '';
      if (a === '-n' || a === '--adjustment') i = 3;
      else if (/^-n?-?\d+$/.test(a) || a.startsWith('--adjustment=')) i = 2;
      return one(rest(argv, skipOptions(argv, i, [], [])));
    }
    case 'timeout': {
      const skipped = skipOptions(argv, 1, ['-s', '--signal', '-k', '--kill-after'], ['--foreground', '--preserve-status', '-v', '--verbose']);
      if (typeof skipped !== 'number') return [{ kind: 'unsure', reason: skipped.reason }];
      return one(rest(argv, skipped + 1));
    }
    case 'sudo':
    case 'doas':
      return one(
        rest(
          argv,
          skipOptions(
            argv,
            1,
            ['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from', '-D', '--chdir', '-R', '--chroot', '-T', '--command-timeout', '-U', '--other-user', '-r', '--role', '-t', '--type'],
            ['-A', '-b', '-E', '-e', '-H', '-i', '-k', '-K', '-l', '-n', '-P', '-S', '-s', '-V', '-v', '--preserve-env', '--login', '--shell', '--non-interactive', '--stdin', '--askpass', '--background', '--set-home', '--reset-timestamp', '--remove-timestamp'],
          ),
        ),
      );
    case 'env': {
      let i = 1;
      while (i < argv.length) {
        const a = argv[i] ?? '';
        if (a === '--') {
          i++;
          break;
        }
        if (a === '-i' || a === '--ignore-environment' || a === '-0' || a === '--null') i++;
        else if (a === '-u' || a === '--unset' || a === '-C' || a === '--chdir') i += 2;
        else if (a.startsWith('--unset=') || a.startsWith('--chdir=') || /^-[uC]./.test(a)) i++;
        else if (a === '-S' || a === '--split-string' || a.startsWith('--split-string=') || /^-S./.test(a)) {
          // Only the option's value is split; the words after it stay as they are.
          const separate = a === '-S' || a === '--split-string';
          const value = separate ? argv[i + 1] : a.replace(/^--split-string=|^-S/, '');
          // env's own escapes, `${VAR}`, `#` comments and its `\v`/`\f` separators are not reproduced.
          const words = value === undefined || /[\\$#\v\f]/.test(value) ? undefined : shlexSplit(value);
          if (words === undefined) {
            const unsure: Unwrapped = { kind: 'unsure', reason: `cannot split the env -S value ${JSON.stringify(value ?? '')}` };
            return value === undefined ? [unsure] : [{ kind: 'script', script: value }, unsure];
          }
          return [{ kind: 'argv', argv: ['env', ...words, ...argv.slice(separate ? i + 2 : i + 1)] }];
        } else if (a.startsWith('-')) return [{ kind: 'unsure', reason: `unknown option ${a} of env` }];
        else if (/^[^=]+=/.test(a)) i++;
        else break;
      }
      return one(rest(argv, i));
    }
    case 'script':
    case 'flock':
    case 'su': {
      // `-c CMD` / `--command CMD` / `--command=CMD` runs a shell command.
      for (let i = 1; i < argv.length; i++) {
        const a = argv[i] ?? '';
        if (a === '-c' || a === '--command' || (program === 'script' && /^-[A-Za-z]*c$/.test(a))) return argv[i + 1] === undefined ? [] : [{ kind: 'script', script: argv[i + 1] ?? '' }];
        if (a.startsWith('--command=')) return [{ kind: 'script', script: a.slice('--command='.length) }];
      }
      if (program !== 'flock') return [{ kind: 'unsure', reason: `${program} without -c starts a shell that reads standard input` }];
      // `flock [options] FILE command args`.
      const skipped = skipOptions(argv, 1, ['-w', '--timeout', '-E', '--conflict-exit-code'], ['-s', '--shared', '-x', '-e', '--exclusive', '-u', '--unlock', '-n', '--nb', '--nonblock', '-o', '--close', '-F', '--no-fork', '--verbose']);
      if (typeof skipped !== 'number') return [{ kind: 'unsure', reason: skipped.reason }];
      return one(rest(argv, skipped + 1));
    }
    case 'stdbuf':
      return one(rest(argv, skipOptions(argv, 1, ['-i', '-o', '-e', '--input', '--output', '--error'], [])));
    case 'xargs':
      return one(
        rest(
          argv,
          skipOptions(
            argv,
            1,
            ['-a', '--arg-file', '-d', '--delimiter', '-E', '-I', '-L', '-n', '--max-args', '-P', '--max-procs', '-s', '--max-chars', '--process-slot-var'],
            ['-0', '--null', '-e', '-i', '-l', '-o', '--open-tty', '-p', '--interactive', '-r', '--no-run-if-empty', '-t', '--verbose', '-x', '--exit'],
          ),
        ),
      );
    case 'find': {
      const out: Unwrapped[] = [];
      for (let i = 1; i < argv.length; i++) {
        if (!['-exec', '-execdir', '-ok', '-okdir'].includes(argv[i] ?? '')) continue;
        let end = i + 1;
        while (end < argv.length && argv[end] !== ';' && argv[end] !== '+') end++;
        if (end > i + 1) out.push({ kind: 'argv', argv: argv.slice(i + 1, end) });
        i = end;
      }
      return out;
    }
    case 'eval':
      return argv.length > 1 ? [{ kind: 'script', script: argv.slice(1).join(' ') }] : [];
    case 'trap': {
      // Codex `dangerous_command_match_for_trap`: the action is shell source.
      let i = 1;
      if (argv[i] === '--') i++;
      const action = argv[i];
      if (action === undefined || action.startsWith('-')) return [];
      return [{ kind: 'script', script: action }];
    }
    default:
      return [];
  }
}

interface SplitState {
  readonly out: string[][];
  readonly dynamic: string[][];
  readonly unsure: string[];
  readonly assignments: string[];
}

function addCommand(argv: readonly string[], depth: number, st: SplitState, dynamic: boolean): boolean {
  if (depth > MAX_DEPTH) throw new ShellParseError('commands nested too deeply');
  st.out.push([...argv]);
  if (dynamic) st.dynamic.push([...argv]);
  let plain = true;
  for (const u of unwrap(argv)) {
    plain = false;
    if (u.kind === 'argv') addCommand(u.argv, depth + 1, st, dynamic);
    else if (u.kind === 'script') splitInto(u.script, depth + 1, st);
    else st.unsure.push(u.reason);
  }
  return plain;
}

function splitInto(script: string, depth: number, st: SplitState): boolean {
  if (depth > MAX_DEPTH) throw new ShellParseError('commands nested too deeply');
  const t = new Tokenizer(script);
  t.run();
  const built = buildCommands(t.tokens, t.plain);
  st.assignments.push(...built.assignments);
  let plain = built.plain && t.nested.length === 0;
  built.commands.forEach((argv, k) => {
    if (!addCommand(argv, depth, st, built.dynamic[k] ?? true)) plain = false;
  });
  for (const nested of t.nested) {
    splitInto(nested, depth + 1, st);
    plain = false;
  }
  return plain;
}

/**
 * Splits a shell script into its simple commands. Throws `ShellParseError`
 * when the script cannot be tokenized (unterminated quote, substitution or
 * heredoc).
 */
export function splitShellCommands(script: string): SplitResult {
  const st: SplitState = { out: [], dynamic: [], unsure: [], assignments: [] };
  const plain = splitInto(script, 0, st);
  return { commands: st.out, dynamic: st.dynamic, plain, unsure: st.unsure, assignments: st.assignments };
}

/**
 * Splits one string into words the way Python's `shlex.split` (and the Rust
 * `shlex` crate Codex uses for rule examples) does: quotes and backslashes,
 * no operators. Returns undefined on invalid syntax.
 */
export function shlexSplit(s: string): string[] | undefined {
  const words: string[] = [];
  let cur = '';
  let inWord = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] ?? '';
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (inWord) words.push(cur);
      cur = '';
      inWord = false;
      continue;
    }
    inWord = true;
    if (ch === '\\') {
      const next = s[i + 1];
      if (next === undefined) return undefined;
      cur += next;
      i++;
    } else if (ch === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) return undefined;
      cur += s.slice(i + 1, end);
      i = end;
    } else if (ch === '"') {
      let j = i + 1;
      for (; j < s.length; j++) {
        const c = s[j];
        if (c === '"') break;
        if (c === '\\' && j + 1 < s.length && '$`"\\\n'.includes(s[j + 1] ?? '')) {
          cur += s[j + 1];
          j++;
        } else cur += c;
      }
      if (j >= s.length) return undefined;
      i = j;
    } else {
      cur += ch;
    }
  }
  if (inWord) words.push(cur);
  return words;
}
