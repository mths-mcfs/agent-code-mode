import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Usage } from './record.ts';

const PriceSchema = z.object({
  input: z.number().nonnegative(),
  cachedInput: z.number().nonnegative(),
  cacheWrite5m: z.number().nonnegative().optional(),
  cacheWrite1h: z.number().nonnegative().optional(),
  output: z.number().nonnegative(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  source: z.string().url(),
});
export const PricingSchema = z.object({ currency: z.literal('USD'), unit: z.literal('per 1M tokens'), note: z.string(), models: z.record(z.string(), PriceSchema) });
export type Pricing = z.infer<typeof PricingSchema>;

export const PRICING_FILE = path.join(import.meta.dirname, '..', 'pricing.json');

export function loadPricing(file: string = PRICING_FILE): Pricing {
  return PricingSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

export function costFromUsage(pricing: Pricing, model: string, usage: Usage): number | null {
  const p = pricing.models[model];
  if (p === undefined) return null;
  const write5m = p.cacheWrite5m ?? p.input;
  const write1h = usage.cacheCreation1h ?? 0;
  if (write1h > 0 && p.cacheWrite1h === undefined) return null;
  const writes = write1h * (p.cacheWrite1h ?? 0) + Math.max(0, usage.cacheCreation - write1h) * write5m;
  return (usage.input * p.input + usage.cacheRead * p.cachedInput + writes + usage.output * p.output) / 1_000_000;
}
