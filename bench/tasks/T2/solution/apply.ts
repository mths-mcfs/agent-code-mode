import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FixtureFacts } from '../../../fixture/generate.ts';
import { replaceOnce } from '../../checks.ts';
import { T2_BUG, T2_FIX } from '../../setup.ts';

export async function applySolution(workspace: string, _facts: FixtureFacts): Promise<string> {
  const file = path.join(workspace, 'src', 'lib', 'strings.js');
  await writeFile(file, replaceOnce(await readFile(file, 'utf8'), T2_BUG, T2_FIX, 'strings.js'));
  return 'Fixed truncate in src/lib/strings.js: it now keeps room for the ellipsis.';
}
