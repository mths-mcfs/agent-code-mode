import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FixtureFacts } from '../../../fixture/generate.ts';
import { replaceOnce } from '../../checks.ts';
import { T7_BUGS } from '../../setup.ts';

export async function applySolution(workspace: string, _facts: FixtureFacts): Promise<string> {
  for (const bug of T7_BUGS) {
    const file = path.join(workspace, ...bug.file.split('/'));
    await writeFile(file, replaceOnce(await readFile(file, 'utf8'), bug.bug, bug.fix, bug.file));
  }
  return 'Fixed the delimiter in parse.js, the zero-quantity check in validate.js and the discount sign in total.js.';
}
