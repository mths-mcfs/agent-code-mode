import path from 'node:path';
import { defaultSanitizeContext, sanitizeTree } from './lib/sanitize.ts';

/**
 * Re-sanitizes a results directory in place, without re-running anything:
 * `node bench/sanitize-results.ts bench/results/<date>`. Prints the files it changed.
 */
const dir = process.argv[2];
if (dir === undefined) {
  process.stderr.write('usage: node bench/sanitize-results.ts <results dir>\n');
  process.exitCode = 2;
} else {
  const repo = path.resolve(import.meta.dirname, '..');
  const changed = await sanitizeTree(path.resolve(dir), defaultSanitizeContext([{ path: repo, label: '<repo>' }, { path: process.execPath, label: 'node' }]));
  for (const f of changed) process.stdout.write(`${path.relative(process.cwd(), f)}\n`);
  process.stdout.write(`${changed.length} file(s) changed\n`);
}
