import { answerBlock, checkScope, Checks } from '../checks.ts';
import type { VerifyContext, VerifyResult } from '../types.ts';

/** The first three distinct customer names, in the order they appear in the answer. */
export function namedCustomers(text: string, customers: readonly string[]): string[] {
  const lower = text.toLowerCase();
  const hits: { name: string; at: number }[] = [];
  for (const name of customers) {
    const at = lower.indexOf(name.toLowerCase());
    if (at !== -1) hits.push({ name, at });
  }
  return hits.sort((a, b) => a.at - b.at).slice(0, 3).map((h) => h.name);
}

export async function verify(ctx: VerifyContext): Promise<VerifyResult> {
  const checks = new Checks();
  const expected = ctx.facts.customerTotals.slice(0, 3).map((c) => c.customer);
  const line = answerBlock(ctx.answer, { lastLine: true });
  if (checks.check(line !== undefined, 'reply ends with an `ANSWER: <c1>, <c2>, <c3>` line') && line !== undefined) {
    const got = namedCustomers(line, ctx.facts.customerTotals.map((c) => c.customer));
    checks.check(got.join('|') === expected.join('|'), `top 3 in order: ${expected.join(', ')} (got ${got.join(', ') || 'nothing'})`);
  }
  await checkScope(checks, ctx.workspace, ctx.initial);
  return checks.result();
}
