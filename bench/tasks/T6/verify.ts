import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { checkScope, Checks, readWorkspaceFile } from '../checks.ts';
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

export function isTwoSpaceJson(text: string, value: unknown): boolean {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  return body === JSON.stringify(value, null, 2);
}

export async function verify(ctx: VerifyContext): Promise<VerifyResult> {
  const checks = new Checks();
  const paid = new Set(ctx.facts.paidOrderFiles);
  const wrong: string[] = [];
  const touched: string[] = [];
  const badFormat: string[] = [];
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
    else if (now === undefined || !isTwoSpaceJson(now, current)) badFormat.push(file);
  }
  checks.check(badFormat.length === 0, badFormat.length === 0 ? 'paid orders kept as 2-space indented JSON' : `not 2-space indented JSON: ${badFormat.join(', ')}`);
  checks.check(wrong.length === 0, wrong.length === 0 ? `itemCount correct in all ${paid.size} paid orders, other fields kept` : `wrong or missing itemCount in: ${wrong.join(', ')}`);
  checks.check(touched.length === 0, touched.length === 0 ? 'orders that are not paid unchanged' : `orders that are not paid changed: ${touched.join(', ')}`);
  await checkScope(checks, ctx.workspace, ctx.initial, (f) => paid.has(f));
  return checks.result();
}
