/**
 * Codex exec policy rules (`rules/*.rules`), parsed from a safe subset of
 * Starlark without ever evaluating Starlark.
 *
 * Reference: openai/codex rust-v0.169.0 (commit d32063f96c2d),
 * `codex-rs/execpolicy/src/{parser,rule,policy,decision}.rs`.
 *
 * Supported: comments, and calls `prefix_rule(pattern=[...], decision=...,
 * justification=..., match=[...], not_match=[...])` with string or
 * list-of-strings tokens (the first argument may be passed positionally).
 * Everything else Codex accepts (`network_rule`, `host_executable`,
 * `canonical_matching`, variables, loops, f-strings, ...) is outside the
 * subset and fails the load, so every call is then denied.
 */

import path from 'node:path';
import { shlexSplit } from './shell.js';

export type RuleDecision = 'allow' | 'prompt' | 'forbidden';

/** One `prefix_rule`, already expanded by its first-token alternatives (like Codex). */
export interface PrefixRule {
  readonly program: string;
  /** Tokens after the program; each is a set of alternatives. */
  readonly rest: readonly (readonly string[])[];
  readonly decision: RuleDecision;
  readonly justification?: string;
  /** `file:line` of the call, for messages. */
  readonly source: string;
}

export interface ExecPolicy {
  readonly rules: readonly PrefixRule[];
}

export class RulesParseError extends Error {
  override readonly name = 'RulesParseError';
}

// ---------------------------------------------------------------------------
// Lexer and parser for the subset.
// ---------------------------------------------------------------------------

type Tok =
  | { readonly t: 'ident'; readonly v: string; readonly line: number }
  | { readonly t: 'str'; readonly v: string; readonly line: number }
  | { readonly t: 'punct'; readonly v: '(' | ')' | '[' | ']' | ',' | '=' | ';'; readonly line: number }
  | { readonly t: 'newline'; readonly line: number };

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '0': '\0' };

function lex(src: string, file: string): Tok[] {
  const toks: Tok[] = [];
  let line = 1;
  let depth = 0;
  const fail: (msg: string) => never = (msg) => {
    throw new RulesParseError(`${file}:${line}: ${msg}`);
  };
  for (let i = 0; i < src.length; ) {
    const ch = src[i] ?? '';
    if (ch === '\n') {
      if (depth === 0) toks.push({ t: 'newline', line });
      line++;
      i++;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i++;
      continue;
    }
    if (ch === '\\' && src[i + 1] === '\n') {
      i += 2;
      line++;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if ('()[],=;'.includes(ch)) {
      if (ch === '(' || ch === '[') depth++;
      if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
      toks.push({ t: 'punct', v: ch as '(' | ')' | '[' | ']' | ',' | '=' | ';', line });
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j] ?? '')) j++;
      const word = src.slice(i, j);
      // String prefixes (r"", b"", f"") are outside the subset.
      if (src[j] === '"' || src[j] === "'") fail(`string prefix ${JSON.stringify(word)} is not supported`);
      toks.push({ t: 'ident', v: word, line });
      i = j;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const triple = src.startsWith(ch.repeat(3), i);
      const quote = triple ? ch.repeat(3) : ch;
      let j = i + quote.length;
      let value = '';
      const startLine = line;
      for (;;) {
        if (j >= src.length) fail('unterminated string');
        const c = src[j] ?? '';
        if (src.startsWith(quote, j)) {
          j += quote.length;
          break;
        }
        if (c === '\n') {
          if (!triple) fail('newline in string');
          line++;
        }
        if (c === '\\') {
          const n = src[j + 1] ?? '';
          if (n === '\n') {
            line++;
            j += 2;
            continue;
          }
          const esc = ESCAPES[n];
          if (esc === undefined) fail(`unsupported escape \\${n}`);
          value += esc;
          j += 2;
          continue;
        }
        value += c;
        j++;
      }
      toks.push({ t: 'str', v: value, line: startLine });
      i = j;
      continue;
    }
    fail(`unsupported syntax ${JSON.stringify(ch)}`);
  }
  return toks;
}

type Value = { readonly kind: 'str'; readonly v: string } | { readonly kind: 'list'; readonly items: readonly Value[] };

class Parser {
  #i = 0;
  constructor(
    private readonly toks: readonly Tok[],
    private readonly file: string,
  ) {}

  #peek(): Tok | undefined {
    return this.toks[this.#i];
  }

  #fail(msg: string, tok?: Tok): never {
    const line = tok?.line ?? this.#peek()?.line ?? this.toks[this.toks.length - 1]?.line ?? 1;
    throw new RulesParseError(`${this.file}:${line}: ${msg}`);
  }

  #expect(v: string): Tok {
    const tok = this.#peek();
    if (!tok || tok.t !== 'punct' || tok.v !== v) this.#fail(`expected ${JSON.stringify(v)}`, tok);
    this.#i++;
    return tok;
  }

  #isPunct(v: string): boolean {
    const tok = this.#peek();
    return tok !== undefined && tok.t === 'punct' && tok.v === v;
  }

  #value(): Value {
    const tok = this.#peek();
    if (!tok) this.#fail('unexpected end of file');
    if (tok.t === 'str') {
      this.#i++;
      return { kind: 'str', v: tok.v };
    }
    if (tok.t === 'punct' && tok.v === '[') {
      this.#i++;
      const items: Value[] = [];
      while (!this.#isPunct(']')) {
        items.push(this.#value());
        if (this.#isPunct(',')) this.#i++;
        else if (!this.#isPunct(']')) this.#fail('expected "," or "]"');
      }
      this.#i++;
      return { kind: 'list', items };
    }
    return this.#fail(`unsupported value ${tok.t === 'ident' ? tok.v : tok.t === 'punct' ? tok.v : 'newline'} (only strings and lists are supported)`, tok);
  }

  /** Parses the file into the arguments of each `prefix_rule` call. */
  calls(): { line: number; positional: Value[]; kwargs: Map<string, Value> }[] {
    const calls: { line: number; positional: Value[]; kwargs: Map<string, Value> }[] = [];
    while (this.#i < this.toks.length) {
      const tok = this.#peek();
      if (!tok) break;
      if (tok.t === 'newline' || (tok.t === 'punct' && tok.v === ';')) {
        this.#i++;
        continue;
      }
      if (tok.t !== 'ident') this.#fail('expected a prefix_rule(...) call', tok);
      if (tok.v !== 'prefix_rule') this.#fail(`${tok.v} is outside the supported rules subset (only prefix_rule is supported)`, tok);
      this.#i++;
      this.#expect('(');
      const positional: Value[] = [];
      const kwargs = new Map<string, Value>();
      while (!this.#isPunct(')')) {
        const a = this.#peek();
        const b = this.toks[this.#i + 1];
        if (a?.t === 'ident' && b?.t === 'punct' && b.v === '=') {
          this.#i += 2;
          if (kwargs.has(a.v)) this.#fail(`argument ${a.v} given twice`, a);
          kwargs.set(a.v, this.#value());
        } else {
          if (kwargs.size > 0) this.#fail('positional argument after keyword argument', a);
          positional.push(this.#value());
        }
        if (this.#isPunct(',')) this.#i++;
        else if (!this.#isPunct(')')) this.#fail('expected "," or ")"');
      }
      this.#i++;
      const after = this.#peek();
      if (after && after.t !== 'newline' && !(after.t === 'punct' && after.v === ';')) this.#fail('expected end of statement', after);
      calls.push({ line: tok.line, positional, kwargs });
    }
    return calls;
  }
}

// ---------------------------------------------------------------------------
// Building and validating rules.
// ---------------------------------------------------------------------------

const KNOWN_ARGS = new Set(['pattern', 'decision', 'justification', 'match', 'not_match']);

function asString(v: Value, what: string, fail: (m: string) => never): string {
  if (v.kind !== 'str') fail(`${what} must be a string`);
  return v.v;
}

function parsePatternToken(v: Value, fail: (m: string) => never): string[] {
  if (v.kind === 'str') return [v.v];
  const alts = v.items.map((item) => {
    if (item.kind !== 'str') fail('pattern alternative must be a string');
    return item.v;
  });
  if (alts.length === 0) fail('pattern alternatives cannot be empty');
  return alts;
}

function parseExample(v: Value, fail: (m: string) => never): string[] {
  if (v.kind === 'str') {
    const tokens = shlexSplit(v.v);
    if (tokens === undefined) fail('example string has invalid shell syntax');
    if (tokens.length === 0) fail('example cannot be an empty string');
    return tokens;
  }
  const tokens = v.items.map((item) => {
    if (item.kind !== 'str') fail('example tokens must be strings');
    return item.v;
  });
  if (tokens.length === 0) fail('example cannot be an empty list');
  return tokens;
}

function parseExamples(v: Value | undefined, what: string, fail: (m: string) => never): string[][] {
  if (v === undefined) return [];
  if (v.kind !== 'list') fail(`${what} must be a list`);
  return v.items.map((item) => parseExample(item, fail));
}

/** Parses one rules file. Throws `RulesParseError` on anything outside the subset or a failing example. */
export function parseRulesFile(src: string, file: string): PrefixRule[] {
  const calls = new Parser(lex(src, file), file).calls();
  const rules: PrefixRule[] = [];
  for (const call of calls) {
    const fail: (m: string) => never = (m) => {
      throw new RulesParseError(`${file}:${call.line}: prefix_rule: ${m}`);
    };
    if (call.positional.length > 1) fail('only the pattern may be passed positionally');
    for (const key of call.kwargs.keys()) {
      if (!KNOWN_ARGS.has(key)) fail(`argument ${key} is outside the supported rules subset`);
    }
    if (call.positional.length === 1 && call.kwargs.has('pattern')) fail('pattern given twice');
    const patternValue = call.positional[0] ?? call.kwargs.get('pattern');
    if (patternValue === undefined) fail('missing pattern');
    if (patternValue.kind !== 'list') fail('pattern must be a list');
    const tokens = patternValue.items.map((t) => parsePatternToken(t, fail));
    const [first, ...rest] = tokens;
    if (first === undefined) fail('pattern cannot be empty');

    const decisionValue = call.kwargs.get('decision');
    const rawDecision = decisionValue === undefined ? 'allow' : asString(decisionValue, 'decision', fail);
    if (rawDecision !== 'allow' && rawDecision !== 'prompt' && rawDecision !== 'forbidden') fail(`invalid decision ${JSON.stringify(rawDecision)}`);
    const decision: RuleDecision = rawDecision;

    const justValue = call.kwargs.get('justification');
    const justification = justValue === undefined ? undefined : asString(justValue, 'justification', fail);
    if (justification !== undefined && justification.trim() === '') fail('justification cannot be empty');

    const matches = parseExamples(call.kwargs.get('match'), 'match', fail);
    const notMatches = parseExamples(call.kwargs.get('not_match'), 'not_match', fail);

    const source = `${file}:${call.line}`;
    const callRules: PrefixRule[] = first.map((program) => ({
      program,
      rest,
      decision,
      source,
      ...(justification === undefined ? {} : { justification }),
    }));

    // Codex validates the examples of each call against that call's rules only.
    const local: ExecPolicy = { rules: callRules };
    for (const example of notMatches) {
      if (matchRules(local, example).length > 0) fail(`not_match example ${JSON.stringify(example.join(' '))} matches the rule`);
    }
    for (const example of matches) {
      if (matchRules(local, example).length === 0) fail(`match example ${JSON.stringify(example.join(' '))} does not match the rule`);
    }
    rules.push(...callRules);
  }
  return rules;
}

function matchesPrefix(rule: PrefixRule, argv: readonly string[]): boolean {
  if (argv.length < rule.rest.length + 1 || argv[0] !== rule.program) return false;
  return rule.rest.every((alts, i) => alts.includes(argv[i + 1] ?? ''));
}

// Executable paths use the host platform's syntax: on POSIX a backslash is a
// literal file-name character, not a separator.
const isAbsolutePath = (p: string): boolean => path.isAbsolute(p);
const basename = (p: string): string => path.basename(p);

/**
 * Rules matching `argv`: exact program first; when none match and the
 * program is an absolute path, rules for its basename (Codex
 * `resolve_host_executables`, without `host_executable` restrictions since
 * those are outside the subset).
 */
export function matchRules(policy: ExecPolicy, argv: readonly string[]): PrefixRule[] {
  const exact = policy.rules.filter((r) => matchesPrefix(r, argv));
  if (exact.length > 0) return exact;
  const program = argv[0];
  if (program === undefined || !isAbsolutePath(program)) return [];
  const base = basename(program);
  if (base === '') return [];
  const rewritten = [base, ...argv.slice(1)];
  return policy.rules.filter((r) => matchesPrefix(r, rewritten));
}

const RANK: Record<RuleDecision, number> = { allow: 0, prompt: 1, forbidden: 2 };

/** The strictest decision among `rules`, or undefined when empty. */
export function strictest(rules: readonly PrefixRule[]): PrefixRule | undefined {
  let best: PrefixRule | undefined;
  for (const r of rules) if (best === undefined || RANK[r.decision] > RANK[best.decision]) best = r;
  return best;
}

// ---------------------------------------------------------------------------
// Codex's heuristic for unmatched commands (shell-command/src/command_safety/is_dangerous_command.rs).
// ---------------------------------------------------------------------------

function rmHasForce(args: readonly string[]): boolean {
  for (const a of args) {
    if (a === '--') return false;
    if (a === '--force') return true;
    if (a.startsWith('-') && !a.startsWith('--') && a.slice(1).includes('f')) return true;
  }
  return false;
}

/** Whether Codex flags this argv as dangerous (forced `rm`, through `sudo` and `env`). */
export function isDangerousCommand(argv: readonly string[], depth = 0): boolean {
  if (depth > 8) return true;
  const program = basename(argv[0] ?? '');
  if (program === 'rm') return rmHasForce(argv.slice(1));
  if (program === 'sudo') return isDangerousCommand(argv.slice(1), depth + 1);
  if (program === 'env') {
    let i = 1;
    while (i < argv.length) {
      const a = argv[i] ?? '';
      if (a === '--') {
        i++;
        break;
      }
      const eq = a.indexOf('=');
      if (a === '-i' || a === '--ignore-environment' || (eq > 0 && !a.startsWith('-'))) {
        i++;
        continue;
      }
      break;
    }
    return isDangerousCommand(argv.slice(i), depth + 1);
  }
  return false;
}
