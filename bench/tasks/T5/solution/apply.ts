import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FixtureFacts } from '../../../fixture/generate.ts';

export async function applySolution(workspace: string, facts: FixtureFacts): Promise<string> {
  for (const rel of facts.renameFiles) {
    const file = path.join(workspace, ...rel.split('/'));
    const text = await readFile(file, 'utf8');
    await writeFile(file, text.replace(new RegExp(`\\b${facts.renameFrom}\\b`, 'g'), facts.renameTo));
  }
  return `Renamed ${facts.renameFrom} to ${facts.renameTo} in ${facts.renameFiles.length} files; tests pass.`;
}
