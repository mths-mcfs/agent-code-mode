import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FixtureFacts } from '../../../fixture/generate.ts';
import { filesFrom } from '../../setup.ts';
import { T15_LEGACY } from '../verify.ts';

export async function applySolution(workspace: string, _facts: FixtureFacts): Promise<string> {
  for (const [file, text] of filesFrom(path.join(import.meta.dirname, 'files'))) await writeFile(path.join(workspace, ...file.split('/')), text);
  await rm(path.join(workspace, ...T15_LEGACY.split('/')));
  return 'Migrated the 36 modules under src/services/ that imported src/lib/legacy-http.js to `request` from src/lib/http.js (query, JSON body plus content-type, timeout in milliseconds, upper-case method, `body` instead of `data`, and a catch of HttpError where the code reads the status) and deleted src/lib/legacy-http.js. The vendored cache, its callers, the lint check and the tax table were not callers and are untouched.';
}
