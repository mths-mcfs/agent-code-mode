import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FixtureFacts } from '../../../fixture/generate.ts';
import { filesFrom } from '../../setup.ts';

export async function applySolution(workspace: string, _facts: FixtureFacts): Promise<string> {
  for (const [file, text] of filesFrom(path.join(import.meta.dirname, 'files'))) await writeFile(path.join(workspace, ...file.split('/')), text);
  return 'withUnitPrice (src/billing/lines.js) wrote the discounted price into the line it was given, so the discount changed the order items and every later invoice of the order was discounted again. It now returns a copy.';
}
