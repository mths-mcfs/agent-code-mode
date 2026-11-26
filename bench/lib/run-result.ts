import { z } from 'zod';

/**
 * The agent-code-mode `run` response as the server returns it (only the fields the bench reads).
 * `calls` is the full log (verbose, and every result before the compact view existed) or the
 * compact summary: counts by tool plus the denied calls. A long multi-line string result comes in
 * a second content block after the JSON one; hosts hand the blocks over joined.
 */
const Call = z.object({ tool: z.string(), decision: z.string().optional(), summary: z.string().optional(), reason: z.string().optional() }).passthrough();
/** Denied calls that share a tool and a reason, when the response had to group them to fit its cap. */
const Group = z.object({ tool: z.string(), reason: z.string().optional(), count: z.number().int().positive(), first: z.string() }).passthrough();
const denialLine = (c: z.infer<typeof Call>): string => `${c.tool} ${c.summary ?? ''}: ${c.reason ?? 'denied'}`.slice(0, 500);
const groupLine = (g: z.infer<typeof Group>): string => `${g.tool} ${g.first}: ${g.reason ?? 'denied'} (${g.count} calls)`.slice(0, 500);
const RunResultText = z.object({
  calls: z.union([
    z.array(Call),
    z.object({ total: z.number().int().nonnegative(), byTool: z.record(z.string(), z.number().int().nonnegative()), denied: z.array(z.union([Group.transform(groupLine), Call.transform(denialLine), z.string().transform(() => null)])).optional() }).passthrough(),
  ]),
}).passthrough();

export interface RunInnerCalls {
  readonly total: number;
  readonly byTool: Readonly<Record<string, number>>;
  /** One line per denied inner call, or per group of them when the response grouped them. */
  readonly denials: readonly string[];
}

/** End index of the JSON object `text` starts with, or -1. */
function leadingObjectEnd(text: string): number {
  if (!text.startsWith('{')) return -1;
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** The JSON value of a response's first block: the whole text, or the object it starts with when a text block follows. */
function firstBlockJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const end = leadingObjectEnd(text);
    if (end === -1) return undefined;
    try {
      return JSON.parse(text.slice(0, end));
    } catch {
      return undefined;
    }
  }
}

/** Inner calls of one `run` response text (its content blocks joined); null when the text is not a run result. */
export function runInnerCalls(text: string): RunInnerCalls | null {
  const json = firstBlockJson(text);
  if (json === undefined) return null;
  const parsed = RunResultText.safeParse(json);
  if (!parsed.success) return null;
  const calls = parsed.data.calls;
  if (Array.isArray(calls)) {
    const byTool: Record<string, number> = {};
    for (const c of calls) byTool[c.tool] = (byTool[c.tool] ?? 0) + 1;
    return { total: calls.length, byTool, denials: calls.filter((c) => c.decision === 'denied').map(denialLine) };
  }
  return { total: calls.total, byTool: calls.byTool, denials: (calls.denied ?? []).filter((line) => line !== null) };
}
