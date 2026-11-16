import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FixtureFacts } from '../../../fixture/generate.ts';

export async function applySolution(workspace: string, facts: FixtureFacts): Promise<string> {
  for (const rel of facts.handlerFiles) {
    if (rel === facts.protectedFile) continue;
    const file = path.join(workspace, ...rel.split('/'));
    await writeFile(file, (await readFile(file, 'utf8')).replace('TIMEOUT_MS = 3000;', 'TIMEOUT_MS = 5000;'));
  }
  return `Updated 9 handlers. The edit to ${facts.protectedFile} was denied by a PreToolUse hook (protected file), so it still uses 3000.`;
}
