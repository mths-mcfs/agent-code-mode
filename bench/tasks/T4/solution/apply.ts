import type { FixtureFacts } from '../../../fixture/generate.ts';

export async function applySolution(_workspace: string, facts: FixtureFacts): Promise<string> {
  const top = facts.customerTotals.slice(0, 3);
  return `ANSWER: ${top.map((t) => `${t.customer} (${(t.totalCents / 100).toFixed(2)})`).join(', ')}`;
}
