import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { INEXACT, splitShellCommands } from './shell.js';

/**
 * Oracle: bash itself. Every word the Codex splitter hands the exec policy is
 * either marked inexact (a rule that could match it then asks, which approval
 * `never` denies) or exactly the word bash hands the command.
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

describe.runIf(posix)('Codex splitter words against bash', () => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'acm-codex-words-')));
  for (const f of ['a.txt', 'b.txt', 'ab']) writeFileSync(path.join(dir, f), '');
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('hands rules the word bash runs, or marks it inexact', () => {
    const r = rng(SEED);
    const words: string[] = [...PIECES];
    for (let i = 0; i < 600; i++) {
      const n = 1 + Math.floor(r() * 3);
      words.push(Array.from({ length: n }, () => PIECES[Math.floor(r() * PIECES.length)] ?? '').join(''));
    }
    const lines = words.map((w) => `X ${w}`);
    const fromBash = bashWords(lines, dir);
    let exact = 0;
    let inexact = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      let argv: readonly string[] | undefined;
      try {
        argv = splitShellCommands(line).commands.find((c) => c[0] === 'X');
      } catch {
        continue; // unparsable: the adapter denies it
      }
      const got = fromBash[i];
      if (!argv) continue;
      const args = argv.slice(1);
      if (args.some((a) => a.startsWith(INEXACT))) {
        inexact++;
        continue;
      }
      expect(got, line).toEqual(args);
      exact++;
    }
    expect(exact).toBeGreaterThan(150);
    expect(inexact).toBeGreaterThan(150);
  });
});
