/**
 * grep and glob under Codex: each runs as one ripgrep command through the
 * bash executor, so Codex exec policy rules and Bash hooks judge exactly the
 * command that runs (Codex has no search tool of its own; its model searches
 * with `rg` through the shell). The command's output is parsed back into the
 * binding's result.
 */

import path from 'node:path';
import { z } from 'zod';
import { ToolError } from '../../core/errors.js';
import type { BashResult, GlobResult, GrepMatch, GrepResult, PreparedCallOf, SearchLowering } from '../../core/types.js';
import { shellQuote } from './shell.js';

/** What the model is told about grep and glob under Codex. */
export const CODEX_SEARCH_NOTE =
  'Under Codex CLI, grep and glob run through ripgrep (rg). A grep pattern must be valid both as a JavaScript RegExp and as a ripgrep (Rust) regex: no look-around, no backreferences, no inline flags such as (?i) (use ignoreCase). Globs use rg --glob syntax: a pattern without / matches file names at any depth. Hidden files are searched; .git is never searched. Without a glob, files ignored by .gitignore, .ignore and .rgignore are skipped; a grep glob or a glob pattern also matches ignored files, because rg --glob overrides ignore files.';

const MAX_LINE_CHARS = 2000;

/** No config file can add flags, .gitignore applies outside a git repository too, hidden files in, stable order. */
const COMMON = ['--no-config', '--no-require-git', '--sort', 'path', '--hidden'];
/** Last, so it wins over a glob the call passes. */
const NO_GIT = ['-g', "'!.git'"];

function refuseRoot(root: string, what: string): void {
  // Windows accepts both separators and folds case, so `C:/repo/.GIT/x` is inside .git too.
  const parts = process.platform === 'win32' ? root.toLowerCase().split(/[\\/]/) : root.split('/');
  if (parts.includes('.git')) throw new ToolError('invalid-args', `under Codex, ${what} does not search inside .git (${root})`);
}

function refuseExclusion(glob: string, what: string): void {
  if (glob.startsWith('!')) throw new ToolError('invalid-args', `${what} ${JSON.stringify(glob)} starts with !, which ripgrep reads as an exclusion; under Codex, grep and glob take an inclusion glob`);
}

/**
 * The exact grep command. Its output is JSON lines: one `begin` and one
 * `end` per file with matches, one `match` per line. `3 * (max + 1)` lines
 * hold at least `max + 1` matches whenever that many exist.
 */
export function grepCommand(prepared: PreparedCallOf<'grep'>): string {
  const e = prepared.effect;
  refuseRoot(e.absRoot, 'grep');
  const parts = ['rg', '--json', ...COMMON];
  if (e.ignoreCase) parts.push('-i');
  if (e.glob !== null) {
    refuseExclusion(e.glob, 'grep glob');
    parts.push('-g', shellQuote(e.glob));
  }
  parts.push(...NO_GIT, '-e', shellQuote(e.pattern), '--', shellQuote(e.absRoot), '|', 'head', '-n', String(3 * (e.maxResults + 1)));
  return parts.join(' ');
}

/** The exact glob command: NUL-separated paths; the limit applies while parsing. */
export function globCommand(prepared: PreparedCallOf<'glob'>): string {
  const e = prepared.effect;
  refuseRoot(e.absRoot, 'glob');
  refuseExclusion(e.pattern, 'glob pattern');
  return ['rg', '--files', '--null', ...COMMON, '-g', shellQuote(e.pattern), ...NO_GIT, '--', shellQuote(e.absRoot)].join(' ');
}

function under(p: string, root: string): boolean {
  const rel = path.relative(root, p);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Checks what the command reported besides its output. rg writes errors to
 * stderr; for grep, `head` sets the exit status of the pipeline, so stderr
 * is the only signal. Throws `ToolError` when the search did not run.
 */
function checkRun(result: BashResult, what: 'grep' | 'glob'): void {
  if (result.timedOut) throw new ToolError('tool-error', `${what} timed out`);
  if (result.signal !== null) throw new ToolError('tool-error', `${what} was killed by ${result.signal}`);
  const stderr = result.stderr.trim();
  const missing = /(?:^|\n)(?:[^\n]*?: )?([A-Za-z0-9_.-]+): (?:command )?not found/.exec(stderr)?.[1];
  if (missing !== undefined || result.exitCode === 127) {
    throw new ToolError('tool-error', `${missing ?? 'rg'} is not installed or not on PATH; under Codex, ${what} runs through ${what === 'grep' ? 'rg and head' : 'rg'}`);
  }
  if (/regex parse error/.test(stderr)) {
    throw new ToolError(
      'invalid-args',
      `the grep pattern is not valid ripgrep (Rust regex) syntax; under Codex, grep runs through rg, so a pattern must be valid in both JavaScript and Rust regex syntax (no look-around, no backreferences; use ignoreCase for case). rg said: ${stderr.slice(0, 600)}`,
    );
  }
  if (/error parsing glob|unclosed (character class|alternate group)/.test(stderr)) {
    throw new ToolError('invalid-args', `the glob is not valid ripgrep --glob syntax. rg said: ${stderr.slice(0, 600)}`);
  }
  if (result.stdout === '' && stderr !== '') throw new ToolError('tool-error', `${what} failed: ${stderr.slice(0, 600)}`);
}

/** rg JSON text: UTF-8 as `text`, anything else as base64 `bytes`. */
const RgText = z.union([z.object({ text: z.string() }), z.object({ bytes: z.string() })]);
const RgLine = z.discriminatedUnion('type', [
  z.object({ type: z.literal('match'), data: z.object({ path: RgText, lines: RgText, line_number: z.number().int().positive() }) }),
  z.object({ type: z.enum(['begin', 'end', 'context', 'summary']) }),
]);

function unexpected(record: string): ToolError {
  return new ToolError('tool-error', `unexpected rg output ${JSON.stringify(record.slice(0, 200))}`);
}

function parseJsonLine(record: string): z.infer<typeof RgLine> {
  let value: unknown;
  try {
    value = JSON.parse(record);
  } catch {
    throw unexpected(record);
  }
  const parsed = RgLine.safeParse(value);
  if (!parsed.success) throw unexpected(record);
  return parsed.data;
}

export function parseGrep(prepared: PreparedCallOf<'grep'>, result: BashResult): GrepResult {
  checkRun(result, 'grep');
  const root = prepared.effect.absRoot;
  const max = prepared.effect.maxResults;
  const records = result.stdout.split('\n');
  // The last record is empty after a final newline, or cut by the runtime's output cap.
  const last = records.pop();
  if (last !== undefined && last !== '' && !result.truncated) records.push(last);
  const matches: GrepMatch[] = [];
  let found = 0;
  for (const record of records) {
    const line = parseJsonLine(record);
    if (line.type !== 'match') continue;
    found++;
    if (matches.length === max) continue;
    if (!('text' in line.data.path)) throw new ToolError('tool-error', 'rg found a match in a file whose name is not valid UTF-8');
    const file = line.data.path.text;
    if (!path.isAbsolute(file) || !under(file, root)) throw unexpected(record);
    const raw = 'text' in line.data.lines ? line.data.lines.text : Buffer.from(line.data.lines.bytes, 'base64').toString('utf8');
    let text = raw.replace(/\r?\n$/, '');
    if (text.length > MAX_LINE_CHARS) text = `${text.slice(0, MAX_LINE_CHARS)}…`;
    matches.push({ file, line: line.data.line_number, text });
  }
  return { matches, truncated: result.truncated || found > max };
}

export function parseGlob(prepared: PreparedCallOf<'glob'>, result: BashResult): GlobResult {
  checkRun(result, 'glob');
  const root = prepared.effect.absRoot;
  const max = prepared.effect.maxResults;
  const names = result.stdout.split('\0');
  // The last piece is empty after a final NUL, or cut by the runtime's output cap.
  names.pop();
  const files: string[] = [];
  for (const name of names) {
    if (!path.isAbsolute(name) || !under(name, root) || name === root) throw unexpected(name);
    if (files.length === max) break;
    files.push(name);
  }
  return { files, truncated: result.truncated || names.length > max };
}

export function lowerSearch(prepared: PreparedCallOf<'grep'> | PreparedCallOf<'glob'>): SearchLowering {
  if (prepared.tool === 'grep') return { command: grepCommand(prepared), parse: (r) => parseGrep(prepared, r) };
  return { command: globCommand(prepared), parse: (r) => parseGlob(prepared, r) };
}
