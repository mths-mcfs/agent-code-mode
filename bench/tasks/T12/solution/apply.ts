import type { FixtureFacts } from '../../../fixture/generate.ts';
import { generateLogs } from '../logs.ts';

export async function applySolution(_workspace: string, facts: FixtureFacts): Promise<string> {
  const { requestId, upstream } = generateLogs(facts.seed);
  return `grep found the one PAYMENT_TIMEOUT error in logs/payments, then its request id in the caller's log.\nANSWER: ${requestId}, ${upstream}`;
}
