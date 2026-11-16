import { answerSection, checkScope, Checks } from '../checks.ts';
import type { VerifyContext, VerifyResult } from '../types.ts';

export async function verify(ctx: VerifyContext): Promise<VerifyResult> {
  const checks = new Checks();
  const numbers = answerSection(ctx.answer).match(/-?\d+/g) ?? [];
  checks.check(numbers.length > 0 && numbers[0] === String(ctx.facts.retryLimit), `answer is ${ctx.facts.retryLimit} (got ${numbers[0] ?? 'nothing'})`);
  await checkScope(checks, ctx.workspace, ctx.initial);
  return checks.result();
}
