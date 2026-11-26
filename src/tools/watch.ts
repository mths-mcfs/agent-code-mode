import type { BigIntStats, Dir } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { matchesPathPattern } from '../core/paths.js';
import type { WatchedChange, WatchedSnapshot, WatchedType } from '../core/types.js';
import { errnoCode } from './fs-ops.js';

export const WATCH_MAX_ENTRIES = 5000;
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

const WILD = /[*?]/;

/** The literal directory a pattern starts from, and the segments below it. */
function patternRoot(pattern: string): { readonly root: string; readonly rest: readonly string[] } {
  const parts = pattern.split(/[\\/]/);
  const at = parts.findIndex((seg) => WILD.test(seg));
  if (at === -1) return { root: pattern, rest: [] };
  const root = parts.slice(0, at).join(path.sep) || path.sep;
  if (!path.isAbsolute(root) || path.dirname(root) === root) throw new Error(`watched pattern ${pattern} does not start with a literal directory`);
  return { root, rest: parts.slice(at) };
}

class Walk {
  readonly #deadline = Date.now() + WATCH_TIME_MS;
  readonly entries = new Map<string, Entry>();
  #count = 0;

  /** Every name read counts, matching or not, so the limits bound the work and not only what is kept. */
  spend(): void {
    if (++this.#count > WATCH_MAX_ENTRIES) throw new Error(`more than ${WATCH_MAX_ENTRIES} entries to check`);
    this.#inTime();
  }

  #inTime(): void {
    if (Date.now() > this.#deadline) throw new Error(`checking took more than ${WATCH_TIME_MS} ms`);
  }

  async entryAt(real: string): Promise<Entry | undefined> {
    let st: BigIntStats;
    try {
      st = await fs.lstat(real, { bigint: true });
    } catch (err) {
      if (missing(err)) return undefined;
      throw err;
    }
    this.#inTime();
    const type = typeOf(st);
    if (type !== 'symlink') return { type, mode: Number(st.mode), key: statKey(st) };
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

  async visit(shown: string, entry: Entry, pattern: string, rest: readonly string[], ancestors: ReadonlySet<string>): Promise<void> {
    if (matchesPathPattern(shown, pattern)) this.entries.set(shown, entry);
    const [next, ...after] = rest;
    if (next === undefined) return;
    const realDir = entry.type === 'dir' ? shown : entry.targetType === 'dir' && typeof entry.target === 'string' ? entry.target : undefined;
    if (realDir === undefined || ancestors.has(realDir)) return;
    const inner = new Set(ancestors).add(realDir);
    // A literal segment names one entry: look it up instead of reading the whole directory.
    if (!WILD.test(next)) {
      this.spend();
      const child = await this.entryAt(path.join(realDir, next));
      if (child !== undefined) await this.visit(path.join(shown, next), child, pattern, after, inner);
      return;
    }
    // `**` matches any depth, so it stays for the levels below.
    const below = next.includes('**') ? rest : after;
    let dir: Dir;
    try {
      dir = await fs.opendir(realDir);
    } catch (err) {
      if (missing(err)) return;
      throw err;
    }
    for await (const { name } of dir) {
      this.spend();
      const child = path.join(shown, name);
      if (below.length === 0 && !matchesPathPattern(child, pattern)) continue;
      const entry = await this.entryAt(path.join(realDir, name));
      if (entry !== undefined) await this.visit(child, entry, pattern, below, inner);
    }
    this.#inTime();
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

export async function snapshotWatched(patterns: readonly string[]): Promise<WatchedSnapshot> {
  const w = new Walk();
  for (const pattern of patterns) {
    const { root, rest } = patternRoot(pattern);
    w.spend();
    const top = await w.entryAt(root);
    if (top !== undefined) await w.visit(root, top, pattern, rest, new Set());
  }
  return new Snapshot(w.entries);
}
