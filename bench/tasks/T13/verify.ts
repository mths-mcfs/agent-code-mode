import path from 'node:path';
import { checkScope, Checks, runHiddenTests, runNodeTests } from '../checks.ts';
import { filesFrom } from '../setup.ts';
import type { VerifyContext, VerifyResult } from '../types.ts';

export const T13_FILES = path.join(import.meta.dirname, 'files');
const HIDDEN = Object.fromEntries(filesFrom(path.join(import.meta.dirname, 'hidden')));

/** Hidden tests check every rule of the contract in src/jobs/queue.js with a fake clock, not just the two reported symptoms. */
export async function verify(ctx: VerifyContext): Promise<VerifyResult> {
  const checks = new Checks();
  const visible = await runNodeTests(ctx.workspace);
  checks.check(visible.ok && visible.fail === 0, `node --test passes (pass ${visible.pass}, fail ${visible.fail})`);
  const hidden = await runHiddenTests(ctx.workspace, HIDDEN);
  checks.check(hidden.ok && hidden.fail === 0 && hidden.pass > 0, `hidden tests pass (pass ${hidden.pass}, fail ${hidden.fail}${hidden.fail > 0 ? `: ${hidden.failed.join('; ')}` : ''})`);
  await checkScope(checks, ctx.workspace, ctx.initial, (f) => f.startsWith('src/jobs/'));
  return checks.result();
}
