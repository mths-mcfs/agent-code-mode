import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadPricing } from '../lib/pricing.ts';

const RESULTS = path.join(import.meta.dirname, '..', 'results', '2026-11-16');

const ModelUsage = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadInputTokens: z.number(),
  cacheCreationEphemeral5mInputTokens: z.number(),
  cacheCreationEphemeral1hInputTokens: z.number(),
  costUSD: z.number(),
});
const ResultEvent = z.object({ type: z.literal('result'), total_cost_usd: z.number(), modelUsage: z.record(z.string(), ModelUsage) });

function claudeTranscripts(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...claudeTranscripts(p));
    else if (e.name === 'transcript.jsonl') out.push(p);
  }
  return out;
}

describe('Claude cost reported by the host', () => {
  it('equals pricing.json with cache writes priced by TTL (Claude Code writes 1-hour cache entries)', () => {
    const pricing = loadPricing();
    const files = claudeTranscripts(path.join(RESULTS, 'claude'));
    expect(files).toHaveLength(48);
    for (const file of files) {
      const result = readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((line) => ResultEvent.safeParse(JSON.parse(line)))
        .find((r) => r.success)?.data;
      if (result === undefined) throw new Error(`${file}: no result event`);
      let total = 0;
      for (const [model, u] of Object.entries(result.modelUsage)) {
        const p = pricing.models[model];
        if (p?.cacheWrite5m === undefined || p.cacheWrite1h === undefined) throw new Error(`${model} has no cache-write prices`);
        const cost =
          (u.inputTokens * p.input + u.outputTokens * p.output + u.cacheReadInputTokens * p.cachedInput + u.cacheCreationEphemeral5mInputTokens * p.cacheWrite5m + u.cacheCreationEphemeral1hInputTokens * p.cacheWrite1h) /
          1_000_000;
        expect(cost).toBeCloseTo(u.costUSD, 9);
        total += cost;
      }
      expect(total).toBeCloseTo(result.total_cost_usd, 9);
    }
  });
});
