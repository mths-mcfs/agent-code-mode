import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FixtureFacts } from '../../../fixture/generate.ts';
import { filesFrom } from '../../setup.ts';

export async function applySolution(workspace: string, _facts: FixtureFacts): Promise<string> {
  for (const [file, text] of filesFrom(path.join(import.meta.dirname, 'files'))) await writeFile(path.join(workspace, ...file.split('/')), text);
  return 'Implemented the streaming CSV parser as a character state machine that keeps a pending quote or carriage return across chunks.';
}
