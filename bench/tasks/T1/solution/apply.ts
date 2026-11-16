import type { FixtureFacts } from '../../../fixture/generate.ts';

export async function applySolution(_workspace: string, facts: FixtureFacts): Promise<string> {
  return `The value is set in config/app.json.\nANSWER: ${facts.retryLimit}`;
}
