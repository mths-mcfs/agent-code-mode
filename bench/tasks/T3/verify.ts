import { answerSection, Checks, squash } from '../checks.ts';
import type { VerifyContext, VerifyResult } from '../types.ts';

export async function verify(ctx: VerifyContext): Promise<VerifyResult> {
  const checks = new Checks();
  const answer = squash(answerSection(ctx.answer));
  for (const sig of ctx.facts.signatures) checks.check(answer.includes(squash(sig.signature)), `answer contains ${sig.signature}`);
  return checks.result();
}
