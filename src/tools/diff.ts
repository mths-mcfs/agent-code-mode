/**
 * Unified diff of two texts (line based, Myers O(ND) with a bounded edit
 * distance). When the texts differ by more than the bound, the changed middle
 * is reported as one replace block, which is wider than the minimal diff but
 * never wrong.
 */

const CONTEXT = 3;
const MAX_EDIT_DISTANCE = 1000;

interface Line {
  readonly text: string;
  /** False only for a last line without a trailing newline. */
  readonly eol: boolean;
}

function splitLines(text: string): Line[] {
  if (text === '') return [];
  const parts = text.split('\n');
  const last = parts.pop() ?? '';
  const lines: Line[] = parts.map((t) => ({ text: t, eol: true }));
  if (last !== '') lines.push({ text: last, eol: false });
  return lines;
}

type Op = { readonly kind: ' ' | '-' | '+'; readonly line: Line };

function same(a: Line | undefined, b: Line | undefined): boolean {
  return a !== undefined && b !== undefined && a.text === b.text && a.eol === b.eol;
}

/** Edit script between a[lo..] and b[lo..] (already trimmed of common prefix/suffix). */
function myers(a: readonly Line[], b: readonly Line[]): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0))) x = v[offset + k + 1] ?? 0;
      else x = (v[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && same(a[x], b[y])) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        // Backtrack.
        const ops: Op[] = [];
        let cx = n;
        let cy = m;
        for (let dd = d; dd > 0; dd--) {
          const pv = trace[dd] ?? v;
          const kk = cx - cy;
          let prevK: number;
          if (kk === -dd || (kk !== dd && (pv[offset + kk - 1] ?? 0) < (pv[offset + kk + 1] ?? 0))) prevK = kk + 1;
          else prevK = kk - 1;
          const prevX = pv[offset + prevK] ?? 0;
          const prevY = prevX - prevK;
          while (cx > prevX && cy > prevY) {
            cx--;
            cy--;
            ops.push({ kind: ' ', line: a[cx] as Line });
          }
          if (cx === prevX) {
            cy--;
            ops.push({ kind: '+', line: b[cy] as Line });
          } else {
            cx--;
            ops.push({ kind: '-', line: a[cx] as Line });
          }
        }
        while (cx > 0 && cy > 0) {
          cx--;
          cy--;
          ops.push({ kind: ' ', line: a[cx] as Line });
        }
        return ops.reverse();
      }
    }
  }
  return null;
}

function editScript(a: readonly Line[], b: readonly Line[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && same(a[start], b[start])) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && same(a[endA - 1], b[endB - 1])) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const middle = myers(midA, midB) ?? [
    ...midA.map((line): Op => ({ kind: '-', line })),
    ...midB.map((line): Op => ({ kind: '+', line })),
  ];
  return [
    ...a.slice(0, start).map((line): Op => ({ kind: ' ', line })),
    ...middle,
    ...a.slice(endA).map((line): Op => ({ kind: ' ', line })),
  ];
}

function renderLine(op: Op): string {
  const out = `${op.kind}${op.line.text}\n`;
  return op.line.eol ? out : `${out}\\ No newline at end of file\n`;
}

/**
 * Unified diff from `before` to `after`. `before === null` means the file did
 * not exist. `file` is shown as `a/<file>` and `b/<file>`. Returns '' when
 * nothing changed.
 */
export function unifiedDiff(file: string, before: string | null, after: string): string {
  if (before !== null && before === after) return '';
  const a = before === null ? [] : splitLines(before);
  const b = splitLines(after);
  const ops = editScript(a, b);
  if (ops.every((op) => op.kind === ' ')) {
    // Only possible when before is null and after is empty: a creation has no hunk, so git's header says it.
    return `diff --git ${quotePath(`a/${file}`)} ${quotePath(`b/${file}`)}\nnew file mode 100644\n`;
  }
  const header = `--- ${before === null ? '/dev/null' : quotePath(`a/${file}`)}\n+++ ${quotePath(`b/${file}`)}\n`;

  let out = header;
  let i = 0;
  // Line counters at the start of ops[i].
  const posA: number[] = [];
  const posB: number[] = [];
  let la = 0;
  let lb = 0;
  for (const op of ops) {
    posA.push(la);
    posB.push(lb);
    if (op.kind !== '+') la++;
    if (op.kind !== '-') lb++;
  }
  while (i < ops.length) {
    while (i < ops.length && ops[i]?.kind === ' ') i++;
    if (i >= ops.length) break;
    const hunkStart = Math.max(0, i - CONTEXT);
    let end = i;
    // Extend while changes are within 2*CONTEXT of each other.
    for (;;) {
      while (end < ops.length && ops[end]?.kind !== ' ') end++;
      let next = end;
      while (next < ops.length && ops[next]?.kind === ' ') next++;
      if (next < ops.length && next - end <= 2 * CONTEXT) {
        end = next;
        continue;
      }
      break;
    }
    const hunkEnd = Math.min(ops.length, end + CONTEXT);
    const slice = ops.slice(hunkStart, hunkEnd);
    const countA = slice.filter((op) => op.kind !== '+').length;
    const countB = slice.filter((op) => op.kind !== '-').length;
    const startA = countA === 0 ? (posA[hunkStart] ?? 0) : (posA[hunkStart] ?? 0) + 1;
    const startB = countB === 0 ? (posB[hunkStart] ?? 0) : (posB[hunkStart] ?? 0) + 1;
    out += `@@ -${startA},${countA} +${startB},${countB} @@\n`;
    out += slice.map(renderLine).join('');
    i = hunkEnd;
  }
  return out;
}

/** Diff header for a binary change. */
export function binaryDiff(file: string, existed: boolean): string {
  return `--- ${existed ? quotePath(`a/${file}`) : '/dev/null'}\n+++ ${quotePath(`b/${file}`)}\nBinary files differ\n`;
}

const ESCAPES: Record<string, string> = { '"': '\\"', '\\': '\\\\', '\t': '\\t', '\n': '\\n', '\r': '\\r', '\b': '\\b', '\f': '\\f', '\v': '\\v', '\x07': '\\a' };

/**
 * A path as git writes it in a patch header: unchanged when plain, else in
 * double quotes with C escapes, so a quote, a backslash, a control character
 * or a trailing space cannot change which file the header names.
 */
export function quotePath(p: string): string {
  if (!/["\\\x00-\x1f\x7f]|\s$/.test(p)) return p;
  let out = '';
  for (const ch of p) {
    const code = ch.charCodeAt(0);
    const escaped = ESCAPES[ch];
    if (escaped !== undefined) out += escaped;
    else if (code < 0x20 || code === 0x7f) out += `\\${code.toString(8).padStart(3, '0')}`;
    else out += ch;
  }
  return `"${out}"`;
}
