import type { Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { errorMessage } from '../core/errors.js';
import { ownWriteMark, ownWriteSince } from '../core/own-writes.js';
import { matchesPathPattern } from '../core/paths.js';
import type { WatchedChange } from '../core/types.js';
import { errnoCode, sha256 } from './fs-ops.js';

/**
 * Detect-and-report net for the paths agent-code-mode protects: the watched
 * set (host policy files, the server state dir) is fingerprinted before and
 * after each `bash` call and compared. It never blocks or restores anything;
 * a difference becomes a warning. Changes agent-code-mode made itself (see
 * `own-writes.ts`) are not reported.
 */

/** Most entries one snapshot holds: the policy files and the state dir are tens of entries, so thousands mean something else grew there. */
export const WATCH_MAX_ENTRIES = 5000;
/** Bytes hashed per snapshot at most (any one file included): bounds the read cost; a file past it is named as checked by metadata only. */
export const WATCH_HASH_TOTAL_BYTES = 64 * 1024 * 1024;
/** Time one snapshot may take: it runs before every bash call and must not noticeably delay it. */
export const WATCH_TIME_MS = 2000;
/** Paths named in one warning; the rest are counted. */
export const WATCH_REPORT_PATHS = 20;

/** Why a snapshot could not be completed. */
export class WatchError extends Error {}

interface Meta {
  readonly type: 'file' | 'dir' | 'symlink' | 'other';
  readonly mode: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ino: number;
  readonly sha256?: string;
  /** A regular file whose content was not hashed (budget spent): compared by metadata only. */
  readonly unhashed?: true;
}

interface Entry extends Meta {
  /** Symlink: its text. */
  readonly link?: string;
  /** Symlink resolved at a baseline: the target it resolved to then (null: dangling). Kept while the link text stays the same. */
  readonly target?: string | null;
  /** That target's fingerprint (null: missing). */
  readonly targetMeta?: Meta | null;
}

export interface WatchSnapshot {
  readonly entries: ReadonlyMap<string, Entry>;
  /** Own-write log position when the snapshot started. */
  readonly mark: number;
}

export interface SnapshotOptions {
  /**
   * A baseline (the first snapshot, or the one before a bash call): links
   * not yet resolved are resolved now. Otherwise only links resolved at an
   * earlier baseline are followed, to the target they had then.
   */
  readonly baseline?: boolean;
  /** Hash budget (tests). */
  readonly hashTotalBytes?: number;
  /** Paths not looked at, nor anything below them (scratch files and saved originals change with every run). */
  readonly exclude?: readonly string[];
}

interface Walk {
  readonly deadline: number;
  readonly hashBudget: number;
  readonly baseline: boolean;
  readonly previous: WatchSnapshot | undefined;
  readonly out: Map<string, Entry>;
  readonly exclude: ReadonlySet<string>;
  hashed: number;
  count: number;
}

function typeOf(st: Stats): Meta['type'] {
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isFile()) return 'file';
  if (st.isDirectory()) return 'dir';
  return 'other';
}

function missing(err: unknown): boolean {
  const code = errnoCode(err);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function metaOf(p: string, st: Stats, w: Walk): Promise<Meta> {
  const type = typeOf(st);
  // A directory's size and time change with any entry in it; its entries are compared one by one instead.
  const base = { type, mode: st.mode, size: type === 'dir' ? 0 : st.size, mtimeMs: type === 'dir' ? 0 : st.mtimeMs, ino: st.ino };
  if (type !== 'file') return base;
  if (w.hashed + st.size > w.hashBudget) return { ...base, unhashed: true };
  w.hashed += st.size;
  try {
    return { ...base, sha256: sha256(await fs.readFile(p)) };
  } catch (err) {
    if (missing(err)) return { ...base, unhashed: true };
    throw err;
  }
}

/** The literal directory a pattern starts from, and how deep below it matches can be (Infinity for `**`). */
function patternRoot(pattern: string): { readonly root: string; readonly depth: number } {
  const parts = pattern.split(process.platform === 'win32' ? /[\\/]/ : '/');
  const at = parts.findIndex((seg) => /[*?[]/.test(seg));
  if (at === -1) return { root: pattern, depth: 0 };
  const root = parts.slice(0, at).join(path.sep);
  if (!path.isAbsolute(root) || root === path.parse(root).root) throw new WatchError(`watched pattern ${pattern} does not start with a literal directory`);
  const rest = parts.slice(at);
  return { root, depth: rest.some((s) => s.includes('**')) ? Number.POSITIVE_INFINITY : rest.length };
}

/**
 * The entry at `shown` (the watched name), read at `real` (the same path, or
 * inside a linked directory's captured target).
 */
async function entryOf(shown: string, real: string, w: Walk): Promise<Entry | undefined> {
  let st: Stats;
  try {
    st = await fs.lstat(real);
  } catch (err) {
    if (missing(err)) return undefined;
    throw err;
  }
  w.count += 1;
  if (w.count > WATCH_MAX_ENTRIES) throw new WatchError(`more than ${WATCH_MAX_ENTRIES} protected entries`);
  if (Date.now() > w.deadline) throw new WatchError(`taking a snapshot of the protected paths took more than ${WATCH_TIME_MS} ms`);
  const meta = await metaOf(real, st, w);
  if (meta.type !== 'symlink') return meta;
  const link = await fs.readlink(real);
  const before = w.previous?.entries.get(shown);
  let target: string | null | undefined;
  if (before?.link === link && before.target !== undefined) target = before.target;
  else if (w.previous === undefined || w.baseline) target = await fs.realpath(real).catch((err: unknown) => (missing(err) ? null : Promise.reject(err)));
  // Not resolved at a baseline: a link that appeared mid-comparison is never followed.
  if (target === undefined) return { ...meta, link };
  if (target === null) return { ...meta, link, target: null, targetMeta: null };
  let targetMeta: Meta | null = null;
  try {
    targetMeta = await metaOf(target, await fs.lstat(target), w);
  } catch (err) {
    if (!missing(err)) throw err;
  }
  return { ...meta, link, target, targetMeta };
}

/** Records `entry` when it matches, and descends into directories, also a linked one through its captured target. */
async function visit(shown: string, entry: Entry, pattern: string, depth: number, w: Walk, seen: Set<string>): Promise<void> {
  if (matchesPathPattern(shown, pattern)) w.out.set(shown, entry);
  if (depth <= 0) return;
  if (entry.type === 'dir') await walk(shown, shown, pattern, depth, w, seen);
  else if (entry.type === 'symlink' && typeof entry.target === 'string' && entry.targetMeta?.type === 'dir' && !seen.has(entry.target)) {
    await walk(shown, entry.target, pattern, depth, w, seen);
  }
}

async function walk(shownDir: string, realDir: string, pattern: string, depth: number, w: Walk, seen: Set<string>): Promise<void> {
  // A linked directory is read once per pattern: a link back up the tree cannot loop.
  const inner = new Set(seen).add(realDir);
  let names: string[];
  try {
    names = await fs.readdir(realDir);
  } catch (err) {
    if (missing(err)) return;
    throw err;
  }
  for (const name of names.sort()) {
    const shown = path.join(shownDir, name);
    if (w.exclude.has(shown)) continue;
    const entry = await entryOf(shown, path.join(realDir, name), w);
    if (entry !== undefined) await visit(shown, entry, pattern, depth - 1, w, inner);
  }
}

/**
 * Fingerprints every entry matching the watched patterns: type, mode, size,
 * time, inode and a content hash (within the budget); for a symlink, its text
 * and, once resolved at a baseline, the target it had then and that target's
 * fingerprint; a linked directory is walked through that target. Throws
 * `WatchError` (limits) or the file-system error when the snapshot cannot be
 * completed.
 */
export async function snapshotWatched(patterns: readonly string[], previous?: WatchSnapshot, opts: SnapshotOptions = {}): Promise<WatchSnapshot> {
  const mark = ownWriteMark();
  const w: Walk = {
    deadline: Date.now() + WATCH_TIME_MS,
    hashBudget: opts.hashTotalBytes ?? WATCH_HASH_TOTAL_BYTES,
    baseline: opts.baseline === true,
    previous,
    out: new Map(),
    exclude: new Set(opts.exclude),
    hashed: 0,
    count: 0,
  };
  for (const pattern of patterns) {
    const { root, depth } = patternRoot(pattern);
    const top = await entryOf(root, root, w);
    if (top !== undefined) await visit(root, top, pattern, depth, w, new Set());
  }
  return { entries: w.out, mark };
}

function sameMeta(a: Meta | null | undefined, b: Meta | null | undefined): boolean {
  if (a == null || b == null) return a === b;
  // A hash on one side only (budget spent on the other) compares by metadata; `uncheckedWatched` names it.
  const content = a.sha256 === undefined || b.sha256 === undefined || a.sha256 === b.sha256;
  return a.type === b.type && a.mode === b.mode && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino && content;
}

function sameEntry(a: Entry | undefined, b: Entry | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (!sameMeta(a, b) || a.link !== b.link) return false;
  // A target known on one side only (resolved at a later baseline) is no change.
  if (a.target === undefined || b.target === undefined) return true;
  return a.target === b.target && sameMeta(a.targetMeta, b.targetMeta);
}

/** Whether agent-code-mode's own operations since `mark` leave `p` exactly as it is now (type, mode, inode, content). */
async function explained(p: string, now: Entry | undefined, mark: number): Promise<boolean> {
  const op = ownWriteSince(p, mark);
  if (op === undefined) return false;
  if (op.kind === 'absent' || op.kind === 'tree-absent') return now === undefined;
  if (now === undefined || now.mode !== op.mode || now.ino !== op.ino) return false;
  if (op.kind === 'dir') return now.type === 'dir';
  if (now.type !== 'file') return false;
  if (now.sha256 !== undefined) return now.sha256 === op.sha256;
  try {
    return sha256(await fs.readFile(p)) === op.sha256;
  } catch {
    return false;
  }
}

function side(e: Entry | undefined): WatchedChange['before'] {
  return e === undefined ? undefined : { type: e.type, mode: e.mode };
}

/**
 * Paths that differ between two snapshots and that neither agent-code-mode's
 * own operations nor the host's `routine` filter explain.
 */
export async function changedWatched(before: WatchSnapshot, after: WatchSnapshot, routine?: (change: WatchedChange) => Promise<boolean>): Promise<string[]> {
  const out: string[] = [];
  const keys = [...new Set([...before.entries.keys(), ...after.entries.keys()])].sort();
  for (const p of keys) {
    const was = before.entries.get(p);
    const now = after.entries.get(p);
    if (sameEntry(was, now)) continue;
    if (await explained(p, now, before.mark)) continue;
    const b = side(was);
    const a = side(now);
    if (routine !== undefined && (await routine({ path: p, ...(b ? { before: b } : {}), ...(a ? { after: a } : {}) }))) continue;
    out.push(p);
  }
  return out;
}

/** Files present and alike on both sides whose content was not compared (hash budget spent): never passed over silently. */
export function uncheckedWatched(before: WatchSnapshot, after: WatchSnapshot): string[] {
  const out: string[] = [];
  for (const [p, now] of after.entries) {
    const was = before.entries.get(p);
    if (was === undefined || !sameEntry(was, now)) continue;
    const blind = (e: Entry): boolean => e.unhashed === true || e.targetMeta?.unhashed === true;
    if (blind(was) || blind(now)) out.push(p);
  }
  return out.sort();
}

/** The warning for changed paths, short. */
export function describeChanges(paths: readonly string[]): string {
  const shown = paths.slice(0, WATCH_REPORT_PATHS).join(', ');
  return paths.length > WATCH_REPORT_PATHS ? `${shown} and ${paths.length - WATCH_REPORT_PATHS} more` : shown;
}

/** Message of a failed comparison. */
export function incompleteReason(err: unknown): string {
  return err instanceof WatchError ? err.message : errorMessage(err);
}
