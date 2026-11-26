import { errorMessage } from './errors.js';
import type { CallLogEntry, RunResult } from './types.js';

/** Response budget, well below Claude Code's MAX_MCP_OUTPUT_TOKENS (25,000). */
export const RESPONSE_CAP_TOKENS = 10_000;
export const SUCCESS_CAP_CHARS = RESPONSE_CAP_TOKENS * 4;
/** Largest text of an error response (Claude cuts the middle of long errors). */
export const ERROR_CAP_CHARS = 9_500;
export const DIFF_INLINE_CHARS = 1_500;
export const DIFF_STAT_FILES = 10;
export const TEXT_BLOCK_MIN_CHARS = 200;
export const RESULT_IN_NEXT_BLOCK = '[in the next text block]';

export interface McpToolResponse {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError: boolean;
}

export interface OverflowSink {
  put(text: string): string | undefined;
}

export interface FormatOptions {
  readonly overflow?: OverflowSink;
  readonly verbose?: boolean;
  readonly successCap?: number;
  readonly errorCap?: number;
}

/** JSON text of `value`; values JSON cannot represent become strings instead of throwing. */
export function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return (
      JSON.stringify(value, (_key, v: unknown) => {
        if (typeof v === 'bigint') return v.toString();
        if (v !== null && typeof v === 'object') {
          if (seen.has(v)) return '[circular]';
          seen.add(v);
        }
        return v;
      }) ?? 'null'
    );
  } catch (err) {
    return JSON.stringify({ unserializable: errorMessage(err) });
  }
}

type FailedCall = Pick<CallLogEntry, 'id' | 'tool' | 'summary' | 'reason'>;

interface FailedGroup {
  readonly tool: string;
  readonly reason?: string;
  readonly count: number;
  /** Summary of each call, with a marker counting the ones left out. */
  readonly calls: readonly string[];
}

export interface CompactCalls {
  readonly total: number;
  readonly byTool: Record<string, number>;
  readonly denied?: readonly (FailedCall | FailedGroup | string)[];
  readonly errors?: readonly (FailedCall | FailedGroup | string)[];
}

export function summarizeCalls(calls: readonly CallLogEntry[]): CompactCalls {
  const byTool: Record<string, number> = {};
  for (const c of calls) byTool[c.tool] = (byTool[c.tool] ?? 0) + 1;
  const pick = (decision: CallLogEntry['decision']): FailedCall[] =>
    calls.filter((c) => c.decision === decision).map(({ id, tool, summary, reason }) => ({ id, tool, summary, ...(reason === undefined ? {} : { reason }) }));
  const denied = pick('denied');
  const errors = pick('error');
  return { total: calls.length, byTool, ...(denied.length > 0 ? { denied } : {}), ...(errors.length > 0 ? { errors } : {}) };
}

export interface DiffStat {
  readonly files: Record<string, string>;
  readonly moreFiles?: number;
  readonly total: string;
}

/**
 * Line counts per file of a combined unified diff. Hunk lines are counted from
 * the hunk header, so a removed line that starts with `--` is not taken for a
 * file header.
 */
/** The `b/` name of `diff --git <a-name> <b-name>`, the header of an empty new file (it has no hunk). */
function gitHeaderNewName(rest: string): string {
  if (rest.endsWith('"')) {
    const start = rest.lastIndexOf(' "b/');
    if (start !== -1) return rest.slice(start + 1);
  }
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest[half] === ' ' && rest.slice(2, half) === rest.slice(half + 3)) return rest.slice(half + 1);
  const start = rest.lastIndexOf(' b/');
  return start === -1 ? rest : rest.slice(start + 1);
}

function unquote(name: string): string {
  if (!(name.startsWith('"') && name.endsWith('"') && name.length >= 2)) return name;
  return name.slice(1, -1).replace(/\\(["\\])/g, '$1');
}

export function diffStat(diff: string): DiffStat {
  const counts = new Map<string, { added: number; removed: number }>();
  let current: { added: number; removed: number } | undefined;
  let oldLeft = 0;
  let newLeft = 0;
  let oldName = '';
  for (const line of diff.split('\n')) {
    if (current && (oldLeft > 0 || newLeft > 0)) {
      if (line.startsWith('+')) (current.added++, newLeft--);
      else if (line.startsWith('-')) (current.removed++, oldLeft--);
      else if (!line.startsWith('\\')) (oldLeft--, newLeft--);
    } else if (line.startsWith('--- ')) {
      oldName = line.slice(4);
    } else if (line.startsWith('+++ ') || line.startsWith('diff --git ')) {
      const newName = line.startsWith('+++ ') ? line.slice(4) : gitHeaderNewName(line.slice(11));
      const name = unquote(newName === '/dev/null' ? oldName : newName).replace(/^[ab]\//, '');
      current = counts.get(name) ?? { added: 0, removed: 0 };
      counts.set(name, current);
    } else {
      const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
      if (hunk) {
        oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
        newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      }
    }
  }
  const entries = [...counts];
  const added = entries.reduce((n, [, c]) => n + c.added, 0);
  const removed = entries.reduce((n, [, c]) => n + c.removed, 0);
  return {
    files: Object.fromEntries(entries.slice(0, DIFF_STAT_FILES).map(([name, c]) => [name, `+${c.added} -${c.removed}`])),
    ...(entries.length > DIFF_STAT_FILES ? { moreFiles: entries.length - DIFF_STAT_FILES } : {}),
    total: `${entries.length} file${entries.length === 1 ? '' : 's'} +${added} -${removed}`,
  };
}

interface View {
  ok: boolean;
  result?: unknown;
  error?: unknown;
  logs?: readonly string[];
  calls: CompactCalls | readonly CallLogEntry[];
  changedFiles?: readonly string[];
  diff?: string;
  diffStat?: DiffStat;
  warnings?: readonly string[];
  rolledBack?: unknown;
  overflow?: { readonly id: string; readonly chars: number };
  truncated?: true;
}

function textOf(view: View): { json: string; second?: string } {
  const r = view.result;
  if (typeof r === 'string' && r.length > TEXT_BLOCK_MIN_CHARS && r.includes('\n')) return { json: safeStringify({ ...view, result: RESULT_IN_NEXT_BLOCK }), second: r };
  return { json: safeStringify(view) };
}

function response(view: View, isError: boolean): { readonly out: McpToolResponse; readonly chars: number } {
  const { json, second } = textOf(view);
  const content: McpToolResponse['content'] = [{ type: 'text', text: json }];
  if (second !== undefined) content.push({ type: 'text', text: second });
  return { out: { content, isError }, chars: json.length + (second?.length ?? 0) };
}

function headTail(text: string, budget: number, marker: (cut: number) => string): string {
  if (text.length <= budget) return text;
  const room = Math.max(0, budget - marker(text.length).length);
  const head = Math.floor(room * 0.6);
  const tail = room - head;
  return `${text.slice(0, head)}${marker(text.length - head - tail)}${text.slice(text.length - tail)}`;
}

export function formatRunResult(result: RunResult, opts: FormatOptions = {}): McpToolResponse {
  const isError = !result.ok;
  const cap = isError ? (opts.errorCap ?? ERROR_CAP_CHARS) : (opts.successCap ?? SUCCESS_CAP_CHARS);
  const verbose = opts.verbose === true;
  const { ok, logs, calls, changedFiles, diff, warnings, rolledBack } = result;
  const bigDiff = !verbose && diff.length > DIFF_INLINE_CHARS;
  const view: View = {
    ok,
    ...('result' in result ? { result: result.result } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(logs.length > 0 ? { logs } : {}),
    calls: verbose ? calls : summarizeCalls(calls),
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    ...(diff === '' ? {} : bigDiff ? { diffStat: diffStat(diff) } : { diff }),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(rolledBack ? { rolledBack } : {}),
  };
  const whole = response(view, isError);
  if (!bigDiff && whole.chars <= cap) return whole.out;

  const full = safeStringify(result);
  const id = opts.overflow?.put(full);
  const kept: View = id === undefined ? view : { ...view, overflow: { id, chars: full.length } };
  const noted = response(kept, isError);
  if (noted.chars <= cap) return noted.out;
  return capped(kept, summarizeCalls(calls), cap, isError);
}

function cutList<T>(list: readonly T[] | undefined, keep: number, where: string): readonly (T | string)[] | undefined {
  if (list === undefined || list.length <= keep) return list;
  return [...list.slice(0, keep), `…[${list.length - keep} more${where}]`];
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[${text.length - max} chars cut]`;
}

function clipStrings<T>(value: T, max: number): T {
  if (typeof value === 'string') return clip(value, max) as T;
  if (Array.isArray(value)) return value.map((v: unknown) => clipStrings(v, max)) as T;
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clipStrings(v, max)])) as T;
  return value;
}

function grouped(list: CompactCalls['denied'], textMax: number, perGroup: number, keep: number, where: string): CompactCalls['denied'] {
  if (list === undefined) return undefined;
  const groups = new Map<string, { tool: string; reason?: string; count: number; summaries: string[] }>();
  for (const c of list) {
    if (typeof c === 'string' || !('id' in c)) continue;
    const key = JSON.stringify([c.tool, c.reason ?? null]);
    const g = groups.get(key) ?? { tool: clip(c.tool, textMax), ...(c.reason === undefined ? {} : { reason: clip(c.reason, textMax) }), count: 0, summaries: [] };
    g.count++;
    g.summaries.push(clip(c.summary, textMax));
    groups.set(key, g);
  }
  const all: FailedGroup[] = [...groups.values()].map(({ summaries, ...g }) => ({ ...g, calls: cutList(summaries, perGroup, where) ?? [] }));
  if (all.length <= keep) return all;
  const left = all.slice(keep);
  const n = left.reduce((a, g) => a + g.count, 0);
  return [...all.slice(0, keep), `…[${left.length} more reasons (${n} calls)${where}]`];
}

function capped(view: View, compact: CompactCalls, cap: number, isError: boolean): McpToolResponse {
  const where = view.overflow ? ' in readOverflow' : '';
  const marker = (n: number): string => `\n…[${n} chars cut${view.overflow ? `; readOverflow(${JSON.stringify(view.overflow.id)}) has the whole result` : ''}]\n`;
  const { result, logs, diff, ...envelope } = view;
  const base: View = { ...envelope, calls: compact, truncated: true };
  const resultText = result === undefined ? undefined : typeof result === 'string' ? result : safeStringify(result);
  const logText = logs?.join('\n');
  const bulk = [resultText, logText, diff].reduce((n, t) => n + (t?.length ?? 0), 0);
  const envelopeMax = cap - Math.min(bulk, Math.floor(cap / 4)) - 200;

  const withCalls = (calls: CompactCalls, lists: number, textMax: number): View => {
    const clipped = textMax === Infinity ? base : clipStrings(base, textMax);
    return {
      ...clipped,
      calls,
      ...(clipped.changedFiles ? { changedFiles: cutList(clipped.changedFiles, lists, where) } : {}),
      ...(clipped.warnings ? { warnings: cutList(clipped.warnings, lists, where) } : {}),
    };
  };
  const groupedCalls = (textMax: number, perGroup: number, keep: number): CompactCalls => ({
    ...compact,
    ...(compact.denied ? { denied: grouped(compact.denied, textMax, perGroup, keep, where) } : {}),
    ...(compact.errors ? { errors: grouped(compact.errors, textMax, perGroup, keep, where) } : {}),
  });
  const ladder: (() => View)[] = [
    () => withCalls(compact, Infinity, Infinity),
    () => withCalls(groupedCalls(Infinity, Infinity, Infinity), Infinity, Infinity),
    ...[200, 20, 0].map((n) => () => withCalls(groupedCalls(Infinity, Infinity, Infinity), n, Infinity)),
    ...[100, 10, 1].map((per) => () => withCalls(groupedCalls(200, per, Infinity), 0, 200)),
    ...[1000, 100, 10, 1, 0].map((k) => () => withCalls(groupedCalls(200, 1, k), 0, 200)),
  ];
  let env: View = { ok: view.ok, calls: { total: compact.total, byTool: {} }, ...(view.overflow ? { overflow: view.overflow } : {}), truncated: true };
  for (const step of ladder) {
    const candidate = step();
    if (safeStringify(candidate).length <= envelopeMax) {
      env = candidate;
      break;
    }
  }

  const parts = [resultText, logText, diff];
  for (let scale = 1; scale > 0.01; scale *= 0.8) {
    let room = Math.max(0, Math.floor((cap - safeStringify(env).length - 200) * scale));
    const shares = parts.map(() => 0);
    const bySize = parts.map((t, i) => [t?.length ?? 0, i] as const).filter(([n]) => n > 0).sort((x, y) => x[0] - y[0]);
    bySize.forEach(([n, i], k) => {
      shares[i] = Math.min(n, Math.floor(room / (bySize.length - k)));
      room -= shares[i] ?? 0;
    });
    const shown = resultText === undefined ? undefined : headTail(resultText, shares[0] ?? 0, marker);
    const second = shown === undefined || (shown === resultText && typeof result !== 'string') ? undefined : shown;
    const { ok, error, ...rest } = env;
    const out: View = {
      ok,
      ...(shown === undefined ? {} : { result: second === undefined ? result : RESULT_IN_NEXT_BLOCK }),
      ...(error === undefined ? {} : { error }),
      ...(logText === undefined ? {} : { logs: headTail(logText, shares[1] ?? 0, marker).split('\n') }),
      ...rest,
      ...(diff === undefined ? {} : { diff: headTail(diff, shares[2] ?? 0, marker) }),
    };
    const json = safeStringify(out);
    if (json.length + (second?.length ?? 0) <= cap) {
      return { content: [{ type: 'text', text: json }, ...(second === undefined ? [] : [{ type: 'text' as const, text: second }])], isError };
    }
  }
  return { content: [{ type: 'text', text: safeStringify(env) }], isError };
}
