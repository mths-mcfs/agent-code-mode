import type { Tree } from '../fixture/generate.ts';
import { getFile, replaceOnce } from './checks.ts';

/** T2: one-line bug that makes exactly one test fail. */
export const T2_FILE = 'src/lib/strings.js';
export const T2_FIX = 'return text.slice(0, max - ellipsis.length) + ellipsis;';
export const T2_BUG = 'return text.slice(0, max) + ellipsis;';

/** T7: three bugs behind five failing pipeline tests. */
export const T7_BUGS: readonly { readonly file: string; readonly fix: string; readonly bug: string }[] = [
  { file: 'src/pipeline/parse.js', fix: "line.split(';')", bug: "line.split(',')" },
  { file: 'src/pipeline/validate.js', fix: 'line.qty > 0', bug: 'line.qty >= 0' },
  { file: 'src/pipeline/total.js', fix: 'return gross - discount;', bug: 'return gross + discount;' },
];

export function injectBugs(tree: Tree, bugs: readonly { readonly file: string; readonly fix: string; readonly bug: string }[]): Tree {
  const out = new Map(tree);
  for (const b of bugs) out.set(b.file, replaceOnce(getFile(out, b.file), b.fix, b.bug, b.file));
  return out;
}
