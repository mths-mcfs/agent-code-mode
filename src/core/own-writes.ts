import { lstat } from 'node:fs/promises';
import path from 'node:path';

/**
 * What agent-code-mode itself did to files the bash watch fingerprints (its
 * state dir: transaction journals, consumed hook context records), kept in
 * memory for the whole process. A change the watch sees is not reported when
 * the latest operation recorded here since the snapshot explains it exactly:
 * the same type, mode, inode and content hash as just after the operation,
 * or the path gone as expected. Nothing is excluded by directory.
 */
export type OwnWrite =
  | { readonly kind: 'file'; readonly sha256: string; readonly mode: number; readonly ino: number }
  | { readonly kind: 'dir'; readonly mode: number; readonly ino: number }
  | { readonly kind: 'absent' }
  /** The path and everything under it removed. */
  | { readonly kind: 'tree-absent' };

/** Operations kept; older ones are dropped (a change they would explain is then reported). */
const MAX_OWN_WRITES = 10_000;

let seq = 0;
const log: { readonly seq: number; readonly path: string; readonly op: OwnWrite }[] = [];

/** Records a file agent-code-mode just wrote with content hash `sha256`, as it is on disk now (mode, inode). */
export async function recordOwnFile(p: string, sha256: string): Promise<void> {
  const st = await lstat(p);
  recordOwnWrite(p, { kind: 'file', sha256, mode: st.mode, ino: st.ino });
}

/** Records a directory agent-code-mode just created, as it is on disk now. */
export async function recordOwnDir(p: string): Promise<void> {
  const st = await lstat(p);
  recordOwnWrite(p, { kind: 'dir', mode: st.mode, ino: st.ino });
}

/** Records an operation agent-code-mode just did. */
export function recordOwnWrite(p: string, op: OwnWrite): void {
  seq += 1;
  log.push({ seq, path: path.resolve(p), op });
  if (log.length > MAX_OWN_WRITES) log.splice(0, log.length - MAX_OWN_WRITES);
}

/** A point in the log: operations after it are the ones a later comparison may use. */
export function ownWriteMark(): number {
  return seq;
}

/** The latest operation since `mark` on `p` or on a removed tree that holds it. */
export function ownWriteSince(p: string, mark: number): OwnWrite | undefined {
  const target = path.resolve(p);
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e === undefined || e.seq <= mark) break;
    if (e.path === target) return e.op;
    if (e.op.kind === 'tree-absent' && target.startsWith(e.path + path.sep)) return e.op;
  }
  return undefined;
}
