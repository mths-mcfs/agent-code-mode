import type { FixtureFacts } from '../../../fixture/generate.ts';
import { dollars, t16Data, topRefunded } from '../data.ts';

/** The answer the orders server's data gives (the server's tools are not needed: the reference reads the generator). */
export async function applySolution(_workspace: string, facts: FixtureFacts): Promise<string> {
  const top = topRefunded(t16Data(facts.seed), 3);
  return `Totals of succeeded refunds dated in Q2 2026.\nANSWER: ${top.map((t) => `${t.customerId} ${dollars(t.cents)}`).join(', ')}`;
}
