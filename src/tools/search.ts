import { constants as FS } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ToolError } from '../core/errors.js';
import { DEFAULT_CASE_INSENSITIVE, matchesPathPattern } from '../core/paths.js';
import { isBinary, readFileInside } from './fs-ops.js';
import type { GlobEffect, GlobResult, GrepEffect, GrepMatch, GrepResult } from '../core/types.js';

/** Default `grep` result count. */
export const DEFAULT_GREP_MAX_RESULTS = 500;
/** Default `glob` result count. */
export const DEFAULT_GLOB_MAX_RESULTS = 1000;
/** Longest matching line returned by `grep`. */
const MAX_LINE_CHARS = 2000;
/** Files larger than this are not searched by `grep`. */
const MAX_GREP_FILE_BYTES = 16 * 1024 * 1024;
/** Upper bound of directory entries visited by one call. */
const MAX_VISITED = 500_000;

const ALWAYS_IGNORED = new Set(['.git', 'node_modules']);

// ---------------------------------------------------------------------------
// gitignore
// ---------------------------------------------------------------------------

interface IgnoreRule {
  readonly re: RegExp;
  readonly negate: boolean;
  readonly dirOnly: boolean;
}

function globToRegExpSource(glob: string): string {
  let src = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] ?? '';
    if (ch === '\\' && i + 1 < glob.length) {
      src += (glob[++i] ?? '').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    } else if (ch === '*') {
      if (glob[i + 1] === '*') {
        const prevSlash = i === 0 || glob[i - 1] === '/';
        const nextSlash = glob[i + 2] === '/' || i + 2 === glob.length;
        if (prevSlash && nextSlash) {
          if (i + 2 === glob.length) src += '.*';
          else {
            src += '(?:.*/)?';
            i++;
          }
          i++;
          continue;
        }
        i++;
      }
      src += '[^/]*';
    } else if (ch === '?') {
      src += '[^/]';
    } else if (ch === '[') {
      const close = glob.indexOf(']', i + 1);
      if (close === -1) src += '\\[';
      else {
        let body = glob.slice(i + 1, close);
        if (body.startsWith('!')) body = `^${body.slice(1)}`;
        src += `[${body.replace(/\\/g, '\\\\')}]`;
        i = close;
      }
    } else {
      src += ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    }
  }
  return src;
}

/** Parses a `.gitignore` file. Patterns are relative to the directory holding it. */
export function parseGitignore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.replace(/(?<!\\)\s+$/, '');
    if (line === '' || line.startsWith('#')) continue;
    let negate = false;
    if (line.startsWith('!')) {
      negate = true;
      line = line.slice(1);
    } else if (line.startsWith('\\!') || line.startsWith('\\#')) {
      line = line.slice(1);
    }
    let dirOnly = false;
    if (line.endsWith('/')) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    if (line === '') continue;
    const anchored = line.includes('/');
    if (line.startsWith('/')) line = line.slice(1);
    const body = globToRegExpSource(line);
    const src = anchored ? `^${body}(?:/.*)?$` : `(?:^|/)${body}(?:/.*)?$`;
    try {
      rules.push({ re: new RegExp(src, DEFAULT_CASE_INSENSITIVE ? 'i' : ''), negate, dirOnly });
    } catch {
      // An invalid pattern ignores nothing, as git does.
    }
  }
  return rules;
}

interface IgnoreLayer {
  /** Directory the rules are relative to. */
  readonly base: string;
  readonly rules: readonly IgnoreRule[];
}

function isIgnored(layers: readonly IgnoreLayer[], abs: string, isDir: boolean): boolean {
  let ignored = false;
  // Directory rules decide about a file's parents apart from the rules about the file itself,
  // so `!dir/` re-includes the directory without clearing what `*.log` says about its files.
  let parentIgnored = false;
  for (const layer of layers) {
    const rel = path.relative(layer.base, abs).split(path.sep).join('/');
    if (rel === '' || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) continue;
    for (const rule of layer.rules) {
      if (rule.dirOnly && !isDir) {
        // `dir/` also ignores what is below it: test the parents.
        const parts = rel.split('/');
        parts.pop();
        let matchedParent = false;
        for (let i = parts.length; i > 0 && !matchedParent; i--) {
          if (rule.re.test(parts.slice(0, i).join('/'))) matchedParent = true;
        }
        if (matchedParent) parentIgnored = !rule.negate;
        continue;
      }
      if (rule.re.test(rel)) ignored = !rule.negate;
    }
  }
  return ignored || parentIgnored;
}

async function loadIgnore(dir: string): Promise<IgnoreLayer | null> {
  try {
    // Non-blocking, so a FIFO named .gitignore cannot stall the open before the type check.
    const handle = await fs.open(path.join(dir, '.gitignore'), FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0) | (FS.O_NONBLOCK ?? 0));
    try {
      const st = await handle.stat();
      if (!st.isFile() || st.size > 1024 * 1024) return null;
      return { base: dir, rules: parseGitignore(await handle.readFile('utf8')) };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/** `.gitignore` layers of the directories from `top` down to `dir` (inclusive). */
async function ancestorLayers(top: string, dir: string): Promise<IgnoreLayer[]> {
  const chain: string[] = [];
  let cursor = dir;
  for (;;) {
    chain.push(cursor);
    if (cursor === top) break;
    const parent = path.dirname(cursor);
    if (parent === cursor || path.relative(top, parent).startsWith('..')) break;
    cursor = parent;
  }
  const layers: IgnoreLayer[] = [];
  for (const d of chain.reverse()) {
    const layer = await loadIgnore(d);
    if (layer) layers.push(layer);
  }
  return layers;
}

// ---------------------------------------------------------------------------
// Walking
// ---------------------------------------------------------------------------

async function isRealDir(dir: string): Promise<boolean> {
  const st = await fs.lstat(dir).catch(() => null);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return false;
  const real = await fs.realpath(dir).catch(() => null);
  return real !== null && (process.platform === 'win32' ? real.toLowerCase() === dir.toLowerCase() : real === dir);
}

/**
 * Lists regular files below `absRoot` (real path, inside the jail), sorted,
 * skipping `.git`, `node_modules` and gitignored entries. Symbolic links are
 * never followed, whether they point inside or outside the workspace.
 * `jailRoot` is the workspace root above it whose `.gitignore` files apply.
 */
async function* walkFiles(absRoot: string, jailRoot: string, signal: AbortSignal): AsyncGenerator<string> {
  const rootStat = await fs.lstat(absRoot);
  if (rootStat.isFile()) {
    yield absRoot;
    return;
  }
  if (!rootStat.isDirectory()) return;
  const startLayers = await ancestorLayers(jailRoot, absRoot);
  let visited = 0;
  const stack: { dir: string; layers: IgnoreLayer[] }[] = [{ dir: absRoot, layers: startLayers }];
  while (stack.length > 0) {
    if (signal.aborted) throw new ToolError('cancelled', 'the run was stopped');
    const { dir, layers } = stack.pop() as { dir: string; layers: IgnoreLayer[] };
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    // A directory swapped for a link while it was listed is skipped whole:
    // its names may come from outside the workspace.
    if (!(await isRealDir(dir))) continue;
    const own = dir === absRoot ? null : await loadIgnore(dir);
    const here = own ? [...layers, own] : layers;
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const subdirs: string[] = [];
    for (const entry of entries) {
      if (++visited > MAX_VISITED) throw new ToolError('tool-error', `too many files under ${absRoot} (more than ${MAX_VISITED}); narrow the path`);
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      // `.git` is also a file, in worktrees and submodules.
      if (ALWAYS_IGNORED.has(entry.name)) continue;
      if (entry.isDirectory()) {
        if (isIgnored(here, abs, true)) continue;
        subdirs.push(abs);
      } else if (entry.isFile()) {
        if (isIgnored(here, abs, false)) continue;
        yield abs;
      }
    }
    // Depth first, in name order: push in reverse so the first name pops first.
    // Files of a directory come before its subdirectories' files.
    for (const sub of subdirs.reverse()) stack.push({ dir: sub, layers: here });
  }
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/** Expands `{a,b}` alternations (nested allowed, at most 256 results). */
export function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf('{');
  if (open === -1) return [pattern];
  let depth = 0;
  let close = -1;
  const commas: number[] = [];
  for (let i = open; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    } else if (ch === ',' && depth === 1) commas.push(i);
  }
  if (close === -1 || commas.length === 0) return [pattern];
  const head = pattern.slice(0, open);
  const tail = pattern.slice(close + 1);
  const cuts = [open, ...commas, close];
  const out: string[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const alt = pattern.slice((cuts[i] ?? 0) + 1, cuts[i + 1]);
    for (const expanded of expandBraces(head + alt + tail)) {
      out.push(expanded);
      if (out.length >= 256) return out;
    }
  }
  return out;
}

/** Normalizes a glob pattern given relative to `absRoot`; refuses patterns that leave it. */
export function normalizeGlob(pattern: string, absRoot: string): string {
  let p = pattern.replace(/\\/g, '/');
  const rootFwd = absRoot.replace(/\\/g, '/');
  if (p.startsWith(`${rootFwd}/`)) p = p.slice(rootFwd.length + 1);
  else if (p.startsWith('/') || /^[A-Za-z]:\//.test(p)) {
    throw new ToolError('invalid-args', `glob pattern ${pattern} is absolute and not under ${absRoot}; pass the directory as path and a relative pattern`);
  }
  if (p.startsWith('./')) p = p.slice(2);
  if (p.split('/').includes('..')) throw new ToolError('invalid-args', `glob pattern ${pattern} must not contain ..`);
  return p;
}

function toRel(absRoot: string, abs: string): string {
  return path.relative(absRoot, abs).split(path.sep).join('/');
}

// ---------------------------------------------------------------------------
// grep and glob
// ---------------------------------------------------------------------------

/** Compiles a grep pattern (JavaScript RegExp syntax). */
export function compileGrep(pattern: string, ignoreCase: boolean): RegExp {
  try {
    return new RegExp(pattern, ignoreCase ? 'i' : '');
  } catch (err) {
    throw new ToolError('invalid-args', `invalid regular expression ${JSON.stringify(pattern)}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function matchesFileGlob(rel: string, globs: readonly string[]): boolean {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  return globs.some((g) => (g.includes('/') ? matchesPathPattern(rel, g) : matchesPathPattern(base, g)));
}

/**
 * Matches lines in a worker thread, so a pathological pattern (catastrophic
 * backtracking) can be stopped: each file gets a time budget, and an abort
 * terminates the worker at once.
 */
const MATCH_WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const re = new RegExp(workerData.pattern, workerData.flags);
parentPort.on('message', (m) => {
  const lines = m.text.split('\\n');
  const hits = [];
  let more = false;
  for (let i = 0; i < lines.length; i++) {
    let t = lines[i];
    if (t.endsWith('\\r')) t = t.slice(0, -1);
    if (i === lines.length - 1 && t === '') break;
    if (!re.test(t)) continue;
    if (hits.length >= m.room) { more = true; break; }
    hits.push([i + 1, t.length > m.lineMax ? t.slice(0, m.lineMax) + '\\u2026' : t]);
  }
  parentPort.postMessage({ hits, more });
});
`;

const HitsSchema = z.object({ hits: z.array(z.tuple([z.number().int(), z.string()])), more: z.boolean() });
type Hits = z.infer<typeof HitsSchema>;

class MatchWorker {
  readonly #worker: Worker;
  #dead = false;

  constructor(pattern: string, flags: string) {
    this.#worker = new Worker(MATCH_WORKER_SOURCE, {
      eval: true,
      workerData: { pattern, flags },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    this.#worker.once('exit', () => (this.#dead = true));
  }

  match(file: string, text: string, room: number, budgetMs: number, signal: AbortSignal): Promise<Hits> {
    return new Promise((resolve, reject) => {
      if (this.#dead) return reject(new ToolError('tool-error', 'grep worker stopped'));
      const done = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.#worker.off('message', onMessage);
        this.#worker.off('error', onError);
      };
      const onMessage = (msg: unknown): void => {
        done();
        const parsed = HitsSchema.safeParse(msg);
        if (parsed.success) resolve(parsed.data);
        else reject(new ToolError('tool-error', 'grep worker returned an invalid reply'));
      };
      const onError = (err: Error): void => {
        done();
        reject(new ToolError('tool-error', `grep failed on ${file}: ${err.message}`));
      };
      const onAbort = (): void => {
        done();
        this.close();
        reject(new ToolError('cancelled', 'grep was stopped because the run stopped'));
      };
      const timer = setTimeout(() => {
        done();
        this.close();
        reject(
          new ToolError(
            'tool-error',
            `grep pattern ran for more than ${budgetMs} ms on ${file} and was stopped; the regular expression is too expensive (catastrophic backtracking?)`,
          ),
        );
      }, budgetMs);
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      this.#worker.on('message', onMessage);
      this.#worker.once('error', onError);
      this.#worker.postMessage({ text, room, lineMax: MAX_LINE_CHARS });
    });
  }

  close(): void {
    this.#dead = true;
    void this.#worker.terminate();
  }
}

/** Default time budget of the regex on one file. */
export const DEFAULT_GREP_FILE_BUDGET_MS = 10_000;

export async function runGrep(
  effect: GrepEffect,
  jailRoot: string,
  signal: AbortSignal,
  fileBudgetMs: number = DEFAULT_GREP_FILE_BUDGET_MS,
): Promise<GrepResult> {
  compileGrep(effect.pattern, effect.ignoreCase);
  const globs = effect.glob === null ? null : expandBraces(effect.glob.replace(/\\/g, '/'));
  const matches: GrepMatch[] = [];
  const worker = new MatchWorker(effect.pattern, effect.ignoreCase ? 'i' : '');
  try {
    for await (const file of walkFiles(effect.absRoot, jailRoot, signal)) {
      const rel = file === effect.absRoot ? path.basename(file) : toRel(effect.absRoot, file);
      if (globs && !matchesFileGlob(rel, globs)) continue;
      // Opened without following links and checked to be the file at this path,
      // so a directory swapped for a link mid-walk cannot lead outside.
      const bytes = await readFileInside(file, MAX_GREP_FILE_BYTES);
      if (bytes === null || isBinary(bytes)) continue;
      const room = effect.maxResults - matches.length;
      const found = await worker.match(file, bytes.toString('utf8'), room, fileBudgetMs, signal);
      for (const [line, text] of found.hits) matches.push({ file, line, text });
      if (found.more) return { matches, truncated: true };
    }
  } finally {
    worker.close();
  }
  return { matches, truncated: false };
}

export async function runGlob(effect: GlobEffect, jailRoot: string, signal: AbortSignal): Promise<GlobResult> {
  const patterns = expandBraces(normalizeGlob(effect.pattern, effect.absRoot));
  const all: string[] = [];
  for await (const file of walkFiles(effect.absRoot, jailRoot, signal)) {
    if (file === effect.absRoot) continue;
    const rel = toRel(effect.absRoot, file);
    if (patterns.some((p) => matchesPathPattern(rel, p))) all.push(file);
  }
  all.sort();
  return { files: all.slice(0, effect.maxResults), truncated: all.length > effect.maxResults };
}
