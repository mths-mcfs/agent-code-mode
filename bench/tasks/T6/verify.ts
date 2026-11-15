import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { Checks, readWorkspaceFile } from '../checks.ts';
import type { VerifyContext, VerifyResult } from '../types.ts';

const ItemSchema = z.object({ qty: z.number() }).passthrough();
const OrderSchema = z.object({ items: z.array(ItemSchema) }).passthrough();

function parse(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export async function verify(ctx: VerifyContext): Promise<VerifyResult> {
  const checks = new Checks();
  const paid = new Set(ctx.facts.paidOrderFiles);
  const wrong: string[] = [];
  const touched: string[] = [];
  for (const file of ctx.facts.orderFiles) {
    const now = await readWorkspaceFile(ctx.workspace, file);
    const before = ctx.initial.get(file);
    if (!paid.has(file)) {
      if (now !== before) touched.push(file);
      continue;
    }
    const original = OrderSchema.safeParse(parse(before));
    const current = parse(now);
    if (!original.success) throw new Error(`fixture order ${file} does not parse`);
    const itemCount = original.data.items.reduce((n, item) => n + item.qty, 0);
    if (!isDeepStrictEqual(current, { ...original.data, itemCount })) wrong.push(file);
  }
  checks.check(wrong.length === 0, wrong.length === 0 ? `itemCount correct in all ${paid.size} paid orders, other fields kept` : `wrong or missing itemCount in: ${wrong.join(', ')}`);
  checks.check(touched.length === 0, touched.length === 0 ? 'orders that are not paid unchanged' : `orders that are not paid changed: ${touched.join(', ')}`);
  return checks.result();
}
