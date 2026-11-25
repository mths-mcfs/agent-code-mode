/*
 * `isInsideDir` and `windowsPathProblem` are adapted
 * from Turnpack's src/security.ts (https://github.com/OnlyTerp/turnpack,
 * Copyright 2026 OnlyTerp, licensed under the Apache License, Version 2.0:
 * http://www.apache.org/licenses/LICENSE-2.0).
 * Modified by the agent-code-mode authors: asynchronous, multiple roots,
 * errors as ToolError, UNC and device prefixes refused.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ToolError } from '../core/errors.js';
import { DEFAULT_CASE_INSENSITIVE, findMatchingPattern } from '../core/paths.js';

/**
 * Workspace jail: every path a tool touches is resolved to an absolute real
 * path and must live under one of the allowed roots.
 *
 * Resolution walks the path one component at a time with `lstat` and follows
 * each link by hand (`resolvePhysical`), so a dangling link and `link/..` are
 * judged by where the operating system would really land.
 */

const MAX_LINK_HOPS = 40;
const IS_WINDOWS = process.platform === 'win32';

function errnoCode(err: unknown): string | undefined {
  if (err !== null && typeof err === 'object' && 'code' in err && typeof err.code === 'string') return err.code;
  return undefined;
}

async function lstatOrNull(p: string): Promise<import('node:fs').Stats | null> {
  try {
    return await fs.lstat(p);
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    if (code === 'ENAMETOOLONG') throw new ToolError('invalid-args', `path is too long: ${p.slice(0, 120)}…`);
    throw err;
  }
}

/** What resolving a path found. */
export interface Resolution {
  /** Absolute real path (the missing tail, if any, joined to the deepest existing real directory). */
  readonly real: string;
  /** Absolute locations of every symbolic link followed on the way, in order. */
  readonly links: readonly string[];
  /** True when the path's own last component is a symbolic link. */
  readonly finalIsLink: boolean;
}

function splitComponents(p: string): string[] {
  return p.split(IS_WINDOWS ? /[\\/]+/ : /\/+/);
}

function stripVerbatim(target: string): string {
  return IS_WINDOWS && target.startsWith('\\\\?\\') ? target.slice(4) : target;
}

/**
 * Resolves `input` (absolute, or relative to the real directory `base`)
 * component by component with POSIX semantics: a symbolic link is replaced
 * by its target before the next component is looked at, so `link/..` is the
 * parent of the link's target, not the directory holding the link. Nothing
 * is normalized lexically first. A `..` after a component that does not
 * exist is refused, as the operating system would refuse it.
 */
export async function resolvePhysical(input: string, base: string): Promise<Resolution> {
  let current: string;
  let rest: string;
  if (path.isAbsolute(input)) {
    const root = path.parse(input).root;
    current = path.resolve(root);
    rest = input.slice(root.length);
  } else {
    current = base;
    rest = input;
  }
  const queue = splitComponents(rest);
  const links: string[] = [];
  const meaningful = (q: readonly string[]): boolean => q.some((c) => c !== '' && c !== '.');
  let hops = 0;
  let missing = false;
  let finalIsLink = false;
  while (queue.length > 0) {
    const c = queue.shift() ?? '';
    if (c === '' || c === '.') continue;
    if (c === '..') {
      if (missing) throw new ToolError('not-found', `${input}: ".." after a component that does not exist`);
      current = path.dirname(current);
      continue;
    }
    const next = path.join(current, c);
    if (missing) {
      current = next;
      continue;
    }
    const st = await lstatOrNull(next);
    if (!st) {
      missing = true;
      current = next;
      continue;
    }
    if (st.isSymbolicLink()) {
      if (++hops > MAX_LINK_HOPS) throw new ToolError('outside-workspace', `${input}: too many symbolic links`);
      links.push(next);
      if (!meaningful(queue)) finalIsLink = true;
      const target = stripVerbatim(await fs.readlink(next));
      if (path.isAbsolute(target)) {
        const root = path.parse(target).root;
        current = path.resolve(root);
        queue.unshift(...splitComponents(target.slice(root.length)));
      } else {
        queue.unshift(...splitComponents(target));
      }
      continue;
    }
    if (!st.isDirectory() && meaningful(queue)) {
      throw new ToolError('not-found', `${input}: ${next} is not a directory`);
    }
    current = next;
  }
  // Canonical spelling (case, Windows short names) of the existing part.
  let existing = current;
  const tail: string[] = [];
  while (!(await lstatOrNull(existing))) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  let realExisting = existing;
  try {
    realExisting = await fs.realpath(existing);
  } catch {
    // Dangling final link target: keep the spelling.
  }
  return { real: tail.length === 0 ? realExisting : path.join(realExisting, ...tail), links, finalIsLink };
}

/** True when `target` is `base` or below it. Both must be real absolute paths. */
export function isInsideDir(base: string, target: string): boolean {
  const b = IS_WINDOWS ? base.toLowerCase() : base;
  const t = IS_WINDOWS ? target.toLowerCase() : target;
  const rel = path.relative(b, t);
  if (rel === '') return true;
  return !(rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
}

/**
 * Windows spellings that alias another name: device and verbatim prefixes
 * (`\\?\`, `\\.\`), UNC shares, NTFS alternate data streams (`name:stream`,
 * `.git::$INDEX_ALLOCATION`) and segments ending in a dot or space. Plain
 * string logic, tested everywhere; enforced only on Windows unless `force`.
 */
export function windowsPathProblem(target: string): string | null {
  if (/^[\\/]{2}/.test(target)) return 'UNC, device and verbatim (\\\\?\\) paths are not accepted';
  const rest = target.slice(path.win32.parse(target).root.length);
  for (const segment of rest.split(/[\\/]+/)) {
    if (segment === '' || segment === '.' || segment === '..') continue;
    if (segment.includes(':')) return `"${segment}" contains ":" (NTFS stream syntax is not accepted)`;
    if (/[. ]$/.test(segment)) return `"${segment}" ends in a dot or a space, which Windows silently drops`;
  }
  return null;
}

/** Expands a leading `~` or `~/` to the home directory. */
export function expandTilde(p: string, home: string = os.homedir()): string {
  if (p === '~') return home;
  // Not path.join: a `..` after a link must be resolved from the link's target, not removed lexically.
  if (p.startsWith('~/') || (IS_WINDOWS && p.startsWith('~\\'))) return `${home.endsWith(path.sep) ? home : home + path.sep}${p.slice(2)}`;
  return p;
}

/** Whether any segment of `absPath` is a `.git` directory (as Windows would also open it). */
export function isInsideGitDir(absPath: string): boolean {
  return absPath
    .split(/[\\/]+/)
    .some((segment) => {
      const lower = segment.toLowerCase();
      const plain = lower.replace(/:.*$/, '').replace(/[. ]+$/, '');
      return (DEFAULT_CASE_INSENSITIVE ? lower : segment) === '.git' || (IS_WINDOWS && plain === '.git');
    });
}

/**
 * Adds, for each pattern, the same pattern with its literal directory prefix
 * replaced by that directory's real path. Paths are checked as real paths, so
 * a pattern written through an alias of the workspace (a symlinked cwd,
 * macOS `/var` vs `/private/var`, a Windows 8.3 short name) must match too.
 */
async function withRealPrefixes(patterns: readonly string[]): Promise<string[]> {
  const out = new Set<string>(patterns);
  for (const pattern of patterns) {
    const fwd = pattern.replace(/\\/g, '/');
    const wild = fwd.search(/[*?[]/);
    const literal = wild === -1 ? fwd : fwd.slice(0, wild);
    if (wild === -1) {
      // A literal path that is a link protects what it names, too.
      const real = await fs.realpath(fwd).then((r) => r.replace(/\\/g, '/'), () => null);
      if (real !== null && real !== fwd) out.add(real);
    }
    const cut = literal.lastIndexOf('/');
    if (cut <= 0) continue;
    // Resolve the deepest existing directory of the literal prefix.
    let dir = fwd.slice(0, cut);
    let rest = fwd.slice(cut);
    for (;;) {
      try {
        const real = (await fs.realpath(dir)).replace(/\\/g, '/');
        if (real !== dir) out.add(real + rest);
        break;
      } catch {
        const up = dir.lastIndexOf('/');
        if (up <= 0 || /^[A-Za-z]:$/.test(dir.slice(0, up))) break;
        rest = dir.slice(up) + rest;
        dir = dir.slice(0, up);
      }
    }
  }
  return [...out];
}

export interface JailOptions {
  /** Absolute directory relative paths resolve against. */
  readonly cwd: string;
  /** Allowed roots (absolute; resolved to real paths by `Jail.create`). */
  readonly roots: readonly string[];
  /** Protected path patterns (`~` expanded here). */
  readonly protectedPaths: readonly string[];
  /** Enforce the Windows alias checks even off Windows (tests). */
  readonly windowsChecks?: boolean;
}

/** A resolved set of allowed roots for one call. */
export class Jail {
  /** Real path of the session cwd. */
  readonly cwd: string;
  /** Real paths of the allowed roots; `roots[0]` is the session cwd. */
  readonly roots: readonly string[];
  readonly #protected: readonly string[];
  readonly #windowsChecks: boolean;

  private constructor(cwd: string, roots: readonly string[], protectedPaths: readonly string[], windowsChecks: boolean) {
    this.cwd = cwd;
    this.roots = roots;
    this.#protected = protectedPaths;
    this.#windowsChecks = windowsChecks;
  }

  static async create(opts: JailOptions): Promise<Jail> {
    if (!path.isAbsolute(opts.cwd)) throw new ToolError('tool-error', `session cwd is not absolute: ${opts.cwd}`);
    let cwd: string;
    try {
      cwd = await fs.realpath(opts.cwd);
    } catch (err) {
      throw new ToolError('tool-error', `session cwd ${opts.cwd} cannot be resolved: ${errnoCode(err) ?? String(err)}`);
    }
    const roots: string[] = [cwd];
    for (const root of opts.roots) {
      if (!path.isAbsolute(root)) continue;
      try {
        const real = await fs.realpath(root);
        if (!roots.includes(real)) roots.push(real);
      } catch {
        // A root that does not exist grants nothing.
      }
    }
    const protectedPaths = await withRealPrefixes(opts.protectedPaths.map((p) => expandTilde(p)));
    return new Jail(cwd, roots, protectedPaths, opts.windowsChecks ?? IS_WINDOWS);
  }

  /** Protected path patterns with `~` expanded. */
  get protectedPaths(): readonly string[] {
    return this.#protected;
  }

  /** The root that contains `abs`, or undefined. */
  rootOf(abs: string): string | undefined {
    return this.roots.find((root) => isInsideDir(root, abs));
  }

  /**
   * Resolves `input` (relative to the session cwd, `~` expanded) to an
   * absolute real path inside the roots, or throws `ToolError`.
   */
  async resolve(input: string): Promise<string> {
    return (await this.#resolve(input)).real;
  }

  /**
   * Like `resolve`, for a write or an edit: also refuses a path whose last
   * component is a symbolic link (write to its target instead), and refuses a
   * protected path whether it is named by the real path or by any link the
   * resolution went through.
   */
  async resolveForWrite(input: string): Promise<string> {
    const r = await this.#resolve(input);
    for (const p of [r.real, ...r.links]) this.assertWritable(p);
    // The directories the write will create are names it affects too.
    for (let dir = path.dirname(r.real); this.rootOf(dir) !== undefined && !(await lstatOrNull(dir)); dir = path.dirname(dir)) {
      this.assertWritable(dir);
    }
    if (r.finalIsLink) {
      throw new ToolError('invalid-args', `${input} is a symbolic link; write to its target (${r.real}) instead`);
    }
    return r.real;
  }

  /**
   * Like `resolve`, for the path grep and glob search: refuses a path whose
   * last component is a symbolic link, since search never follows links.
   */
  async resolveSearchRoot(input: string): Promise<string> {
    const r = await this.#resolve(input);
    if (r.finalIsLink) throw new ToolError('invalid-args', `${input} is a symbolic link; search its target (${r.real}) instead`);
    return r.real;
  }

  async #resolve(input: string): Promise<Resolution> {
    if (input.includes('\0')) throw new ToolError('invalid-args', 'path must not contain NUL characters');
    // Not trimmed: spaces are part of a file name.
    if (input.trim() === '') throw new ToolError('invalid-args', 'path must not be empty');
    if (this.#windowsChecks) {
      const problem = windowsPathProblem(input);
      if (problem) throw new ToolError('outside-workspace', `${input}: ${problem}`);
    }
    const expanded = expandTilde(input);
    let r: Resolution;
    try {
      r = await resolvePhysical(expanded, this.cwd);
    } catch (err) {
      if (err instanceof ToolError) throw err;
      const code = errnoCode(err);
      if (code === 'ENAMETOOLONG') throw new ToolError('invalid-args', `path is too long: ${input.slice(0, 120)}…`);
      if (code === 'ELOOP') throw new ToolError('outside-workspace', `${input}: too many symbolic links`);
      throw new ToolError('tool-error', `cannot resolve ${input}: ${code ?? String(err)}`);
    }
    if (this.rootOf(r.real) === undefined) {
      throw new ToolError('outside-workspace', `${input} resolves to ${r.real}, outside the workspace (${this.roots.join(', ')})`);
    }
    if (this.#windowsChecks) {
      const problem = windowsPathProblem(r.real);
      if (problem) throw new ToolError('outside-workspace', `${input}: ${problem}`);
    }
    return r;
  }

  /** Throws `protected-path` when `abs` must not be written or edited. */
  assertWritable(abs: string): void {
    if (isInsideGitDir(abs)) throw new ToolError('protected-path', `${abs} is inside a .git directory`);
    const hit = findMatchingPattern(abs, this.#protected);
    if (hit !== undefined) throw new ToolError('protected-path', `${abs} is a protected host policy path (${hit})`);
  }

  /** Path for diffs and messages: relative to the first root when inside it, else absolute. */
  displayPath(abs: string): string {
    const first = this.roots[0] ?? this.cwd;
    if (isInsideDir(first, abs)) {
      const rel = path.relative(first, abs);
      return rel === '' ? '.' : rel.split(path.sep).join('/');
    }
    return abs.split(path.sep).join('/');
  }
}
