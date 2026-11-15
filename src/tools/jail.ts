/*
 * `realpathWithSuffix`, `isInsideDir` and `windowsPathProblem` are adapted
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
 * Resolution follows Turnpack's `realpathWithSuffix`: the deepest part of the
 * path that exists is found with `lstat` (not `exists`, which follows links
 * and would call a dangling symlink "missing"), resolved with `realpath`, and
 * the missing rest is joined back. A dangling link is followed by hand so the
 * boundary check sees where a write would really land.
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

/** Real path of `target`, which may not exist yet. */
export async function realpathWithSuffix(target: string, hops = 0): Promise<string> {
  if (hops > MAX_LINK_HOPS) throw new ToolError('outside-workspace', `too many symbolic links while resolving ${target}`);
  let cursor = path.resolve(target);
  const trailing: string[] = [];
  let stat = await lstatOrNull(cursor);
  while (!stat) {
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new ToolError('outside-workspace', `no existing ancestor for ${target}`);
    trailing.push(path.basename(cursor));
    cursor = parent;
    stat = await lstatOrNull(cursor);
  }
  let realBase: string;
  try {
    realBase = await fs.realpath(cursor);
  } catch (err) {
    if (!stat.isSymbolicLink()) throw err;
    // Dangling link: follow it by hand so the check sees its destination.
    const linkTarget = await fs.readlink(cursor);
    const parentReal = await fs.realpath(path.dirname(cursor));
    realBase = await realpathWithSuffix(path.resolve(parentReal, linkTarget), hops + 1);
  }
  return trailing.length === 0 ? realBase : path.resolve(realBase, ...trailing.reverse());
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
  if (p.startsWith('~/') || (IS_WINDOWS && p.startsWith('~\\'))) return path.join(home, p.slice(2));
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
    const protectedPaths = opts.protectedPaths.map((p) => expandTilde(p));
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
    if (input.includes('\0')) throw new ToolError('invalid-args', 'path must not contain NUL characters');
    const trimmed = input.trim();
    if (trimmed === '') throw new ToolError('invalid-args', 'path must not be empty');
    if (this.#windowsChecks) {
      const problem = windowsPathProblem(trimmed);
      if (problem) throw new ToolError('outside-workspace', `${trimmed}: ${problem}`);
    }
    const expanded = expandTilde(trimmed);
    const candidate = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(this.cwd, expanded);
    let real: string;
    try {
      real = await realpathWithSuffix(candidate);
    } catch (err) {
      if (err instanceof ToolError) throw err;
      const code = errnoCode(err);
      if (code === 'ENAMETOOLONG') throw new ToolError('invalid-args', `path is too long: ${trimmed.slice(0, 120)}…`);
      if (code === 'ELOOP') throw new ToolError('outside-workspace', `${trimmed}: too many symbolic links`);
      throw new ToolError('tool-error', `cannot resolve ${trimmed}: ${code ?? String(err)}`);
    }
    if (this.rootOf(real) === undefined) {
      throw new ToolError('outside-workspace', `${trimmed} resolves to ${real}, outside the workspace (${this.roots.join(', ')})`);
    }
    if (this.#windowsChecks) {
      const problem = windowsPathProblem(real);
      if (problem) throw new ToolError('outside-workspace', `${trimmed}: ${problem}`);
    }
    return real;
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
