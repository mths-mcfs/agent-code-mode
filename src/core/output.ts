import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { errorMessage } from './errors.js';
import { ensureStateDir } from './state-dir.js';
import type { CallLogEntry, RunResult } from './types.js';

/** Largest text of a successful result. */
export const SUCCESS_CAP_CHARS = 30_000;
/** Largest text of an error result (Claude cuts the middle of long errors). */
export const ERROR_CAP_CHARS = 9_500;

export interface McpToolResponse {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError: boolean;
}

/** A combined diff up to this size is returned whole. */
export const DIFF_INLINE_CHARS = 1_500;
/** How much of a larger diff is returned; the whole result goes to a file. */
export const DIFF_SAMPLE_CHARS = 600;
/** Changed files listed before the rest is counted. */
export const CHANGED_FILES_SHOWN = 10;
/** Denied or failed calls listed in full before the rest is counted. */
export const FAILED_CALLS_SHOWN = 20;

export interface FormatOptions {
  /** Directory for overflow files. Created 0700 when needed. */
  readonly stateDir: string;
  /** Return every call and the whole diff instead of the compact view. */
  readonly verbose?: boolean;
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

function clipList<T>(items: readonly T[], shown: number): (T | string)[] {
  return items.length <= shown ? [...items] : [...items.slice(0, shown), `…[${items.length - shown} more]`];
}

/** The call log as counts; only calls that were denied or failed keep their entry (without the duration). */
export function summarizeCalls(calls: readonly CallLogEntry[]): Record<string, unknown> {
  const byTool: Record<string, number> = {};
  for (const c of calls) byTool[c.tool] = (byTool[c.tool] ?? 0) + 1;
  const failed = (decision: CallLogEntry['decision']): unknown[] =>
    clipList(
      calls.filter((c) => c.decision === decision).map(({ id, tool, summary, reason }) => ({ id, tool, summary, ...(reason === undefined ? {} : { reason }) })),
      FAILED_CALLS_SHOWN,
    );
  const denied = failed('denied');
  const errors = failed('error');
  return { total: calls.length, byTool, ...(denied.length > 0 ? { denied } : {}), ...(errors.length > 0 ? { errors } : {}) };
}

/**
 * The default view of a `RunResult`: what the model needs to go on, without
 * the parts that grow with the number of calls. The call log becomes counts
 * plus the denied and failed calls, a large diff is cut to its first lines
 * (`diffClipped`), a long list of changed files is cut, empty fields are left out.
 */
export function compactRunResult(result: RunResult): { readonly view: Record<string, unknown>; readonly diffClipped: boolean } {
  const { logs, calls, changedFiles, diff, warnings, ...rest } = result;
  const diffClipped = diff.length > DIFF_INLINE_CHARS;
  let shownDiff = diff;
  if (diffClipped) {
    const head = diff.slice(0, DIFF_SAMPLE_CHARS);
    const lineEnd = head.lastIndexOf('\n');
    shownDiff = `${lineEnd > 0 ? head.slice(0, lineEnd + 1) : head}…[${diff.length - (lineEnd > 0 ? lineEnd + 1 : head.length)} more chars; overflowPath has the whole result]`;
  }
  const view = {
    ...rest,
    ...(logs.length > 0 ? { logs } : {}),
    calls: summarizeCalls(calls),
    ...(changedFiles.length > 0 ? { changedFiles: clipList(changedFiles, CHANGED_FILES_SHOWN) } : {}),
    ...(shownDiff !== '' ? { diff: shownDiff } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
  return { view, diffClipped };
}

/**
 * Formats a `RunResult` as an MCP tool response: JSON text, `isError` when
 * the run failed. The text is the compact view (`compactRunResult`) unless
 * `verbose`. When the view cut the diff, or the text is above the cap, the
 * whole result is written to an overflow file (mode 0600) and the response
 * carries `overflowPath`; above the cap the text is a structurally truncated
 * preview.
 */
export async function formatRunResult(result: RunResult, opts: FormatOptions): Promise<McpToolResponse> {
  const isError = !result.ok;
  const cap = isError ? (opts.errorCap ?? ERROR_CAP_CHARS) : (opts.successCap ?? SUCCESS_CAP_CHARS);
  const compact = opts.verbose === true ? undefined : compactRunResult(result);
  const shown: unknown = compact ? compact.view : result;
  const text = safeStringify(shown);
  const fits = text.length <= cap;
  if (fits && compact?.diffClipped !== true) return { content: [{ type: 'text', text }], isError };

  const full = safeStringify(result);
  let extra: Record<string, unknown>;
  try {
    const overflowPath = await writeOverflow(opts.stateDir, full);
    extra = fits
      ? { overflowPath }
      : { overflowPath, note: `Result was ${full.length} chars; the full JSON is in the file at overflowPath (open it with the host's file reading tool).` };
  } catch (err) {
    extra = { note: `${fits ? 'The diff is cut' : `Result was ${full.length} chars`} and the whole result could not be saved: ${errorMessage(err)}` };
  }
  const noted = fits ? safeStringify({ ...compact?.view, ...extra }) : undefined;
  if (noted !== undefined && noted.length <= cap) return { content: [{ type: 'text', text: noted }], isError };
  return { content: [{ type: 'text', text: truncateStructurally(shown, cap, extra) }], isError };
}
