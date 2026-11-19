import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FixtureFacts } from '../../../fixture/generate.ts';
import { filesFrom } from '../../setup.ts';

export async function applySolution(workspace: string, _facts: FixtureFacts): Promise<string> {
  for (const [file, text] of filesFrom(path.join(import.meta.dirname, 'files'))) await writeFile(path.join(workspace, ...file.split('/')), text);
  return 'Two root causes. handleFailure (src/jobs/retry.js) released the slot before the backoff and the runner released it again, so every retry freed two slots. And only the success path freed the key: a job that gave up kept its rejected promise registered. Settling now frees the key on every path, and the slot is released once, by the runner.';
}
