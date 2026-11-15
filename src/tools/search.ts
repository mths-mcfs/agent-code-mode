import { constants as FS } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ToolError } from '../core/errors.js';
import { DEFAULT_CASE_INSENSITIVE, matchesPathPattern } from '../core/paths.js';
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
  for (const layer of layers) {
    const rel = path.relative(layer.base, abs).split(path.sep).join('/');
    if (rel === '' || rel.startsWith('..')) continue;
    for (const rule of layer.rules) {
      if (rule.dirOnly && !isDir) {
        // `dir/` also ignores what is below it: test the parents.
        const parts = rel.split('/');
        parts.pop();
        let matchedParent = false;
        for (let i = parts.length; i > 0 && !matchedParent; i--) {
          if (rule.re.test(parts.slice(0, i).join('/'))) matchedParent = true;
        }
        if (matchedParent) ignored = !rule.negate;
        continue;
      }
      if (rule.re.test(rel)) ignored = !rule.negate;
    }
  }
  return ignored;
}

async function loadIgnore(dir: string): Promise<IgnoreLayer | null> {
  try {
    const handle = await fs.open(path.join(dir, '.gitignore'), FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0));
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
    const own = dir === absRoot ? null : await loadIgnore(dir);
    const here = own ? [...layers, own] : layers;
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const subdirs: string[] = [];
    for (const entry of entries) {
      if (++visited > MAX_VISITED) throw new ToolError('tool-error', `too many files under ${absRoot} (more than ${MAX_VISITED}); narrow the path`);
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (ALWAYS_IGNORED.has(entry.name)) continue;
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

export async function runGrep(effect: GrepEffect, jailRoot: string, signal: AbortSignal): Promise<GrepResult> {
  const re = compileGrep(effect.pattern, effect.ignoreCase);
  const globs = effect.glob === null ? null : expandBraces(effect.glob.replace(/\\/g, '/'));
  const matches: GrepMatch[] = [];
  let truncated = false;
  for await (const file of walkFiles(effect.absRoot, jailRoot, signal)) {
    if (globs && file !== effect.absRoot && !matchesFileGlob(toRel(effect.absRoot, file), globs)) continue;
    let bytes: Buffer;
    try {
      const handle = await fs.open(file, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0));
      try {
        const st = await handle.stat();
        if (!st.isFile() || st.size > MAX_GREP_FILE_BYTES) continue;
        bytes = await handle.readFile();
      } finally {
        await handle.close();
      }
    } catch {
      continue;
    }
    if (bytes.subarray(0, 8192).includes(0)) continue;
    const lines = bytes.toString('utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      let text = lines[i] ?? '';
      if (text.endsWith('\r')) text = text.slice(0, -1);
      if (i === lines.length - 1 && text === '') break;
      if (!re.test(text)) continue;
      if (matches.length >= effect.maxResults) {
        truncated = true;
        return { matches, truncated };
      }
      matches.push({ file, line: i + 1, text: text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text });
    }
  }
  return { matches, truncated };
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

