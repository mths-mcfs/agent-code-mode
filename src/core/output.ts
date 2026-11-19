import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { errorMessage } from './errors.js';
import { ensureStateDir } from './state-dir.js';
import type { RunResult } from './types.js';

/** Largest text of a successful result. */
export const SUCCESS_CAP_CHARS = 30_000;
/** Largest text of an error result (Claude cuts the middle of long errors). */
export const ERROR_CAP_CHARS = 9_500;

export interface McpToolResponse {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError: boolean;
}

export interface FormatOptions {
  /** Directory for overflow files. Created 0700 when needed. */
  readonly stateDir: string;
  readonly successCap?: number;
  readonly errorCap?: number;
}

interface Limits {
  readonly str: number;
  readonly arr: number;
  readonly depth: number;
}

const LEVELS: readonly Limits[] = [
  { str: 8_000, arr: 500, depth: 12 },
  { str: 2_000, arr: 100, depth: 10 },
  { str: 600, arr: 40, depth: 8 },
  { str: 200, arr: 15, depth: 6 },
  { str: 80, arr: 6, depth: 4 },
  { str: 30, arr: 3, depth: 3 },
];

function shrink(value: unknown, limits: Limits, depth: number): unknown {
  if (typeof value === 'string') {
    return value.length <= limits.str ? value : `${value.slice(0, limits.str)}…[${value.length - limits.str} more chars]`;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= limits.depth) return Array.isArray(value) ? `[array of ${value.length} items]` : '[object]';
  if (Array.isArray(value)) {
    const kept = value.slice(0, limits.arr).map((item) => shrink(item, limits, depth + 1));
    if (value.length > limits.arr) kept.push(`…[${value.length - limits.arr} more items]`);
    return kept;
  }
  const out: Record<string, unknown> = {};
  const entries = Object.entries(value);
  for (const [key, item] of entries.slice(0, limits.arr)) out[key] = shrink(item, limits, depth + 1);
  if (entries.length > limits.arr) out['…'] = `[${entries.length - limits.arr} more keys]`;
  return out;
}

/** JSON text of `value`; values JSON cannot represent become strings instead of throwing. */
export function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, v: unknown) => {
      if (typeof v === 'bigint') return v.toString();
      if (v !== null && typeof v === 'object') {
        if (seen.has(v)) return '[circular]';
        seen.add(v);
      }
      return v;
    }) ?? 'null';
  } catch (err) {
    return JSON.stringify({ unserializable: errorMessage(err) });
  }
}

/**
 * Shrinks a JSON-compatible value until its JSON text fits `cap`, keeping the
 * structure valid: long strings and arrays are cut with explicit markers.
 * `extra` fields are added at the top level untouched.
 */
export function truncateStructurally(value: unknown, cap: number, extra: Record<string, unknown> = {}): string {
  const plain: unknown = JSON.parse(safeStringify(value));
  const base = plain !== null && typeof plain === 'object' && !Array.isArray(plain) ? plain : { value: plain };
  for (const limits of LEVELS) {
    const shrunk = shrink(base, limits, 0);
    const text = safeStringify({ ...(shrunk !== null && typeof shrunk === 'object' ? shrunk : { value: shrunk }), ...extra, truncated: true });
    if (text.length <= cap) return text;
  }
  // Last resort: only the essentials, clipped to fit.
  const essentials: Record<string, unknown> = { ...extra, truncated: true };
  if ('ok' in base) essentials['ok'] = base.ok;
  if ('error' in base) essentials['error'] = shrink(base.error, { str: 200, arr: 3, depth: 2 }, 0);
  let text = safeStringify(essentials);
  if (text.length > cap) text = safeStringify({ truncated: true, ...('ok' in base ? { ok: base.ok } : {}) });
  return text.length <= cap ? text : '{"truncated":true}';
}

async function writeOverflow(stateDir: string, text: string): Promise<string> {
  const dir = await ensureStateDir(stateDir);
  const file = path.join(dir, `run-${Date.now()}-${randomBytes(6).toString('hex')}.json`);
  await writeFile(file, text, { mode: 0o600, flag: 'wx' });
  return file;
}

/**
 * Formats a `RunResult` as an MCP tool response: compact JSON text, `isError`
 * when the run failed. Results above the cap are written whole to an
 * overflow file (mode 0600) and replaced by a structurally truncated preview
 * carrying `overflowPath`.
 */
export async function formatRunResult(result: RunResult, opts: FormatOptions): Promise<McpToolResponse> {
  const isError = !result.ok;
  const cap = isError ? (opts.errorCap ?? ERROR_CAP_CHARS) : (opts.successCap ?? SUCCESS_CAP_CHARS);
  const full = safeStringify(result);
  if (full.length <= cap) return { content: [{ type: 'text', text: full }], isError };

  let extra: Record<string, unknown>;
  try {
    const overflowPath = await writeOverflow(opts.stateDir, full);
    extra = { overflowPath, note: `Result was ${full.length} chars; the full JSON is in the file at overflowPath (open it with the host's file reading tool).` };
  } catch (err) {
    extra = { note: `Result was ${full.length} chars and could not be saved: ${errorMessage(err)}` };
  }
  return { content: [{ type: 'text', text: truncateStructurally(result, cap, extra) }], isError };
}
