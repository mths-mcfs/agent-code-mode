import { errorMessage } from './errors.js';
import type { CallLogEntry, RunResult } from './types.js';

/** Response budget in tokens, well below Claude Code's MAX_MCP_OUTPUT_TOKENS (25,000). */
export const RESPONSE_CAP_TOKENS = 10_000;
/** Characters per token used to turn the token budget into characters. */
export const CHARS_PER_TOKEN = 4;
/** Largest text (all content blocks together) of a successful result. */
export const SUCCESS_CAP_CHARS = RESPONSE_CAP_TOKENS * CHARS_PER_TOKEN;
/** Largest text of an error result (Claude cuts the middle of long errors). */
export const ERROR_CAP_CHARS = 9_500;

/** A combined diff up to this size is returned whole; a larger one becomes `diffStat`. */
export const DIFF_INLINE_CHARS = 1_500;
/** Files listed in `diffStat` before the rest is counted. */
export const DIFF_STAT_FILES = 10;
/** A successful run that changed more files than this reports their number; the list goes to the overflow. */
export const CHANGED_FILES_INLINE = 10;
/** A string result with a line break and more characters than this comes as plain text in a second content block. */
export const TEXT_BLOCK_MIN_CHARS = 200;
/** Value of `result` in the JSON block when the result is in the second block. */
export const RESULT_IN_NEXT_BLOCK = '[in the next text block]';

export interface McpToolResponse {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError: boolean;
}

/** Where the whole result goes when a response cuts something. */
export interface OverflowSink {
  /** Keeps `text` and returns its id, or undefined when it could not be kept. */
  put(text: string): string | undefined;
}

export interface FormatOptions {
  /** Keeps what the response cuts, for `readOverflow`. Without it nothing is kept. */
  readonly overflow?: OverflowSink;
  /** Return the log of every call and the whole diff instead of the compact view. */
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

type FailedCall = Pick<CallLogEntry, 'id' | 'tool' | 'summary'> & { readonly reason?: string };

/** Compact call log: counts plus every denied and failed call. */
export interface CompactCalls {
  readonly total: number;
  readonly byTool: Record<string, number>;
  readonly denied?: FailedCall[];
  readonly errors?: FailedCall[];
}

/** Denied or failed calls that share a tool and a reason: how many, and the summary of the first. */
export interface FailedGroup {
  readonly tool: string;
  readonly reason?: string;
  readonly count: number;
  readonly first: string;
}

/** Reason and first-call summary length in groups when even the groups do not fit. */
export const GROUP_TEXT_CHARS = 200;

/** `calls` grouped by (tool, reason) in order of first appearance, with exact counts. */
export function groupFailed(calls: readonly FailedCall[]): FailedGroup[] {
  const groups = new Map<string, { tool: string; reason?: string; count: number; first: string }>();
  for (const c of calls) {
    const key = JSON.stringify([c.tool, c.reason ?? null]);
    const g = groups.get(key);
    if (g) g.count++;
    else groups.set(key, { tool: c.tool, ...(c.reason === undefined ? {} : { reason: c.reason }), count: 1, first: c.summary });
  }
  return [...groups.values()];
}

/**
 * The call log as counts plus every denied and failed call (without the
 * duration). A reason that repeats `errorMessage` (the run's error, already in
 * the result) is cut to what it adds: its source prefix, or nothing.
 */
export function summarizeCalls(calls: readonly CallLogEntry[], errorMessage?: string): CompactCalls {
  const byTool: Record<string, number> = {};
  for (const c of calls) byTool[c.tool] = (byTool[c.tool] ?? 0) + 1;
  const shown = (reason: string | undefined): string | undefined => {
    if (reason === undefined || errorMessage === undefined || errorMessage === '') return reason;
    if (reason === errorMessage) return undefined;
    if (reason.endsWith(`: ${errorMessage}`)) return `${reason.slice(0, -errorMessage.length - 2)} (see error)`;
    return reason;
  };
  const failed = (decision: CallLogEntry['decision']): FailedCall[] =>
    calls
      .filter((c) => c.decision === decision)
      .map(({ id, tool, summary, reason }) => {
        const r = shown(reason);
        return { id, tool, summary, ...(r === undefined ? {} : { reason: r }) };
      });
  const denied = failed('denied');
  const errors = failed('error');
  return { total: calls.length, byTool, ...(denied.length > 0 ? { denied } : {}), ...(errors.length > 0 ? { errors } : {}) };
}

/** Lines added and removed by a unified diff. */
export interface DiffStat {
  /** `+added -removed` of the first `DIFF_STAT_FILES` files, in diff order. */
  readonly files: Record<string, string>;
  /** Files changed beyond those listed. */
  readonly moreFiles?: number;
  /** `N files +added -removed` over the whole diff. */
  readonly total: string;
}

/**
 * Per-file line counts of a combined unified diff (as the tool runtime writes
 * it: `--- a/x`, `+++ b/x`, `@@ -a,b +c,d @@` hunks). Hunk lines are counted
 * from the hunk header, so a removed line that starts with `--` is not taken
 * for a file header.
 */
export function diffStat(diff: string, shown: number = DIFF_STAT_FILES): DiffStat {
  const counts = new Map<string, { added: number; removed: number }>();
  let current: { added: number; removed: number } | undefined;
  let oldLeft = 0;
  let newLeft = 0;
  let oldName: string | undefined;
  for (const line of diff.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith('\\')) continue;
      if (current && line.startsWith('+')) (current.added++, newLeft--);
      else if (current && line.startsWith('-')) (current.removed++, oldLeft--);
      else (oldLeft--, newLeft--);
      continue;
    }
    if (line.startsWith('--- ')) {
      oldName = line.slice(4);
      continue;
    }
    if (line.startsWith('+++ ')) {
      const newName = line.slice(4);
      const name = (newName === '/dev/null' ? (oldName ?? newName) : newName).replace(/^[ab]\//, '');
      current = counts.get(name) ?? { added: 0, removed: 0 };
      counts.set(name, current);
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
    }
  }
  const entries = [...counts.entries()];
  let added = 0;
  let removed = 0;
  for (const [, c] of entries) (added += c.added, removed += c.removed);
  const files = Object.fromEntries(entries.slice(0, shown).map(([name, c]) => [name, `+${c.added} -${c.removed}`]));
  return {
    files,
    ...(entries.length > shown ? { moreFiles: entries.length - shown } : {}),
    total: `${entries.length} file${entries.length === 1 ? '' : 's'} +${added} -${removed}`,
  };
}

/** Whether the view of `result` reports the number of changed files instead of listing them. */
function countsChangedFiles(result: RunResult, verbose: boolean): boolean {
  return result.ok && !verbose && result.changedFiles.length > CHANGED_FILES_INLINE;
}

/**
 * The view of a `RunResult` the model gets: empty fields left out and, unless
 * `verbose`, the call log as counts plus every denied and failed call, and a
 * diff above `DIFF_INLINE_CHARS` as `diffStat`. A successful run that changed
 * more than `CHANGED_FILES_INLINE` files reports `changedCount` and only the
 * total of the `diffStat`, unless `listFiles` (the list has nowhere else to
 * go). `cut` is true when the view dropped something that only the whole
 * result has.
 */
export function runResultView(result: RunResult, verbose = false, listFiles = false): { readonly view: Record<string, unknown>; readonly cut: boolean } {
  const { logs, calls, changedFiles, diff, warnings, ...rest } = result;
  const bigDiff = !verbose && diff.length > DIFF_INLINE_CHARS;
  const counted = !listFiles && countsChangedFiles(result, verbose);
  const stat = bigDiff ? diffStat(diff) : undefined;
  const view: Record<string, unknown> = {
    ...rest,
    ...(logs.length > 0 ? { logs } : {}),
    calls: verbose ? calls : summarizeCalls(calls, result.error?.message),
    ...(counted ? { changedCount: changedFiles.length } : changedFiles.length > 0 ? { changedFiles } : {}),
    ...(diff === '' ? {} : stat === undefined ? { diff } : { diffStat: counted ? { total: stat.total } : stat }),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
  return { view, cut: bigDiff || counted };
}

/** Text of a result that goes in the second block, or undefined when it stays in the JSON. */
function plainText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > TEXT_BLOCK_MIN_CHARS && value.includes('\n') ? value : undefined;
}

function response(json: Record<string, unknown>, second: string | undefined, isError: boolean): McpToolResponse {
  const content: McpToolResponse['content'] = [{ type: 'text', text: safeStringify(json) }];
  if (second !== undefined) content.push({ type: 'text', text: second });
  return { content, isError };
}

function size(r: McpToolResponse): number {
  return r.content.reduce((n, c) => n + c.text.length, 0);
}

/** Start and end of `text` within about `budget` characters, cut at line breaks when one is near. */
export function headTail(text: string, budget: number, marker: (cut: number) => string): string {
  if (text.length <= budget) return text;
  const room = Math.max(0, budget - marker(text.length).length);
  let headEnd = Math.floor(room * 0.6);
  let tailStart = text.length - (room - headEnd);
  const nl = text.lastIndexOf('\n', headEnd);
  if (nl > headEnd * 0.8) headEnd = nl + 1;
  const tl = text.indexOf('\n', tailStart);
  if (tl !== -1 && tl < tailStart + (text.length - tailStart) * 0.2) tailStart = tl + 1;
  return `${text.slice(0, headEnd)}${marker(tailStart - headEnd)}${text.slice(tailStart)}`;
}

/** Lists in the view that are cut by entry count when the rest does not fit. */
const LISTS: readonly (readonly string[])[] = [['calls'], ['changedFiles'], ['warnings'], ['rolledBack', 'restored'], ['rolledBack', 'skipped']];

function getList(view: Record<string, unknown>, at: readonly string[]): unknown[] | undefined {
  let node: unknown = view;
  for (const key of at) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined;
    node = Object.getOwnPropertyDescriptor(node, key)?.value;
  }
  return Array.isArray(node) ? node : undefined;
}

function setList(view: Record<string, unknown>, at: readonly string[], list: unknown[]): Record<string, unknown> {
  const [key, ...more] = at;
  if (key === undefined) return view;
  const child = view[key];
  if (more.length === 0) return { ...view, [key]: list };
  if (child === null || typeof child !== 'object' || Array.isArray(child)) return view;
  return { ...view, [key]: setList({ ...child }, more, list) };
}

/** `view` with each long list cut to its first `keep` entries plus a marker. */
function cutLists(view: Record<string, unknown>, keep: number, more: (n: number) => string): Record<string, unknown> {
  let out = view;
  for (const at of LISTS) {
    const list = getList(out, at);
    if (list !== undefined && list.length > keep) out = setList(out, at, [...list.slice(0, keep), more(list.length - keep)]);
  }
  return out;
}

/** `view` with strings above `max` characters anywhere in it cut with a marker. */
function clipObject(view: Record<string, unknown>, max: number): Record<string, unknown> {
  return Object.fromEntries(Object.entries(view).map(([k, v]) => [k, clipStrings(v, max)]));
}

function clipStrings(value: unknown, max: number): unknown {
  if (typeof value === 'string') return value.length <= max ? value : `${value.slice(0, max)}…[${value.length - max} chars cut]`;
  if (Array.isArray(value)) return value.map((v) => clipStrings(v, max));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clipStrings(v, max)]));
  return value;
}

/**
 * Formats a `RunResult` as an MCP tool response: a JSON block (`isError` when
 * the run failed) and, when the result is a multi-line string longer than
 * `TEXT_BLOCK_MIN_CHARS`, the string as plain text in a second block.
 *
 * Nothing the model needs disappears: denied and failed calls are listed
 * whole, and so are the changed files unless a successful run changed more
 * than `CHANGED_FILES_INLINE` and the whole result could be kept. When the
 * view leaves something out (a large diff, the list of files) or the response
 * is above the cap (`SUCCESS_CAP_CHARS`, `ERROR_CAP_CHARS`),
 * the whole result is kept in `opts.overflow` and the response carries
 * `overflow: {id, chars}` for `readOverflow`. Above the cap, the result, the
 * logs and a verbose diff keep their start and end, and long lists their
 * first entries, each cut marked; `truncated: true` is set. Denied and failed
 * calls that do not fit whole are grouped by tool and reason with exact
 * counts (see `capped`). A response never names an overflow that could not
 * be kept.
 */
export function formatRunResult(result: RunResult, opts: FormatOptions = {}): McpToolResponse {
  const isError = !result.ok;
  const cap = isError ? (opts.errorCap ?? ERROR_CAP_CHARS) : (opts.successCap ?? SUCCESS_CAP_CHARS);
  const verbose = opts.verbose === true;
  const first = runResultView(result, verbose);
  const firstText = plainText(first.view['result']);
  const firstWhole = firstText === undefined ? first.view : { ...first.view, result: RESULT_IN_NEXT_BLOCK };
  const plain = response(firstWhole, firstText, isError);
  if (!first.cut && size(plain) <= cap) return plain;

  const full = safeStringify(result);
  const id = opts.overflow?.put(full);
  const overflow = id === undefined ? undefined : { id, chars: full.length };
  // Nothing was kept: the list of files the view counted has no other home, so it comes back before any cap applies.
  let view = overflow === undefined && countsChangedFiles(result, verbose) ? runResultView(result, verbose, true).view : first.view;
  const text = plainText(view['result']);
  const whole = text === undefined ? view : { ...view, result: RESULT_IN_NEXT_BLOCK };
  const noted = response(overflow ? { ...whole, overflow } : whole, text, isError);
  if (size(noted) <= cap) return noted;
  if (overflow === undefined) {
    // Nothing was kept, so what only repeats file names goes first: the list itself has no other home.
    view = withoutDiffFileNames(view);
    const slim = response(text === undefined ? view : { ...view, result: RESULT_IN_NEXT_BLOCK }, text, isError);
    if (size(slim) <= cap) return slim;
  }
  return capped(view, summarizeCalls(result.calls, result.error?.message), overflow, full.length, cap, isError);
}

/** `view` with `diffStat` reduced to its total. */
function withoutDiffFileNames(view: Record<string, unknown>): Record<string, unknown> {
  const stat = view['diffStat'];
  if (stat === null || typeof stat !== 'object' || !('total' in stat)) return view;
  return { ...view, diffStat: { total: stat.total } };
}

/** `calls` with its denied and failed lists replaced. */
function withFailed(calls: CompactCalls, denied: unknown[] | undefined, errors: unknown[] | undefined, byTool = true): Record<string, unknown> {
  return { total: calls.total, ...(byTool ? { byTool: calls.byTool } : {}), ...(denied ? { denied } : {}), ...(errors ? { errors } : {}) };
}

function clipGroup(g: FailedGroup, max: number): FailedGroup {
  const clip = (t: string): string => (t.length <= max ? t : `${t.slice(0, max)}…[${t.length - max} chars cut]`);
  return { tool: clip(g.tool), ...(g.reason === undefined ? {} : { reason: clip(g.reason) }), count: g.count, first: clip(g.first) };
}

/**
 * The ways to show denied and failed calls, from most to least detailed:
 * every call; groups by (tool, reason) with counts; the same groups with the
 * reason and first summary cut to `GROUP_TEXT_CHARS`. `dropped(k)` keeps the
 * first `k` clipped groups of each list and a marker with how many reasons
 * and calls are left out.
 */
function failedViews(calls: CompactCalls, more: string): { readonly forms: Record<string, unknown>[]; readonly dropped: (k: number, byTool: boolean) => Record<string, unknown>; readonly groups: number } {
  const denied = calls.denied ? groupFailed(calls.denied) : undefined;
  const errors = calls.errors ? groupFailed(calls.errors) : undefined;
  const clipped = (gs: FailedGroup[] | undefined): FailedGroup[] | undefined => gs?.map((g) => clipGroup(g, GROUP_TEXT_CHARS));
  const deniedClipped = clipped(denied);
  const errorsClipped = clipped(errors);
  const keepFirst = (gs: FailedGroup[] | undefined, k: number): unknown[] | undefined => {
    if (gs === undefined || gs.length <= k) return gs;
    const left = gs.slice(k);
    const n = left.reduce((a, g) => a + g.count, 0);
    return [...gs.slice(0, k), `…[${left.length} more reason${left.length === 1 ? '' : 's'} (${n} call${n === 1 ? '' : 's'})${more}]`];
  };
  return {
    forms: [withFailed(calls, calls.denied, calls.errors), withFailed(calls, denied, errors), withFailed(calls, deniedClipped, errorsClipped)],
    dropped: (k, byTool) => withFailed(calls, keepFirst(deniedClipped, k), keepFirst(errorsClipped, k), byTool),
    groups: Math.max(denied?.length ?? 0, errors?.length ?? 0),
  };
}

/**
 * Clipped groups (see `failedViews`) of as many reasons per list as fit `max`
 * characters with `rest`; `byTool` is left out only when not even the markers
 * fit with it (thousands of distinct tool names).
 */
function fitGroups(views: ReturnType<typeof failedViews>, rest: Record<string, unknown>, key: string, max: number): Record<string, unknown> {
  const byTool = safeStringify({ ...rest, [key]: views.dropped(0, true) }).length <= max;
  const fits = (k: number): boolean => safeStringify({ ...rest, [key]: views.dropped(k, byTool) }).length <= max;
  let lo = 0;
  let hi = views.groups;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return { ...rest, [key]: views.dropped(lo, byTool) };
}

/**
 * The response cut to `cap` characters: lists, then the result, logs and diff
 * by start and end. Denied and failed calls are never cut by entry: when they
 * do not fit whole they are grouped by (tool, reason) with exact counts, then
 * each group's reason and first summary is cut to `GROUP_TEXT_CHARS`, and
 * only then are groups left out, with a marker counting the reasons and calls
 * left out. The other lists lose entries only when even the clipped groups do
 * not fit. A verbose call log is a list like the others, so the compact calls
 * go to `callSummary` next to it.
 */
function capped(
  view: Record<string, unknown>,
  calls: CompactCalls,
  overflow: { id: string; chars: number } | undefined,
  fullChars: number,
  cap: number,
  isError: boolean,
): McpToolResponse {
  const where = overflow ? `; readOverflow(${JSON.stringify(overflow.id)}) has the whole result` : '';
  const marker = (n: number): string => `\n…[${n} chars cut${where}]\n`;
  const inOverflow = overflow ? ' in overflow' : '';
  const more = (n: number): string => `…[${n} more${inOverflow}]`;
  const { result, logs, diff, ...rest } = view;
  // The compact calls replace the view's unless the view has the verbose log (a list), which stays beside them.
  const { calls: viewCalls, ...compactEnvelope } = rest;
  const envelope = Array.isArray(viewCalls) ? rest : compactEnvelope;
  const key = Array.isArray(viewCalls) ? 'callSummary' : 'calls';
  const failed = failedViews(calls, inOverflow);
  const resultText = result === undefined ? undefined : typeof result === 'string' ? result : safeStringify(result);
  const logText = Array.isArray(logs) ? logs.join('\n') : undefined;
  const diffText = typeof diff === 'string' ? diff : undefined;
  const top = { truncated: true, ...(overflow ? { overflow } : { chars: fullChars }) };

  for (let scale = 1; scale > 0.05; scale *= 0.8) {
    const budget = Math.floor(cap * scale);
    // The envelope (status, error, calls, files, warnings) comes first: it keeps all it needs but a quarter of
    // the budget, which the result, logs and diff share. Denied and failed calls are grouped before other lists
    // lose entries, and other lists lose entries before any string is clipped.
    const bulk = [resultText, logText, diffText].map((t) => (t === undefined ? 0 : t.length));
    const envMax = budget - Math.min(bulk.reduce((a, b) => a + b, 0), Math.floor(budget / 4)) - 200;
    // As many entries of the lists as fit.
    const envelopeWith = (keep: number): Record<string, unknown> | undefined => {
      const cut = { ...cutLists(envelope, keep, more), ...top };
      return failed.forms.map((c) => ({ ...cut, [key]: c })).find((e) => safeStringify(e).length <= envMax);
    };
    let env = envelopeWith(1);
    let fits = 1;
    let over = Math.max(1, ...LISTS.map((at) => getList(envelope, at)?.length ?? 0)) + 1;
    while (env !== undefined && over - fits > 1) {
      const middle = Math.floor((fits + over) / 2);
      const wider = envelopeWith(middle);
      if (wider === undefined) over = middle;
      else (env = wider), (fits = middle);
    }
    env ??= fitGroups(failed, { ...clipObject(cutLists(envelope, 0, more), 300), ...top }, key, envMax);
    const shares = share(bulk, Math.max(0, budget - safeStringify(env).length - 200));
    const json: Record<string, unknown> = { ...env };
    let second: string | undefined;
    if (resultText !== undefined) {
      const shown = headTail(resultText, shares[0] ?? 0, marker);
      const whole = shown === resultText ? plainText(result) : shown;
      if (shown === resultText && whole === undefined) json['result'] = result;
      else (json['result'] = RESULT_IN_NEXT_BLOCK), (second = whole);
    }
    if (logText !== undefined) json['logs'] = headTail(logText, Math.floor((shares[1] ?? 0) / 1.2), marker).split('\n');
    if (diffText !== undefined) json['diff'] = headTail(diffText, Math.floor((shares[2] ?? 0) / 1.2), marker);
    const out = response(order(json, view), second, isError);
    if (size(out) <= cap) return out;
  }
  const undoId = view['undoId'] === undefined ? {} : { undoId: view['undoId'] };
  const ok = { ok: view['ok'] };
  const smallest = [fitGroups(failed, { ...ok, ...undoId, ...top }, key, cap), { ...ok, ...undoId, ...top }, { ...ok, ...undoId, truncated: true }, { ...ok, truncated: true }, ok];
  for (const json of smallest) {
    const out = response(json, undefined, isError);
    if (size(out) <= cap) return out;
  }
  return { content: [{ type: 'text', text: safeStringify(ok).slice(0, Math.max(0, cap)) }], isError };
}

/** Splits `total` among parts of the given sizes: small parts whole, the rest evenly. */
function share(sizes: readonly number[], total: number): number[] {
  const out = sizes.map(() => 0);
  const order = sizes.map((s, i) => [s, i] as const).filter(([s]) => s > 0).sort((a, b) => a[0] - b[0]);
  let left = total;
  order.forEach(([s, i], k) => {
    const fair = Math.floor(left / (order.length - k));
    out[i] = Math.min(s, fair);
    left -= out[i] ?? 0;
  });
  return out;
}

/** `json` with its keys in the order of `like` (extra keys last), so a cut response reads like a whole one. */
function order(json: Record<string, unknown>, like: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(like)) if (key in json) out[key] = json[key];
  for (const [key, value] of Object.entries(json)) if (!(key in out)) out[key] = value;
  return out;
}
