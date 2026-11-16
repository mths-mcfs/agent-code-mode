import { answerBlock, checkScope, Checks, squash } from '../checks.ts';
import type { VerifyContext, VerifyResult } from '../types.ts';

export async function verify(ctx: VerifyContext): Promise<VerifyResult> {
  const checks = new Checks();
  const block = answerBlock(ctx.answer, { lastLine: false });
  if (checks.check(block !== undefined, 'reply ends with an `ANSWER:` block') && block !== undefined) {
    const answer = squash(block);
    for (const sig of ctx.facts.signatures) checks.check(answer.includes(squash(sig.signature)), `answer contains ${sig.signature}`);
  }
  await checkScope(checks, ctx.workspace, ctx.initial);
  return checks.result();
}
