import { answerBlock, checkScope, Checks } from '../checks.ts';
import type { VerifyContext, VerifyResult } from '../types.ts';

export async function verify(ctx: VerifyContext): Promise<VerifyResult> {
  const checks = new Checks();
  const line = answerBlock(ctx.answer, { lastLine: true });
  if (checks.check(line !== undefined, 'reply ends with an `ANSWER: <value>` line') && line !== undefined) {
    const numbers = line.match(/-?\d+/g) ?? [];
    checks.check(numbers.length === 1 && numbers[0] === String(ctx.facts.retryLimit), `answer is ${ctx.facts.retryLimit} (got ${line.trim() || 'nothing'})`);
  }
  await checkScope(checks, ctx.workspace, ctx.initial);
  return checks.result();
}
