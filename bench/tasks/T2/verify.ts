import { checkScope, checkUnchanged, Checks, checkNodeTests } from '../checks.ts';
import type { VerifyContext, VerifyResult } from '../types.ts';

export async function verifyFix(ctx: VerifyContext, allowed: (file: string) => boolean): Promise<VerifyResult> {
  const checks = new Checks();
  await checkNodeTests(checks, ctx.workspace);
  const testFiles = [...ctx.initial.keys()].filter((f) => f.startsWith('test/'));
  await checkUnchanged(checks, ctx.workspace, ctx.initial, testFiles, 'test files');
  await checkScope(checks, ctx.workspace, ctx.initial, allowed);
  return checks.result();
}

export async function verify(ctx: VerifyContext): Promise<VerifyResult> {
  return verifyFix(ctx, (f) => f === 'src/lib/strings.js');
}
