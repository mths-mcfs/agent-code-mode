import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Tree } from '../fixture/generate.ts';
import { getFile, replaceOnce } from './checks.ts';

export const T2_FILE = 'src/lib/strings.js';
export const T2_FIX = 'return text.slice(0, max - ellipsis.length) + ellipsis;';
export const T2_BUG = 'return text.slice(0, max) + ellipsis;';

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

/** Files under `dir`, keyed by POSIX path relative to it (task setup files, hidden tests, solution files). */
export function filesFrom(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const abs = path.join(e.parentPath, e.name);
    out.set(path.relative(dir, abs).split(path.sep).join('/'), readFileSync(abs, 'utf8'));
  }
  return new Map([...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** A task setup that adds the files of `dir` to the fixture (failing loudly if one already exists). */
export function addFiles(dir: string): (tree: Tree) => Tree {
  return (tree) => {
    const out = new Map(tree);
    for (const [file, text] of filesFrom(dir)) {
      if (out.has(file)) throw new Error(`task file ${file} already exists in the fixture`);
      out.set(file, text);
    }
    return out;
  };
}
