import { RedirOperator, parse, walk } from 'sh-syntax/sync';
import type { CallExpr, DeclClause, File, Node, Redirect, Word, WordPart } from 'sh-syntax/sync';

export interface SimpleCommand {
  readonly raw: string;
  readonly denyForms: readonly string[];
  readonly staticPrefixes: readonly string[];
  readonly dynamic: boolean;
}

export interface BashAnalysis {
  readonly commands: readonly SimpleCommand[];
  readonly uncertain: readonly string[];
  readonly changesDirectory: boolean;
  readonly removals: readonly Removal[];
}

export interface Operand {
  readonly value: string | undefined;
  readonly raw: string;
  readonly glob: boolean;
  readonly tilde?: 'literal' | 'unknown';
  /** Written as `NAME=VALUE` with a value known only at run time because of a tilde: still an assignment to `env`. */
  readonly assignment?: true;
}

export interface Removal {
  readonly recursive: boolean;
  readonly targets: readonly Operand[];
}

export const MAX_ANALYZED_COMMAND_CHARS = 100_000;

const MAX_SHELL_NESTING = 4;

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'busybox']);

const SHELL_OPTIONS_WITH_OPERAND = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file', '--debugger-file']);

const CODE_EVALUATORS = new Set(['eval', 'source', '.', 'trap', 'fc']);

const MAX_WRAPPER_LEVELS = 64;

const NAME_REBINDERS = new Set(['alias', 'hash', 'enable']);

const REDIR_HDOC: ReadonlySet<number> = new Set([RedirOperator.Hdoc, RedirOperator.DashHdoc]);

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

function hasUnescaped(lit: string, chars: string): boolean {
  for (let i = 0; i < lit.length; i++) {
    const ch = lit[i] ?? '';
    if (ch === '\\') i++;
    else if (chars.includes(ch)) return true;
  }
  return false;
}

function pathOf(o: Operand): string | undefined {
  if (o.value === undefined || o.glob || o.tilde === 'unknown') return undefined;
  return o.tilde === 'literal' ? `./${o.value}` : o.value;
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
  readonly #uncertain: string[] = [];
  #changesDirectory = false;
  readonly #removals: Removal[] = [];

  static analyze(command: string): BashAnalysis {
    const analyzer = new BashAnalyzer();
    analyzer.#analyzeSource(command, 0);
    return {
      commands: analyzer.#commands,
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
          this.#redirect(node);
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
    // Outside POSIX mode, bash also expands an unquoted `~` after the `=` or a `:` of an argument written as an
    // assignment (`a+=~`, `dd if=~/x`): only known at run time.
    const assignment = word.parts[0]?.type === 'Lit' && /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(word.parts[0].value);
    if (assignment && word.parts.some((p) => p.type === 'Lit' && hasUnescaped(p.value, '~'))) return { value: undefined, raw, glob, assignment: true };
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
    const name = decl.variant?.value ?? 'declare';
    const raw = this.#text(decl, ctx);
    this.#commands.push({ raw, denyForms: [raw, name], staticPrefixes: [name], dynamic: true });
  }

  #redirect(redir: Redirect): void {
    if (REDIR_HDOC.has(redir.op) && redir.hdoc?.parts.some((p) => p.type !== 'Lit')) this.#uncertain.push('here-document with substitutions');
  }

  #callExpr(call: CallExpr, ctx: Ctx): void {
    const raw = this.#text(call, ctx);
    const words = call.args.map((w) => this.#word(w, ctx));
    if (words.length === 0) return;
    this.#addCommand(raw, words, ctx);
  }

  #addCommand(raw: string, words: readonly WordValue[], ctx: Ctx): void {
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
          const renamed = [{ ...head, value: base, raw: base }, ...ws.slice(1)];
          denyForms.add(text(renamed));
          staticPrefixes.add(prefix(renamed));
        }
      }
    };
    addForm(words);

    let current = words;
    for (let level = 0; ; level++) {
      if (level >= MAX_WRAPPER_LEVELS) {
        this.#uncertain.push(`more than ${MAX_WRAPPER_LEVELS} nested command wrappers`);
        break;
      }
      const head = current[0];
      if (!head) break;
      if (head.value === undefined || head.glob) {
        this.#uncertain.push(`command name ${JSON.stringify(head.raw)} is only known at run time`);
        break;
      }
      const base = basename(head.value);
      const operands = current.slice(1);
      if (base === 'cd' || base === 'pushd' || base === 'popd' || changesChildDir(base, operands)) this.#changesDirectory = true;
      if (CODE_EVALUATORS.has(base)) this.#uncertain.push(`\`${base}\` runs code that is only known at run time`);
      if (NAME_REBINDERS.has(base) && operands.length > 0) this.#uncertain.push(`\`${base}\` rebinds command names, so later commands cannot be matched by name`);
      if (base === 'rm' || base === 'rmdir') {
        // An unquoted run-time word may split into flags such as `-rf`.
        const recursive = operands.some((o) => (o.value === undefined ? !/^["']/.test(o.raw) : /^-[a-zA-Z]*[rR]/.test(o.value) || o.value === '--recursive'));
        const targets = operands.filter((o) => o.value === undefined || !o.value.startsWith('-'));
        this.#removals.push({ recursive, targets: targets.map((o) => (o.tilde === undefined ? o : { ...o, value: pathOf(o) })) });
      }
      if (SHELLS.has(base)) this.#shell(current, ctx);
      if (base === 'find') this.#findExec(current, ctx);
      if (base === 'env' && this.#envSplitString(current, ctx)) break;

      const unwrapped = unwrap(base, current);
      if (unwrapped === undefined) break;
      if (unwrapped.inner.length === 0) break;
      current = unwrapped.inner;
      addForm(current);
      let skip = 0;
      while (skip < current.length - 1 && isAssignment(current[skip])) skip++;
      if (skip > 0) {
        current = current.slice(skip);
        addForm(current);
      }
    }
    this.#commands.push({ raw, denyForms: [...denyForms], staticPrefixes: [...staticPrefixes], dynamic });
  }

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
        if (SHELL_OPTIONS_WITH_OPERAND.has(w.value)) i++;
        continue;
      }
      sawScript = true;
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
        if (inner.length > 0) this.#addCommand(inner.map((w) => w.raw).join(' '), inner, ctx);
        i = j;
      }
    }
  }
}

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

const WRAPPERS = new Set(['timeout', 'time', 'nice', 'nohup', 'stdbuf', 'command', 'builtin', 'noglob', 'xargs', 'sudo', 'env', 'exec', 'doas']);

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

function isAssignment(word: WordValue | undefined): boolean {
  return word?.assignment === true || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word?.value ?? '');
}

function unwrap(name: string, words: readonly WordValue[]): { inner: readonly WordValue[] } | undefined {
  if (!WRAPPERS.has(name)) return undefined;
  const withValue = OPTIONS_WITH_VALUE[name] ?? new Set<string>();
  let i = 1;
  for (; i < words.length; i++) {
    if (name === 'env' && isAssignment(words[i])) continue;
    const v = words[i]?.value;
    if (v === undefined) return { inner: words.slice(i) };
    if (v === '--') {
      i++;
      break;
    }
    if (name === 'nice' && /^-\d+$/.test(v)) continue;
    if (v.startsWith('-') && v.length > 1) {
      const flag = v.includes('=') ? v.slice(0, v.indexOf('=')) : v;
      if (withValue.has(flag) && !v.includes('=')) i++;
      continue;
    }
    break;
  }
  if (name === 'timeout' && i < words.length) i++;
  return { inner: words.slice(i) };
}
