import { answerBlock, checkScope, Checks } from '../checks.ts';
import type { VerifyContext, VerifyResult } from '../types.ts';
import { generateLogs } from './logs.ts';

export async function verify(ctx: VerifyContext): Promise<VerifyResult> {
  const checks = new Checks();
  const { requestId, upstream } = generateLogs(ctx.facts.seed);
  const line = answerBlock(ctx.answer, { lastLine: true });
  if (checks.check(line !== undefined, 'reply ends with an `ANSWER: <request id>, <service>` line') && line !== undefined) {
    const parts = line.replace(/[`*]/g, '').split(',').map((p) => p.trim().toLowerCase());
    checks.check(parts[0] === requestId, `request id is ${requestId} (got ${parts[0] ?? 'nothing'})`);
    checks.check(parts[1] === upstream, `upstream service is ${upstream} (got ${parts[1] ?? 'nothing'})`);
  }
  await checkScope(checks, ctx.workspace, ctx.initial);
  return checks.result();
}
