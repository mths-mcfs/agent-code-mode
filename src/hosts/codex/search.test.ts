import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors.js';
import type { BashResult, PreparedCallOf } from '../../core/types.js';
import { globCommand, grepCommand, lowerSearch, parseGlob, parseGrep } from './search.js';
import { splitShellCommands } from './shell.js';

const grep = (over: Partial<PreparedCallOf<'grep'>['effect']> = {}): PreparedCallOf<'grep'> => {
  const effect = { absRoot: '/w', pattern: 'x', glob: null, ignoreCase: false, maxResults: 2, ...over };
  return { id: 'c1', tool: 'grep', args: { pattern: effect.pattern, path: effect.absRoot }, effect };
};
const glob = (over: Partial<PreparedCallOf<'glob'>['effect']> = {}): PreparedCallOf<'glob'> => {
  const effect = { absRoot: '/w', pattern: '*.ts', maxResults: 2, ...over };
  return { id: 'c1', tool: 'glob', args: { pattern: effect.pattern, path: effect.absRoot }, effect };
};
const out = (stdout: string, over: Partial<BashResult> = {}): BashResult => ({ exitCode: 0, signal: null, stdout, stderr: '', truncated: false, timedOut: false, ...over });
const match = (file: string, line: number, text: string): string => `${JSON.stringify({ type: 'match', data: { path: { text: file }, lines: { text: `${text}\n` }, line_number: line } })}\n`;
const begin = (file: string): string => `${JSON.stringify({ type: 'begin', data: { path: { text: file } } })}\n`;

function toolError(fn: () => unknown): ToolError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ToolError) return err;
    throw err;
  }
  throw new Error('expected a ToolError');
}

describe('search commands', () => {
  it('puts every part of the effect in the command, with .git excluded last', () => {
    expect(grepCommand(grep({ glob: '*.ts', ignoreCase: true }))).toBe("rg --json --no-config --no-require-git --sort path --hidden -i -g '*.ts' -g '!.git' -e 'x' -- '/w' | head -n 9");
    expect(grepCommand(grep({ maxResults: 5 }))).not.toBe(grepCommand(grep({ maxResults: 6 })));
    expect(globCommand(glob())).toBe("rg --files --null --no-config --no-require-git --sort path --hidden -g '*.ts' -g '!.git' -- '/w'");
  });

  it('refuses a glob that ripgrep would read as an exclusion, and roots inside .git', () => {
    expect(toolError(() => grepCommand(grep({ glob: '!*.ts' }))).code).toBe('invalid-args');
    expect(toolError(() => globCommand(glob({ pattern: '!x' }))).code).toBe('invalid-args');
    expect(toolError(() => grepCommand(grep({ absRoot: '/w/.git' }))).code).toBe('invalid-args');
    expect(toolError(() => globCommand(glob({ absRoot: '/w/.git/hooks' }))).code).toBe('invalid-args');
    // Windows also takes forward slashes.
    expect(toolError(() => grepCommand(grep({ absRoot: 'C:/repo/.git/x' }))).code).toBe('invalid-args');
  });
});

describe('parsing the rg output', () => {
  it('returns at most maxResults matches and reports more as truncated', () => {
    const three = begin('/w/a.ts') + match('/w/a.ts', 1, 'x one') + match('/w/a.ts', 2, 'x two') + begin('/w/b.ts') + match('/w/b.ts', 7, 'x three\r');
    expect(parseGrep(grep(), out(three))).toEqual({
      matches: [
        { file: '/w/a.ts', line: 1, text: 'x one' },
        { file: '/w/a.ts', line: 2, text: 'x two' },
      ],
      truncated: true,
    });
    expect(parseGrep(grep({ maxResults: 3 }), out(three))).toMatchObject({ truncated: false, matches: [{}, {}, { line: 7, text: 'x three' }] });
    expect(parseGlob(glob(), out('/w/a.ts\0/w/b.ts\0/w/c.ts\0'))).toEqual({ files: ['/w/a.ts', '/w/b.ts'], truncated: true });
    expect(parseGlob(glob(), out('/w/a.ts\0'))).toEqual({ files: ['/w/a.ts'], truncated: false });
    expect(parseGlob(glob(), out(''))).toEqual({ files: [], truncated: false });
  });

  it('reports output cut by the runtime cap as truncated and drops the cut record', () => {
    expect(parseGrep(grep({ maxResults: 9 }), out(`${match('/w/a', 1, 'x')}{"type":"ma`, { truncated: true }))).toEqual({ matches: [{ file: '/w/a', line: 1, text: 'x' }], truncated: true });
    expect(parseGlob(glob({ maxResults: 9 }), out('/w/a\0/w/b\0/w/partia', { truncated: true }))).toEqual({ files: ['/w/a', '/w/b'], truncated: true });
  });

  it('keeps names with newlines, clips long lines and decodes non-UTF-8 lines', () => {
    expect(parseGlob(glob({ maxResults: 9 }), out('/w/odd\nname.ts\0'))).toEqual({ files: ['/w/odd\nname.ts'], truncated: false });
    const latin1 = `${JSON.stringify({ type: 'match', data: { path: { text: '/w/c' }, lines: { bytes: Buffer.from('caf\xe9\n', 'latin1').toString('base64') }, line_number: 1 } })}\n`;
    const r = parseGrep(grep({ maxResults: 9 }), out(match('/w/a\nb', 3, 'y'.repeat(2500)) + latin1));
    expect(r.matches[0]).toMatchObject({ file: '/w/a\nb', line: 3 });
    expect(r.matches[0]?.text).toHaveLength(2001);
    expect(r.matches[1]?.text).toBe('caf�');
  });

  it('refuses output that is not a result of the command', () => {
    for (const bad of ['not json\n', match('/elsewhere/a', 1, 'x'), match('rel', 1, 'x'), '{"type":"match","data":{}}\n']) {
      expect(toolError(() => parseGrep(grep(), out(bad))).code, bad).toBe('tool-error');
    }
    const binaryName = `${JSON.stringify({ type: 'match', data: { path: { bytes: 'L3cv/w==' }, lines: { text: 'x\n' }, line_number: 1 } })}\n`;
    expect(toolError(() => parseGrep(grep(), out(binaryName))).message).toMatch(/not valid UTF-8/);
    expect(toolError(() => parseGlob(glob(), out('relative\0'))).code).toBe('tool-error');
  });

  it('names the regex dialect when rg rejects a pattern', () => {
    const stderr = 'rg: regex parse error:\n    (?<=a)b\n    ^^^^\nerror: look-around, including look-ahead and look-behind, is not supported\n';
    const err = toolError(() => parseGrep(grep({ pattern: '(?<=a)b' }), out('', { stderr })));
    expect(err.code).toBe('invalid-args');
    expect(err.message).toMatch(/Rust regex/);
    expect(err.message).toMatch(/look-around/);
  });

  it('names the command that is missing', () => {
    expect(toolError(() => parseGlob(glob(), out('', { stderr: 'bash: line 1: rg: command not found\n', exitCode: 127 }))).message).toMatch(/^rg is not installed/);
    expect(toolError(() => parseGrep(grep(), out('', { stderr: 'bash: line 1: head: command not found\n' }))).message).toMatch(/^head is not installed/);
    expect(toolError(() => parseGrep(grep(), out('', { stderr: 'sh: 1: rg: not found\n' }))).message).toMatch(/^rg is not installed/);
  });

  it('fails a run that timed out or found nothing but errors', () => {
    expect(toolError(() => parseGrep(grep(), out('', { timedOut: true }))).message).toMatch(/timed out/);
    expect(toolError(() => parseGrep(grep(), out('', { stderr: 'rg: /w: No such file or directory (os error 2)\n' }))).code).toBe('tool-error');
  });
});

const hasRg = process.platform !== 'win32' && spawnSync('rg', ['--version']).status === 0 && spawnSync('bash', ['-c', 'true']).status === 0;

describe.runIf(hasRg)('against the real ripgrep', () => {
  // Collection runs this body even when the suite is skipped: touch the disk only in beforeAll.
  let dir = '';
  beforeAll(() => {
    dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'acm-codex-rg-')));
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(path.join(dir, 'src', 'a.ts'), 'alpha\nbeta alpha\n');
    writeFileSync(path.join(dir, 'src', 'b.ts'), 'alpha\n');
    writeFileSync(path.join(dir, '.hidden.ts'), 'alpha\n');
    writeFileSync(path.join(dir, '-dash.ts'), 'alpha -foo\n');
    writeFileSync(path.join(dir, 'odd\nname.ts'), 'alpha\n');
    mkdirSync(path.join(dir, '.git'));
    writeFileSync(path.join(dir, '.git', 'x.ts'), 'alpha\n');
    writeFileSync(path.join(dir, '.ignore'), 'skipped.ts\n');
    writeFileSync(path.join(dir, 'skipped.ts'), 'alpha\n');
  });
  afterAll(() => {
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  function run(command: string): BashResult {
    const r = spawnSync('bash', ['-c', command], { cwd: dir, encoding: 'utf8' });
    return { exitCode: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, truncated: false, timedOut: false };
  }

  /** The argv bash really passes to rg, captured by shadowing rg with a function. */
  function executedRgArgv(command: string): string[] {
    const shown = execFileSync('bash', ['-c', `rg() { printf '%s\\0' "$@"; }; ${command.replace(/ \| head -n \d+$/, '')}`]);
    return ['rg', ...shown.toString('utf8').split('\0').slice(0, -1)];
  }

  it.each(['-foo', '--', "it's", '$(rm -rf x)', '`x`', '\\$HOME', '~', '{a,b}', '-e', '\\', 'a\\nb', 'ñ'])('evaluates the argv rg receives for grep pattern %j', (pattern) => {
    const cmd = grepCommand(grep({ absRoot: dir, pattern }));
    expect(splitShellCommands(cmd).commands.find((a) => a[0] === 'rg')).toEqual(executedRgArgv(cmd));
  });

  it.each(['-dash*', '--hidden', '*.{ts,txt}', "it's", '**/b.ts', '-'])('evaluates the argv rg receives for glob %j', (pattern) => {
    const cmd = globCommand(glob({ absRoot: dir, pattern }));
    expect(splitShellCommands(cmd).commands.find((a) => a[0] === 'rg')).toEqual(executedRgArgv(cmd));
  });

  it('runs grep in path order, skips .git and ignored files, and truncates at the limit', () => {
    const all = lowerSearch(grep({ absRoot: dir, pattern: 'alpha', maxResults: 50 }));
    const found = all.parse(run(all.command));
    if (!('matches' in found)) throw new Error('not a grep result');
    expect(found.matches.map((m) => path.relative(dir, m.file))).toEqual(['-dash.ts', '.hidden.ts', 'odd\nname.ts', 'src/a.ts', 'src/a.ts', 'src/b.ts']);
    const two = lowerSearch(grep({ absRoot: dir, pattern: 'alpha', maxResults: 2 }));
    expect(two.parse(run(two.command))).toMatchObject({ truncated: true, matches: [{}, {}] });
    const six = lowerSearch(grep({ absRoot: dir, pattern: 'alpha', maxResults: 6 }));
    expect(six.parse(run(six.command))).toMatchObject({ truncated: false });
  });

  it('lists files with globs as rg --glob does: ignored files match, .git never does', () => {
    const files = (pattern: string, maxResults = 50): { files: readonly string[]; truncated: boolean } => {
      const f = lowerSearch(glob({ absRoot: dir, pattern, maxResults }));
      const r = f.parse(run(f.command));
      if (!('files' in r)) throw new Error('not a glob result');
      return r;
    };
    expect(files('*.ts').files.map((p) => path.relative(dir, p))).toEqual(['-dash.ts', '.hidden.ts', 'odd\nname.ts', 'skipped.ts', 'src/a.ts', 'src/b.ts']);
    expect(files('**').files.some((p) => p.split(path.sep).includes('.git'))).toBe(false);
    expect(files('*.ts', 2)).toEqual({ truncated: true, files: [path.join(dir, '-dash.ts'), path.join(dir, '.hidden.ts')] });
  });

  it('applies .gitignore outside a git repository, like the runtime', () => {
    // The fixture has a fake .git, so this needs a temp folder of its own.
    const alone = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'acm-codex-norepo-')));
    try {
      writeFileSync(path.join(alone, '.gitignore'), 'built.ts\n');
      writeFileSync(path.join(alone, 'built.ts'), 'alpha\n');
      writeFileSync(path.join(alone, 'kept.ts'), 'alpha\n');
      const g = lowerSearch(grep({ absRoot: alone, pattern: 'alpha', maxResults: 9 }));
      const r = g.parse(run(g.command));
      if (!('matches' in r)) throw new Error('not a grep result');
      expect(r.matches.map((m) => path.basename(m.file))).toEqual(['kept.ts']);
    } finally {
      rmSync(alone, { recursive: true, force: true });
    }
  });

  it('reports truncation when the listing is larger than the runtime output cap', () => {
    const many = path.join(dir, 'many');
    mkdirSync(many);
    for (let i = 0; i < 300; i++) writeFileSync(path.join(many, `f${String(i).padStart(3, '0')}.txt`), '');
    const f = lowerSearch(glob({ absRoot: many, pattern: '*.txt', maxResults: 1000 }));
    const full = run(f.command);
    // The runtime keeps only the first bytes of stdout and says it cut them.
    const r = f.parse({ ...full, stdout: full.stdout.slice(0, 1000), truncated: true });
    if (!('files' in r)) throw new Error('not a glob result');
    expect(r.truncated).toBe(true);
    expect(r.files.length).toBeGreaterThan(0);
    expect(r.files.length).toBeLessThan(300);
    expect(r.files.every((p) => p.startsWith(path.join(many, 'f')) && p.endsWith('.txt'))).toBe(true);
  });

  it('fails a JavaScript-only pattern with an error naming the syntax, never an empty result', () => {
    for (const pattern of ['(?<=beta )alpha', '(a)\\1']) {
      const g = lowerSearch(grep({ absRoot: dir, pattern }));
      const err = toolError(() => g.parse(run(g.command)));
      expect(err.code, pattern).toBe('invalid-args');
      expect(err.message).toMatch(/Rust regex/);
    }
  });
});
