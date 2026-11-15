/**
 * Small POSIX shell helpers for the Codex adapter: quoting, and a splitter
 * that extracts the simple commands of a script so exec policy rules can be
 * evaluated on each argv.
 *
 * Codex itself (rust-v0.169.0, `shell-command/src/bash.rs`) parses
 * `bash -lc <script>` with tree-sitter and only splits "plain" scripts
 * (words, quotes, `&&`, `||`, `;`, `|`); anything else is evaluated as the
 * single argv `[bash, -lc, script]`. This splitter is deliberately stricter:
 * it also extracts commands inside `$(...)`, backticks, `<(...)`, subshells,
 * unquoted heredoc bodies and `sh -c` arguments, so a forbidden program is
 * found wherever it appears. It never decides that something is safe; extra
 * commands can only add matches. A script it cannot tokenize is an error.
 */

/** Quotes one word for a POSIX shell with single quotes. */
export function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** Result of splitting a script. */
export interface SplitResult {
  /** Every simple command found, as argv with quotes removed. Dynamic parts stay as their literal text. */
  readonly commands: readonly (readonly string[])[];
  /**
   * True when the script only uses what Codex calls a plain command sequence
   * (literal words and quotes joined by `&&`, `||`, `;`, `|` or newlines).
   */
  readonly plain: boolean;
}

export class ShellParseError extends Error {
  override readonly name = 'ShellParseError';
}

const RESERVED_PREFIX = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}', 'time', 'fi', 'done', 'esac']);
/** Commands whose following words are not a command (dropped whole). */
const NON_COMMAND = new Set(['for', 'case', 'select', 'function']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash']);
const MAX_DEPTH = 16;

interface Word {
  text: string;
  /** Contains an unquoted expansion or substitution. */
  dynamic: boolean;
  /** Any part of it was quoted. */
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
  /** Scripts found inside substitutions, heredocs, etc.; split recursively. */
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
    // A redirection: the next word is its target, not an argument.
    if (op === '<<' || op === '<<-') {
      const target = this.#nextWordRaw();
      const delimiter = target.word.text;
      this.#pendingHeredocs.push({ delimiter, stripTabs: op === '<<-', expand: !target.word.quoted });
    } else {
      this.#nextWordRaw();
    }
    // A redirection on its own still separates nothing; mark it so the
    // command builder does not take the target as argv.
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

  /** Finds `$(...)` and backtick substitutions in expandable text and queues them. */
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
        // `<(` / `>(` process substitution inside a word.
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
        // ANSI-C quoting: keep the raw text; it is not a plain word for Codex.
        const end = findAnsiCEnd(s, this.#i + 2);
        word.text += s.slice(this.#i + 2, end);
        word.quoted = true;
        word.dynamic = true;
        this.plain = false;
        this.#i = end + 1;
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
      if (word.text === '' && ch === '~') this.plain = false;
      if (ch === '*' || ch === '?' || ch === '[') this.plain = false;
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

  /** Reads `$name`, `${...}`, `$(...)`, `$((...))` or a backtick substitution into `word`. */
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

function findAnsiCEnd(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === "'") return i;
  }
  throw new ShellParseError('unterminated $\'...\' quote');
}

/** Index of the `)` closing a `(` whose content starts at `from`, honoring quotes and nesting. */
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

/** For `sh -c script` (any flags containing `c`), the script argument. */
function shellScriptArg(argv: readonly string[]): string | undefined {
  if (!SHELLS.has(basename(argv[0] ?? ''))) return undefined;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--') return undefined;
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(a)) return argv[i + 1];
    if (!a.startsWith('-') && !a.startsWith('+')) return undefined;
  }
  return undefined;
}

function buildCommands(tokens: readonly Token[], plainSoFar: boolean): { commands: string[][]; plain: boolean } {
  const commands: string[][] = [];
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
          words = words.slice(1);
          continue;
        }
        break;
      }
      if (words.length > 0) commands.push(words.map((w) => w.text));
    }
    current = [];
    skipRest = false;
  };
  for (const tok of tokens) {
    if (tok.kind === 'word') {
      if (current.length === 0 && !tok.word.quoted && NON_COMMAND.has(tok.word.text)) {
        plain = false;
        skipRest = true;
      }
      current.push(tok.word);
    } else {
      flush();
    }
  }
  flush();
  return { commands, plain };
}

function splitInto(script: string, depth: number, out: string[][]): boolean {
  if (depth > MAX_DEPTH) throw new ShellParseError('commands nested too deeply');
  const t = new Tokenizer(script);
  t.run();
  const built = buildCommands(t.tokens, t.plain);
  let plain = built.plain && t.nested.length === 0;
  for (const argv of built.commands) {
    out.push(argv);
    const inner = shellScriptArg(argv);
    if (inner !== undefined) {
      splitInto(inner, depth + 1, out);
      plain = false;
    }
  }
  for (const nested of t.nested) {
    splitInto(nested, depth + 1, out);
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
  const out: string[][] = [];
  const plain = splitInto(script, 0, out);
  return { commands: out, plain };
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
