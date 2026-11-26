import { answerBlock, checkScope, Checks } from '../checks.ts';
import type { VerifyContext, VerifyResult } from '../types.ts';
import { dollars, t16Data, topRefunded } from './data.ts';

const CUSTOMER_ID = /C-\d{4}/g;
/** A total as the prompt asks for it: dollars, positive, exactly two decimals (thousands separators allowed). */
const TOTAL = /^(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}$/;

/**
 * `(customer id, cents)` pairs of an `ANSWER:` line, in order: `C-0343 1673.00, C-0103 $876.90, ...`. Each id
 * takes the text up to the next id; its total is the first number there, and `cents` is null unless that
 * number has the exact form (a sign, a third decimal or a missing one make it null).
 */
export function answerPairs(line: string): { customerId: string; cents: number | null }[] {
  const ids = [...line.matchAll(CUSTOMER_ID)];
  return ids.map((m, i) => {
    const segment = line.slice((m.index ?? 0) + m[0].length, ids[i + 1]?.index ?? line.length);
    const number = /([-+]?)\s*\$?\s*(\d[\d,]*(?:\.\d*)?)/.exec(segment);
    const amount = number?.[2]?.replace(/,$/, '');
    if (number === null || number[1] !== '' || amount === undefined || !TOTAL.test(amount)) return { customerId: m[0], cents: null };
    const [whole = '0', frac = '00'] = amount.replace(/,/g, '').split('.');
    return { customerId: m[0], cents: Number(whole) * 100 + Number(frac) };
  });
}

export async function verify(ctx: VerifyContext): Promise<VerifyResult> {
  const checks = new Checks();
  const expected = topRefunded(t16Data(ctx.facts.seed), 3);
  const want = expected.map((e) => `${e.customerId} ${dollars(e.cents)}`).join(', ');
  const line = answerBlock(ctx.answer, { lastLine: true });
  if (checks.check(line !== undefined, 'reply ends with an `ANSWER: <id> <total>, <id> <total>, <id> <total>` line') && line !== undefined) {
    const got = answerPairs(line);
    const shown = got.map((g) => `${g.customerId} ${g.cents === null ? '?' : dollars(g.cents)}`).join(', ') || 'nothing';
    checks.check(got.map((g) => g.customerId).join('|') === expected.map((e) => e.customerId).join('|'), `top 3 customers in order: ${expected.map((e) => e.customerId).join(', ')} (got ${shown})`);
    checks.check(got.length === 3, `exactly three customers (got ${got.length})`);
    checks.check(got.length === 3 && got.every((g, i) => g.cents === expected[i]?.cents), `totals: ${want}, each positive with two decimals (got ${shown})`);
  }
  await checkScope(checks, ctx.workspace, ctx.initial);
  return checks.result();
}
