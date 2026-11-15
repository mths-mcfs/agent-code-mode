import type { FixtureFacts } from '../../../fixture/generate.ts';

export async function applySolution(_workspace: string, facts: FixtureFacts): Promise<string> {
  return `ANSWER:\n${facts.signatures.map((s) => `- ${s.signature}`).join('\n')}`;
}
