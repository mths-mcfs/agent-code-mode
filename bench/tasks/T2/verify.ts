import { checkScope, checkUnchanged, Checks, runNodeTests } from '../checks.ts';
import type { VerifyContext, VerifyResult } from '../types.ts';

export async function verifyFix(ctx: VerifyContext, allowed: (file: string) => boolean): Promise<VerifyResult> {
  const checks = new Checks();
  const tests = await runNodeTests(ctx.workspace);
  checks.check(tests.ok && tests.fail === 0, `node --test passes (pass ${tests.pass}, fail ${tests.fail})`);
  const testFiles = [...ctx.initial.keys()].filter((f) => f.startsWith('test/'));
  await checkUnchanged(checks, ctx.workspace, ctx.initial, testFiles, 'test files');
  await checkScope(checks, ctx.workspace, ctx.initial, allowed);
  return checks.result();
}

export async function verify(ctx: VerifyContext): Promise<VerifyResult> {
  return verifyFix(ctx, (f) => f === 'src/lib/strings.js');
}
