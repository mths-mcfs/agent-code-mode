import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BashAnalyzer } from './bash.js';

/**
 * Oracle: bash itself. For every generated word, either the analyzer reports
 * the command as uncertain (it is then asked, so denied without a prompt), or
 * marks the word as only known at run time or as a glob (rules then treat it
 * as "may match"), or the value it matches rules against is exactly the word
 * bash hands the command.
 */

const posix = process.platform !== 'win32';
const HOME = os.homedir();
const SEED = Number(process.env["ACM_SEED"] ?? 42);

/** Pieces a word is built from: one per expansion bash may apply, plus plain text. */
const PIECES = [
  'a', 'b.txt', '-n', '=', ':', '/', 'é', '😀', '!x', '#',
  '{a,b}', '{1..3}', '{}', 'a{b}c', '{,}', 'x{a,{b,c}}', "'{a,b}'", '"{a,b}"', '\\{a,b}', '{a\\,b}', '{"a,b"}',
  '~', '~/', '~/x', '~root', '~+', '~-', '~nobody/z', "'~'", '"~"', '\\~', 'a~b', 'a=~/x', 'A_1=x:~/y', '--f=~/x', 'x:~/y', '"a"=~/x', 'a=~root',
  "$'\\x41'", "$'\\n'", "$'a\\tb'", "$'\\''", "$'\\101'", '$"hi"', '$((1+2))', '$((x))', '<(true)', '>(true)',
  '\\a', '\\\\', '"a\\b"', '"a\\"b"', "'a\\b'", '\\ ', '"$HOME"', '$HOME', '${HOME}', '$(echo x)', '`echo x`',
  '*', '?', '[ab]', '*.txt', '"*"', '\\*', '"a b"', "'it'\\''s'",
];

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pieces for tilde words: quotes (empty too), backslashes, assignment heads, `+=`, `:` and `~` in every position. */
const TILDE_PIECES = [
  "''", '""', "'a'", '"a"', '\\a', '\\~', '\\=', '\\:', '\\+', '\\/', 'a', 'A_1', '_', '1', '=', '+=', '+', ':', '~', '/', 'x', '[1]', '[', ']',
  "'~'", '"~"', "'='", '"="', "':'", '"/"', '~+', '-', 'a=', 'a+=', 'a=~', 'a+=~', ':~', '=~',
];

/** Random words built from `TILDE_PIECES`, plus every piece alone. */
function tildeWords(count: number): string[] {
  const r = rng(SEED + 1);
  const words: string[] = [...TILDE_PIECES];
  for (let i = 0; i < count; i++) {
    const n = 1 + Math.floor(r() * 5);
    words.push(Array.from({ length: n }, () => TILDE_PIECES[Math.floor(r() * TILDE_PIECES.length)] ?? '').join(''));
  }
  return words;
}

/** The words bash passes to `X` for each line of `lines`, run in `cwd`. */
function bashWords(lines: readonly string[], cwd: string): (string[] | undefined)[] {
  const script = ['X() { printf "\\2"; for a in "$@"; do printf "%s\\0" "$a"; done; printf "\\1"; }', ...lines.map((l) => `${l}\nprintf "\\3"`)].join('\n');
  const r = spawnSync('bash', ['-c', script], { cwd, env: { PATH: process.env['PATH'] ?? '', HOME, LC_ALL: 'C' }, encoding: 'utf8' });
  const chunks = r.stdout.split('\x03');
  return lines.map((_, i) => {
    const chunk = chunks[i] ?? '';
    const start = chunk.indexOf('\x02');
    const end = chunk.indexOf('\x01');
    if (start === -1 || end === -1) return undefined;
    return chunk.slice(start + 1, end).split('\0').slice(0, -1);
  });
}

describe.runIf(posix)('BashAnalyzer word values against bash', () => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'acm-words-')));
  for (const f of ['a.txt', 'b.txt', 'ab']) writeFileSync(path.join(dir, f), '');
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('matches rules against the word bash runs, or does not treat it as known', () => {
    const r = rng(SEED);
    const words: string[] = [...PIECES];
    for (let i = 0; i < 600; i++) {
      const n = 1 + Math.floor(r() * 3);
      words.push(Array.from({ length: n }, () => PIECES[Math.floor(r() * PIECES.length)] ?? '').join(''));
    }
    const lines = words.map((w) => `X ${w}`);
    const fromBash = bashWords(lines, dir);
    let exact = 0;
    let refused = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      const analysis = BashAnalyzer.analyze(line, { home: HOME });
      if (analysis.uncertain.length > 0) {
        refused++;
        continue;
      }
      const cmd = analysis.commands.find((c) => c.words[0]?.value === 'X');
      const got = fromBash[i];
      if (!cmd) {
        // Nothing to match (a comment); bash runs `X` without arguments.
        expect(got, line).toEqual([]);
        continue;
      }
      const args = cmd.words.slice(1);
      if (args.some((w) => w.value === undefined || w.glob)) {
        expect(cmd.dynamic || cmd.globbed, line).toBe(true);
        continue;
      }
      expect(got, line).toEqual(args.map((w) => w.value));
      exact++;
    }
    expect(exact).toBeGreaterThan(150);
    expect(refused).toBeGreaterThan(50);
  });

  it('expands `~` exactly where bash does: quotes, empty quotes, backslashes, `=`, `+=` and `:`', () => {
    const words = tildeWords(3000);
    const lines = words.map((w) => `X ${w}`);
    const fromBash = bashWords(lines, dir);
    let exact = 0;
    let expanded = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      const analysis = BashAnalyzer.analyze(line, { home: HOME });
      if (analysis.uncertain.length > 0) continue;
      const cmd = analysis.commands.find((c) => c.words[0]?.value === 'X');
      const got = fromBash[i];
      if (!cmd) continue;
      const args = cmd.words.slice(1);
      if (args.some((w) => w.value === undefined || w.glob)) {
        expect(cmd.dynamic || cmd.globbed, line).toBe(true);
        continue;
      }
      expect(got, line).toEqual(args.map((w) => w.value));
      exact++;
      if (got?.some((w) => w.includes(HOME))) expanded++;
    }
    expect(exact).toBeGreaterThan(1500);
    expect(expanded).toBeGreaterThan(40);
  });

  it('keeps `~` literal after empty quotes and expands it after `+=`', () => {
    const values = (line: string): (string | undefined)[] | undefined => BashAnalyzer.analyze(line, { home: '/h' }).commands[0]?.words.map((w) => w.value);
    expect(values("cat ''a=~/s \"\"~/s a=''~/s ~''/s a=x:''~/s a=~\"\"")).toEqual(['cat', 'a=~/s', '~/s', 'a=~/s', '~/s', 'a=x:~/s', 'a=~']);
    expect(values('printf %s a+=~ a+=x:~/y _=~ ~:x')).toEqual(['printf', '%s', 'a+=/h', 'a+=x:/h/y', '_=/h', '/h:x']);
    expect(BashAnalyzer.analyze('cat a[1]=~/s', { home: '/h' }).uncertain.length).toBeGreaterThan(0);
  });

  it('reports brace expansion, `~user` and `shopt` as uncertain, and expands `~` to the home', () => {
    for (const line of ['cat {/etc/passwd,x}', 'cat x{,}', 'cat {1..3}', 'cat ~root/.bashrc', 'cat ~+/../x', 'cat a=~nobody', 'shopt -s extglob\ncat @(x)', "bash -O extglob -c 'cat x'"]) {
      expect(BashAnalyzer.analyze(line, { home: HOME }).uncertain.length, line).toBeGreaterThan(0);
    }
    expect(BashAnalyzer.analyze('cat ~/x').uncertain.length).toBeGreaterThan(0); // no home known
    const files = BashAnalyzer.analyze('cat ~/x a=~/y "~/z" {} a{b}c', { home: '/h' }).commands[0]?.words.map((w) => w.value);
    expect(files).toEqual(['cat', '/h/x', 'a=/h/y', '~/z', '{}', 'a{b}c']);
  });

  it('cuts command text by bytes, so forms after multi-byte text are right', () => {
    for (const ch of ['é', '€', '😀']) {
      const a = BashAnalyzer.analyze(`echo ${ch}${ch}; rm -rf 'x y' "$Z"`);
      const rm = a.commands.find((c) => c.words[0]?.value === 'rm');
      expect(rm?.raw).toBe(`rm -rf 'x y' "$Z"`);
      expect(rm?.words.map((w) => w.raw)).toEqual(['rm', '-rf', "'x y'", '"$Z"']);
    }
  });
});
