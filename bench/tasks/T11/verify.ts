import path from 'node:path';
import { checkScope, Checks, failedTests, runHiddenTests, runNodeTests } from '../checks.ts';
import { filesFrom } from '../setup.ts';
import type { VerifyContext, VerifyResult } from '../types.ts';

export const T11_FILES = path.join(import.meta.dirname, 'files');
const HIDDEN = Object.fromEntries(filesFrom(path.join(import.meta.dirname, 'hidden')));

/** Hidden tests cover each rule of the prompt: remainders and ties, -0, invalid input, exactness up to MAX_SAFE_INTEGER. */
export async function verify(ctx: VerifyContext): Promise<VerifyResult> {
  const checks = new Checks();
  const visible = await runNodeTests(ctx.workspace);
  checks.check(visible.ok && visible.fail === 0, `node --test passes (pass ${visible.pass}, fail ${visible.fail})`);
  const hidden = await runHiddenTests(ctx.workspace, HIDDEN);
  checks.check(hidden.ok && hidden.fail === 0 && hidden.pass > 0, `hidden tests pass (pass ${hidden.pass}, fail ${hidden.fail}${hidden.fail > 0 ? `: ${failedTests(hidden.output).join('; ')}` : ''})`);
  await checkScope(checks, ctx.workspace, ctx.initial, (f) => f === 'src/lib/split.js');
  return checks.result();
}
