import type { BigIntStats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { matchesPathPattern } from '../core/paths.js';
import type { WatchedChange, WatchedSnapshot, WatchedType } from '../core/types.js';
import { errnoCode } from './fs-ops.js';

/** Most entries one snapshot reads. Policy files are tens of entries, so thousands mean something else grew there. */
export const WATCH_MAX_ENTRIES = 5000;
/** Longest one snapshot may take: it runs before and after every bash call. */
export const WATCH_TIME_MS = 2000;

interface Entry {
  readonly type: WatchedType;
  readonly mode: number;
  /**
   * Everything compared. The change time moves with every write, chmod,
   * rename or link change and user code cannot set it, so a rewrite with the
   * same bytes and the same mtime still differs. A directory keeps only its
   * identity and mode: its entries are compared one by one.
   */
  readonly key: string;
  /** Symlink: the real path it resolves to (null when dangling). */
  readonly target?: string | null;
  readonly targetType?: WatchedType;
}

function typeOf(st: BigIntStats): WatchedType {
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isFile()) return 'file';
  if (st.isDirectory()) return 'dir';
  return 'other';
}

function statKey(st: BigIntStats): string {
  const type = typeOf(st);
  const id = `${type}:${st.mode}:${st.dev}:${st.ino}`;
  return type === 'dir' ? id : `${id}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
}

function missing(err: unknown): boolean {
  const code = errnoCode(err);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** The literal directory a pattern starts from, and how many levels below it can match (Infinity for `**`). */
function patternRoot(pattern: string): { readonly root: string; readonly depth: number } {
  const parts = pattern.split(/[\\/]/);
  const at = parts.findIndex((seg) => /[*?]/.test(seg));
  if (at === -1) return { root: pattern, depth: 0 };
  const root = parts.slice(0, at).join(path.sep) || path.sep;
  if (!path.isAbsolute(root) || path.dirname(root) === root) throw new Error(`watched pattern ${pattern} does not start with a literal directory`);
  const rest = parts.slice(at);
  return { root, depth: rest.some((seg) => seg.includes('**')) ? Number.POSITIVE_INFINITY : rest.length };
}

class Walk {
  readonly #deadline = Date.now() + WATCH_TIME_MS;
  readonly entries = new Map<string, Entry>();
  #count = 0;

  async entryAt(real: string): Promise<Entry | undefined> {
    let st: BigIntStats;
    try {
      st = await fs.lstat(real, { bigint: true });
    } catch (err) {
      if (missing(err)) return undefined;
      throw err;
    }
    if (++this.#count > WATCH_MAX_ENTRIES) throw new Error(`more than ${WATCH_MAX_ENTRIES} entries to check`);
    if (Date.now() > this.#deadline) throw new Error(`checking took more than ${WATCH_TIME_MS} ms`);
    const type = typeOf(st);
    if (type !== 'symlink') return { type, mode: Number(st.mode), key: statKey(st) };
    // A link is followed: what it points to is what the host reads. Its text, its target and the target's own fingerprint all count.
    const link = await fs.readlink(real);
    const target = await fs.realpath(real).catch((err: unknown) => (missing(err) ? null : Promise.reject(err)));
    const targetSt = target === null ? undefined : await fs.lstat(target, { bigint: true }).catch((err: unknown) => (missing(err) ? undefined : Promise.reject(err)));
    return {
      type,
      mode: Number(st.mode),
      key: `${statKey(st)}>${JSON.stringify(link)}>${target ?? ''}>${targetSt === undefined ? '' : statKey(targetSt)}`,
      target,
      ...(targetSt === undefined ? {} : { targetType: typeOf(targetSt) }),
    };
  }

  /** Records `shown` when it matches, then descends into it (a linked directory through its target) while `depth` allows. */
  async visit(shown: string, entry: Entry, pattern: string, depth: number, seen: ReadonlySet<string>): Promise<void> {
    if (matchesPathPattern(shown, pattern)) this.entries.set(shown, entry);
    if (depth <= 0) return;
    if (entry.type === 'dir') await this.#walk(shown, shown, pattern, depth, seen);
    else if (entry.targetType === 'dir' && typeof entry.target === 'string' && !seen.has(entry.target)) await this.#walk(shown, entry.target, pattern, depth, seen);
  }

  async #walk(shownDir: string, realDir: string, pattern: string, depth: number, seen: ReadonlySet<string>): Promise<void> {
    // Each directory is read once per path down from the pattern root, so a link back up the tree cannot loop.
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
      // On the last level only a matching name can count.
      if (depth === 1 && !matchesPathPattern(shown, pattern)) continue;
      const entry = await this.entryAt(path.join(realDir, name));
      if (entry !== undefined) await this.visit(shown, entry, pattern, depth - 1, inner);
    }
  }
}

class Snapshot implements WatchedSnapshot {
  readonly #entries: ReadonlyMap<string, Entry>;

  constructor(entries: ReadonlyMap<string, Entry>) {
    this.#entries = entries;
  }

  async changedSince(earlier: WatchedSnapshot, routine?: (change: WatchedChange) => Promise<boolean>): Promise<string[]> {
    if (!(earlier instanceof Snapshot)) throw new Error('the earlier snapshot was not taken by this tool runtime');
    const before = earlier.#entries;
    const out: string[] = [];
    for (const p of [...new Set([...before.keys(), ...this.#entries.keys()])].sort()) {
      const was = before.get(p);
      const now = this.#entries.get(p);
      if (was?.key === now?.key) continue;
      const change: WatchedChange = {
        path: p,
        ...(was === undefined ? {} : { before: { type: was.type, mode: was.mode } }),
        ...(now === undefined ? {} : { after: { type: now.type, mode: now.mode } }),
      };
      if (routine !== undefined && (await routine(change))) continue;
      out.push(p);
    }
    return out;
  }
}

/**
 * Fingerprints every entry matching `patterns`: type, mode, identity, size
 * and times; for a symlink also its text and target, and a linked directory
 * is walked through its target. Throws when it cannot finish.
 */
export async function snapshotWatched(patterns: readonly string[]): Promise<WatchedSnapshot> {
  const w = new Walk();
  for (const pattern of patterns) {
    const { root, depth } = patternRoot(pattern);
    const top = await w.entryAt(root);
    if (top !== undefined) await w.visit(root, top, pattern, depth, new Set());
  }
  return new Snapshot(w.entries);
}
