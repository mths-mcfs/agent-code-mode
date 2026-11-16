import { z } from 'zod';

/**
 * The agent-code-mode `run` response as the server returns it (only the fields the bench reads).
 * `calls` is the full log (verbose, and every result before the compact view existed) or the
 * compact summary: counts by tool plus the denied calls.
 */
const Call = z.object({ tool: z.string(), decision: z.string().optional(), summary: z.string().optional(), reason: z.string().optional() }).passthrough();
const RunResultText = z.object({
  calls: z.union([
    z.array(Call),
    z.object({ total: z.number().int().nonnegative(), byTool: z.record(z.string(), z.number().int().nonnegative()), denied: z.array(z.union([Call, z.string()])).optional() }).passthrough(),
  ]),
}).passthrough();

export interface RunInnerCalls {
  readonly total: number;
  readonly byTool: Readonly<Record<string, number>>;
  /** One line per denied inner call. */
  readonly denials: readonly string[];
}

const denialLine = (c: z.infer<typeof Call>): string => `${c.tool} ${c.summary ?? ''}: ${c.reason ?? 'denied'}`.slice(0, 500);

/** Inner calls of one `run` response text; null when the text is not a run result. */
export function runInnerCalls(text: string): RunInnerCalls | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = RunResultText.safeParse(json);
  if (!parsed.success) return null;
  const calls = parsed.data.calls;
  if (Array.isArray(calls)) {
    const byTool: Record<string, number> = {};
    for (const c of calls) byTool[c.tool] = (byTool[c.tool] ?? 0) + 1;
    return { total: calls.length, byTool, denials: calls.filter((c) => c.decision === 'denied').map(denialLine) };
  }
  return { total: calls.total, byTool: calls.byTool, denials: (calls.denied ?? []).flatMap((c) => (typeof c === 'string' ? [] : [denialLine(c)])) };
}
