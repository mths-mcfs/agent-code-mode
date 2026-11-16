import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Usage } from './record.ts';

const PriceSchema = z.object({
  input: z.number().nonnegative(),
  cachedInput: z.number().nonnegative(),
  cacheWrite5m: z.number().nonnegative().optional(),
  /** Cache writes with the 1-hour TTL, which Claude Code uses for its prompt cache. */
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

/** Cost in USD from usage (uncached input, cache reads, cache writes, output). Null when the model has no price. */
export function costFromUsage(pricing: Pricing, model: string, usage: Usage): number | null {
  const p = pricing.models[model];
  if (p === undefined) return null;
  const write = p.cacheWrite5m ?? p.input;
  return (usage.input * p.input + usage.cacheRead * p.cachedInput + usage.cacheCreation * write + usage.output * p.output) / 1_000_000;
}
