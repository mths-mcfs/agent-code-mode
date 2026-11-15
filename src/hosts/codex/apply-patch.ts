/**
 * Codex `apply_patch` format: generation, parsing and application.
 *
 * Reference: openai/codex rust-v0.169.0 (commit d32063f96c2d),
 * `codex-rs/apply-patch/src/{parser,streaming_parser,file_update,seek_sequence,text_file}.rs`.
 *
 *   *** Begin Patch
 *   *** Add File: <path>        then `+line` lines
 *   *** Update File: <path>     then `@@` chunks of ` ctx`, `-old`, `+new` lines
 *   *** Delete File: <path>
 *   *** End Patch
 *
 * Codex applies an update line by line: unchanged lines keep their original
 * ending, inserted lines take the file's first ending (LF by default), and
 * every line ends with a line ending afterwards. Added files are the `+` lines
 * joined with LF. So the format cannot express a missing final newline or a
 * line ending different from the file's first one; `generatePatch` reports
 * that gap (`exact: false`) and the line texts are still exact.
 */

export type PatchHunk =
  | { readonly kind: 'add'; readonly path: string; readonly contents: string }
  | { readonly kind: 'delete'; readonly path: string }
  | { readonly kind: 'update'; readonly path: string; readonly movePath: string | null; readonly chunks: readonly UpdateChunk[] };

export interface UpdateChunk {
  readonly changeContext: string | null;
  readonly oldLines: readonly string[];
  readonly newLines: readonly string[];
  /** Pairs of indexes (in oldLines, newLines) of context lines. */
  readonly contextLineIndices: readonly (readonly [number, number])[];
  readonly isEndOfFile: boolean;
}

export class PatchError extends Error {
  override readonly name = 'PatchError';
}

const BEGIN = '*** Begin Patch';
const END = '*** End Patch';
const ADD = '*** Add File: ';
const DELETE = '*** Delete File: ';
const UPDATE = '*** Update File: ';
const MOVE = '*** Move to: ';
const EOF_MARKER = '*** End of File';
const ENV_ID = '*** Environment ID: ';

// ---------------------------------------------------------------------------
// Parsing (lenient mode, as Codex uses it).
// ---------------------------------------------------------------------------

/** Rust `str::trim` equivalent for our purposes. */
const trim = (s: string): string => s.trim();
const trimEnd = (s: string): string => s.trimEnd();

/** Rust `str::lines`: split on `\n`, drop a trailing `\r` on each line, no final empty line. */
function rustLines(s: string): string[] {
  if (s === '') return [];
  const parts = s.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function checkBoundaries(lines: readonly string[]): readonly string[] {
  const first = lines[0] === undefined ? undefined : trim(lines[0]);
  const last = lines[lines.length - 1] === undefined ? undefined : trim(lines[lines.length - 1] ?? '');
  if (first === BEGIN && last === END) return lines;
  if (first !== BEGIN) throw new PatchError("invalid patch: The first line of the patch must be '*** Begin Patch'");
  throw new PatchError("invalid patch: The last line of the patch must be '*** End Patch'");
}

function checkBoundariesLenient(lines: readonly string[]): readonly string[] {
  try {
    return checkBoundaries(lines);
  } catch (err) {
    const first = lines[0];
    const last = lines[lines.length - 1];
    if (
      lines.length >= 4 &&
      (first === '<<EOF' || first === "<<'EOF'" || first === '<<"EOF"') &&
      last !== undefined &&
      last.endsWith('EOF')
    ) {
      return checkBoundaries(lines.slice(1, -1));
    }
    throw err;
  }
}

interface MutableChunk {
  changeContext: string | null;
  oldLines: string[];
  newLines: string[];
  contextLineIndices: [number, number][];
  isEndOfFile: boolean;
}

type MutableHunk =
  | { kind: 'add'; path: string; contents: string }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; movePath: string | null; chunks: MutableChunk[] };

const newChunk = (changeContext: string | null = null): MutableChunk => ({
  changeContext,
  oldLines: [],
  newLines: [],
  contextLineIndices: [],
  isEndOfFile: false,
});

/** Parses a patch the way Codex's `parse_patch` does. Throws `PatchError`. */
export function parsePatch(patch: string): { hunks: PatchHunk[]; environmentId: string | null } {
  const lines = checkBoundariesLenient(rustLines(patch.trim()));
  type Mode = 'not-started' | 'started' | 'add' | 'delete' | 'update' | 'ended';
  const st: { mode: Mode } = { mode: 'not-started' };
  const hunks: MutableHunk[] = [];
  let environmentId: string | null = null;
  let lineNo = 0;
  const hunkError: (message: string) => never = (message) => {
    throw new PatchError(`invalid hunk at line ${lineNo}, ${message}`);
  };
  const lastUpdate = (): Extract<MutableHunk, { kind: 'update' }> | undefined => {
    const h = hunks[hunks.length - 1];
    return h?.kind === 'update' ? h : undefined;
  };
  const ensureUpdateNotEmpty = (line: string): void => {
    const h = lastUpdate();
    if (st.mode === 'update' && h && h.chunks.length === 0) {
      hunkError(`Update file hunk for path '${h.path}' is empty`);
    }
    void line;
  };
  const headers = (t: string): boolean => {
    if (st.mode === 'started' && t.startsWith(ENV_ID)) {
      if (environmentId !== null) throw new PatchError('invalid patch: apply_patch environment_id cannot be specified more than once');
      const id = t.slice(ENV_ID.length).trim();
      if (id === '') throw new PatchError('invalid patch: apply_patch environment_id cannot be empty');
      environmentId = id;
      return true;
    }
    if (t === END) {
      ensureUpdateNotEmpty(t);
      st.mode = 'ended';
      return true;
    }
    if (t.startsWith(ADD)) {
      ensureUpdateNotEmpty(t);
      hunks.push({ kind: 'add', path: t.slice(ADD.length), contents: '' });
      st.mode = 'add';
      return true;
    }
    if (t.startsWith(DELETE)) {
      ensureUpdateNotEmpty(t);
      hunks.push({ kind: 'delete', path: t.slice(DELETE.length) });
      st.mode = 'delete';
      return true;
    }
    if (t.startsWith(UPDATE)) {
      ensureUpdateNotEmpty(t);
      hunks.push({ kind: 'update', path: t.slice(UPDATE.length), movePath: null, chunks: [] });
      st.mode = 'update';
      return true;
    }
    return false;
  };
  const invalidHeader: (t: string) => never = (t) =>
    hunkError(`'${t}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`);
  const unexpected: (line: string) => never = (line) =>
    hunkError(`Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`);

  for (const line of lines) {
    lineNo++;
    const t = trim(line);
    switch (st.mode) {
      case 'not-started':
        if (t === BEGIN) {
          st.mode = 'started';
          break;
        }
        throw new PatchError("invalid patch: The first line of the patch must be '*** Begin Patch'");
      case 'started':
        if (!headers(t)) invalidHeader(t);
        break;
      case 'add': {
        if (headers(t)) break;
        const h = hunks[hunks.length - 1];
        if (line.startsWith('+') && h?.kind === 'add') {
          h.contents += `${line.slice(1)}\n`;
          break;
        }
        invalidHeader(t);
        break;
      }
      case 'delete':
        if (!headers(t)) invalidHeader(t);
        break;
      case 'update': {
        const u = trimEnd(line);
        if (headers(u)) break;
        const h = lastUpdate();
        if (!h) return unexpected(line);
        const last = h.chunks[h.chunks.length - 1];
        if (last?.isEndOfFile) {
          if (u === '') break;
          if (u !== '@@' && !u.startsWith('@@ ')) hunkError(`Expected update hunk to start with a @@ context marker, got: '${line}'`);
        }
        if (h.chunks.length === 0 && h.movePath === null && u.startsWith(MOVE)) {
          h.movePath = u.slice(MOVE.length);
          break;
        }
        if ((u === '@@' || u.startsWith('@@ ')) && last !== undefined && last.oldLines.length === 0 && last.newLines.length === 0) {
          unexpected(line);
        }
        if (u === '@@') {
          h.chunks.push(newChunk());
          break;
        }
        if (u.startsWith('@@ ')) {
          h.chunks.push(newChunk(u.slice(3)));
          break;
        }
        if (u === EOF_MARKER) {
          if (last !== undefined && last.oldLines.length === 0 && last.newLines.length === 0) hunkError('Update hunk does not contain any lines');
          if (last) last.isEndOfFile = true;
          break;
        }
        const chunk = (): MutableChunk => {
          let c = h.chunks[h.chunks.length - 1];
          if (!c) {
            c = newChunk();
            h.chunks.push(c);
          }
          return c;
        };
        if (line === '' || line.startsWith(' ')) {
          const c = chunk();
          c.contextLineIndices.push([c.oldLines.length, c.newLines.length]);
          const text = line === '' ? '' : line.slice(1);
          c.oldLines.push(text);
          c.newLines.push(text);
          break;
        }
        if (line.startsWith('+')) {
          chunk().newLines.push(line.slice(1));
          break;
        }
        if (line.startsWith('-')) {
          chunk().oldLines.push(line.slice(1));
          break;
        }
        if (last !== undefined && (last.oldLines.length > 0 || last.newLines.length > 0)) {
          hunkError(`Expected update hunk to start with a @@ context marker, got: '${line}'`);
        }
        unexpected(line);
        break;
      }
      case 'ended':
        if (t !== '') throw new PatchError("invalid patch: The last line of the patch must be '*** End Patch'");
        break;
    }
  }
  if (st.mode !== 'ended') throw new PatchError("invalid patch: The last line of the patch must be '*** End Patch'");
  return { hunks, environmentId };
}

// ---------------------------------------------------------------------------
// Applying an update to file content.
// ---------------------------------------------------------------------------

type Ending = '\n' | '\r\n' | '\r';

interface SourceLine {
  text: string;
  ending: Ending | null;
}

/** Splits content into lines, keeping each line's ending (Codex `SourceFile::parse`). */
export function parseSource(contents: string): { lines: SourceLine[]; preferred: Ending } {
  const lines: SourceLine[] = [];
  let preferred: Ending | null = null;
  let start = 0;
  for (let i = 0; i < contents.length; i++) {
    const c = contents[i];
    let ending: Ending | null = null;
    if (c === '\r') ending = contents[i + 1] === '\n' ? '\r\n' : '\r';
    else if (c === '\n') ending = '\n';
    if (ending === null) continue;
    preferred ??= ending;
    lines.push({ text: contents.slice(start, i), ending });
    i += ending.length - 1;
    start = i + 1;
  }
  if (start < contents.length) lines.push({ text: contents.slice(start), ending: null });
  return { lines, preferred: preferred ?? '\n' };
}

/** Line texts of a content, without endings. */
export function lineTexts(contents: string): string[] {
  return parseSource(contents).lines.map((l) => l.text);
}

const DASHES = /[‐-―−]/g;
const SINGLE_QUOTES = /[‘-‛]/g;
const DOUBLE_QUOTES = /[“-‟]/g;
const SPACES = /[  -   　]/g;

function normalise(s: string): string {
  return s.trim().replace(DASHES, '-').replace(SINGLE_QUOTES, "'").replace(DOUBLE_QUOTES, '"').replace(SPACES, ' ');
}

/** Codex `seek_sequence`: exact, then trim_end, then trim, then punctuation-normalized. */
export function seekSequence(lines: readonly string[], pattern: readonly string[], start: number, eof: boolean): number | undefined {
  if (pattern.length === 0) return start;
  if (pattern.length > lines.length) return undefined;
  const searchStart = eof ? Math.max(lines.length - pattern.length, start) : start;
  const last = lines.length - pattern.length;
  const passes: ((s: string) => string)[] = [(s) => s, trimEnd, trim, normalise];
  for (const f of passes) {
    for (let i = searchStart; i <= last; i++) {
      let ok = true;
      for (let p = 0; p < pattern.length; p++) {
        if (f(lines[i + p] ?? '') !== f(pattern[p] ?? '')) {
          ok = false;
          break;
        }
      }
      if (ok) return i;
    }
  }
  return undefined;
}

type Replacement = readonly [start: number, oldLen: number, newLines: readonly string[]];

function computeReplacements(original: readonly string[], file: string, chunks: readonly UpdateChunk[]): Replacement[] {
  const replacements: Replacement[] = [];
  let lineIndex = 0;
  for (const chunk of chunks) {
    if (chunk.changeContext !== null) {
      const idx = seekSequence(original, [chunk.changeContext], lineIndex, false);
      if (idx === undefined) throw new PatchError(`Failed to find context '${chunk.changeContext}' in ${file}`);
      lineIndex = idx + 1;
    }
    if (chunk.oldLines.length === 0) {
      replacements.push([original.length, 0, [...chunk.newLines]]);
      continue;
    }
    let pattern = chunk.oldLines;
    let newSlice = chunk.newLines;
    let found = seekSequence(original, pattern, lineIndex, chunk.isEndOfFile);
    if (found === undefined && pattern[pattern.length - 1] === '') {
      pattern = pattern.slice(0, -1);
      if (newSlice[newSlice.length - 1] === '') newSlice = newSlice.slice(0, -1);
      found = seekSequence(original, pattern, lineIndex, chunk.isEndOfFile);
    }
    if (found === undefined) throw new PatchError(`Failed to find expected lines in ${file}:\n${chunk.oldLines.join('\n')}`);
    let oldStart = 0;
    let newStart = 0;
    for (const [oldCtx, newCtx] of chunk.contextLineIndices) {
      if (oldCtx >= pattern.length || newCtx >= newSlice.length) break;
      if (oldStart !== oldCtx || newStart !== newCtx) {
        replacements.push([found + oldStart, oldCtx - oldStart, newSlice.slice(newStart, newCtx)]);
      }
      oldStart = oldCtx + 1;
      newStart = newCtx + 1;
    }
    if (oldStart !== pattern.length || newStart !== newSlice.length) {
      replacements.push([found + oldStart, pattern.length - oldStart, newSlice.slice(newStart)]);
    }
    lineIndex = found + pattern.length;
  }
  replacements.sort((a, b) => a[0] - b[0]);
  return replacements;
}

/** Applies update chunks to `contents` with Codex's semantics. Throws `PatchError`. */
export function applyUpdate(contents: string, file: string, chunks: readonly UpdateChunk[]): string {
  const src = parseSource(contents);
  const replacements = computeReplacements(
    src.lines.map((l) => l.text),
    file,
    chunks,
  );
  const out: SourceLine[] = [];
  let index = 0;
  for (const [start, oldLen, newLines] of replacements) {
    if (start < index) throw new PatchError(`overlapping update chunks in ${file}`);
    out.push(...src.lines.slice(index, start));
    out.push(...newLines.map((text) => ({ text, ending: src.preferred })));
    index = start + oldLen;
  }
  out.push(...src.lines.slice(index));
  return out.map((l) => l.text + (l.ending ?? src.preferred)).join('');
}

// ---------------------------------------------------------------------------
// Generation.
// ---------------------------------------------------------------------------

type Op = { readonly kind: 'eq' | 'del' | 'ins'; readonly text: string };

const MAX_EDIT_DISTANCE = 4000;

/** Myers diff of two line arrays; undefined when the edit distance exceeds the cap. */
function myers(a: readonly string[], b: readonly string[]): Op[] | undefined {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0))) x = v[offset + k + 1] ?? 0;
      else x = (v[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      next[offset + k] = x;
      if (x >= n && y >= m) {
        trace.push(next);
        return backtrack(trace, a, b, offset, d);
      }
    }
    v = next;
  }
  return undefined;
}

function backtrack(trace: readonly Int32Array[], a: readonly string[], b: readonly string[], offset: number, dEnd: number): Op[] {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = dEnd; d > 0; d--) {
    const v = trace[d] ?? new Int32Array(0);
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0))) prevK = k + 1;
    else prevK = k - 1;
    const prevX = v[offset + prevK] ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: 'eq', text: a[x - 1] ?? '' });
      x--;
      y--;
    }
    if (x === prevX) ops.push({ kind: 'ins', text: b[y - 1] ?? '' });
    else ops.push({ kind: 'del', text: a[x - 1] ?? '' });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    ops.push({ kind: 'eq', text: a[x - 1] ?? '' });
    x--;
    y--;
  }
  return ops.reverse();
}

function diffLines(a: readonly string[], b: readonly string[]): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const midA = a.slice(pre, a.length - suf);
  const midB = b.slice(pre, b.length - suf);
  const mid = myers(midA, midB) ?? [...midA.map((text) => ({ kind: 'del' as const, text })), ...midB.map((text) => ({ kind: 'ins' as const, text }))];
  return [
    ...a.slice(0, pre).map((text) => ({ kind: 'eq' as const, text })),
    ...mid,
    ...a.slice(a.length - suf).map((text) => ({ kind: 'eq' as const, text })),
  ];
}

const CONTEXT = 3;

function chunkLines(ops: readonly Op[], context: number): string[][] {
  const changed = ops.map((o) => o.kind !== 'eq');
  const chunks: string[][] = [];
  let i = 0;
  while (i < ops.length) {
    if (!changed[i]) {
      i++;
      continue;
    }
    const start = Math.max(0, i - context);
    let end = i;
    // Extend while the next change is within 2*context unchanged lines.
    for (;;) {
      while (end < ops.length && changed[end]) end++;
      let gap = 0;
      while (end + gap < ops.length && !changed[end + gap]) gap++;
      if (end + gap < ops.length && gap <= 2 * context) {
        end += gap;
        continue;
      }
      end = Math.min(ops.length, end + context);
      break;
    }
    chunks.push(
      ops.slice(start, end).map((o) => (o.kind === 'eq' ? ` ${o.text}` : o.kind === 'del' ? `-${o.text}` : `+${o.text}`)),
    );
    i = end;
  }
  return chunks;
}

function renderUpdate(file: string, chunks: readonly string[][]): string {
  return [BEGIN, `${UPDATE}${file}`, ...chunks.flatMap((c) => ['@@', ...c]), END].join('\n');
}

/** Result of `generatePatch`. */
export interface GeneratedPatch {
  readonly patch: string;
  /** True when applying `patch` with Codex's semantics yields exactly the after content. */
  readonly exact: boolean;
}

/**
 * Applies a parsed single-file hunk to the current content (null when the
 * file does not exist) and returns the new content. Throws `PatchError`.
 */
export function applyHunk(before: string | null, hunk: PatchHunk): string {
  switch (hunk.kind) {
    case 'add':
      return hunk.contents;
    case 'update':
      if (before === null) throw new PatchError(`Failed to read file to update ${hunk.path}`);
      return applyUpdate(before, hunk.path, hunk.chunks);
    case 'delete':
      throw new PatchError('delete hunks are not supported');
  }
}

/**
 * Builds the Codex patch that turns `before` into `after` for `file` (the
 * path written in the patch). `before === null` means the file does not
 * exist yet (`*** Add File`). The patch is verified by applying it back with
 * Codex's semantics; when that does not reproduce the line texts of `after`
 * a whole-file chunk is used instead, which always does.
 */
export function generatePatch(file: string, before: string | null, after: string): GeneratedPatch {
  if (/[\r\n]/.test(file)) throw new PatchError('file path contains a line break');
  const afterLines = lineTexts(after);
  let patch: string;
  if (before === null) {
    patch = [BEGIN, `${ADD}${file}`, ...afterLines.map((l) => `+${l}`), END].join('\n');
  } else {
    const beforeLines = lineTexts(before);
    const ops = diffLines(beforeLines, afterLines);
    let chunks = chunkLines(ops, CONTEXT);
    // Codex cannot express an update without lines; show the first line as context.
    if (chunks.length === 0) chunks = beforeLines.length > 0 ? [[` ${beforeLines[0] ?? ''}`]] : [];
    patch = chunks.length > 0 ? renderUpdate(file, chunks) : [BEGIN, `${ADD}${file}`, END].join('\n');
    if (!sameLines(applyGenerated(patch, before), afterLines)) {
      // A chunk matched earlier than intended (duplicate or fuzzy match). A
      // whole-file chunk starts at line 0 and always matches there.
      const whole = [...beforeLines.map((l) => `-${l}`), ...afterLines.map((l) => `+${l}`)];
      patch = whole.length > 0 ? renderUpdate(file, [whole]) : patch;
    }
  }
  const applied = applyGenerated(patch, before);
  if (!sameLines(applied, afterLines)) throw new PatchError('generated patch does not reproduce the new content');
  return { patch, exact: applied === after };
}

function applyGenerated(patch: string, before: string | null): string {
  const { hunks } = parsePatch(patch);
  const hunk = hunks[0];
  if (hunks.length !== 1 || hunk === undefined) throw new PatchError('generated patch must have one hunk');
  // An Add hunk over an existing (empty) file overwrites it, like Codex.
  return applyHunk(hunk.kind === 'add' ? null : before, hunk);
}

function sameLines(content: string, lines: readonly string[]): boolean {
  const got = lineTexts(content);
  return got.length === lines.length && got.every((l, i) => l === lines[i]);
}
