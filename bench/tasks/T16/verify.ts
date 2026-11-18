import { answerBlock, checkScope, Checks } from '../checks.ts';
import type { VerifyContext, VerifyResult } from '../types.ts';
import { dollars, t16Data, topRefunded } from './data.ts';

/** `(customer id, cents)` pairs of an `ANSWER:` line, in order: `C-0343 1673.00, C-0103 $876.90, ...`. */
export function answerPairs(line: string): { customerId: string; cents: number | null }[] {
  const out: { customerId: string; cents: number | null }[] = [];
  for (const m of line.matchAll(/(C-\d{4})\D*?\$?\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)/g)) {
    const id = m[1];
    const amount = m[2];
    if (id === undefined || amount === undefined) continue;
    const [whole = '0', frac = ''] = amount.replace(/,/g, '').split('.');
    out.push({ customerId: id, cents: Number(whole) * 100 + Number(frac.padEnd(2, '0')) });
  }
  return out;
}

export async function verify(ctx: VerifyContext): Promise<VerifyResult> {
  const checks = new Checks();
  const expected = topRefunded(t16Data(ctx.facts.seed), 3);
  const want = expected.map((e) => `${e.customerId} ${dollars(e.cents)}`).join(', ');
  const line = answerBlock(ctx.answer, { lastLine: true });
  if (checks.check(line !== undefined, 'reply ends with an `ANSWER: <id> <total>, <id> <total>, <id> <total>` line') && line !== undefined) {
    const got = answerPairs(line).slice(0, 3);
    const shown = got.map((g) => `${g.customerId} ${g.cents === null ? '?' : dollars(g.cents)}`).join(', ') || 'nothing';
    checks.check(got.map((g) => g.customerId).join('|') === expected.map((e) => e.customerId).join('|'), `top 3 customers in order: ${expected.map((e) => e.customerId).join(', ')} (got ${shown})`);
    checks.check(got.length === 3 && got.every((g, i) => g.cents === expected[i]?.cents), `totals: ${want} (got ${shown})`);
  }
  await checkScope(checks, ctx.workspace, ctx.initial);
  return checks.result();
}
