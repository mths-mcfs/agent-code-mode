import type { VerifyContext, VerifyResult } from '../types.ts';
import { verifyFix } from '../T2/verify.ts';

export async function verify(ctx: VerifyContext): Promise<VerifyResult> {
  return verifyFix(ctx, (f) => f.startsWith('src/pipeline/'));
}
