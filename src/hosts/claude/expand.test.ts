import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors.js';
import type { PolicySnapshot, PreparedCallOf, SessionContext } from '../../core/types.js';
import { makeContext } from '../../testing/index.js';
import { expandBashGlobs, findBash } from '../../tools/bash.js';
import { Jail } from '../../tools/jail.js';
import { NodeToolRuntime } from '../../tools/runtime.js';
import { ClaudeHostAdapter, type ClaudePolicy } from './adapter.js';
import { READERS, planGlobExpansion } from './expand.js';

/**
 * Properties of the glob expansion of pure readers, checked against bash
 * itself as the oracle: the same bash the tool runtime runs commands with
 * (`findBash()`), in the same environment, under more than one collation
 * (the order of glob matches follows the locale):
 * - the expanded command passes the reader exactly the arguments bash would
 *   have passed for the command as written (same files, same order, same
 *   options), plus the `--` the rewrite inserts;
 * - the entries prepare validated are exactly the files the globs gave the
 *   reader;
 * - the rules decide the expanded command as they decide the same command
 *   with the files written by hand;
 * - every command outside the supported grammar is left as written.
 */

const posix = process.platform !== 'win32';

/** Deterministic PRNG (mulberry32). */
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

const FILES = [
  'a.js', 'b.js', 'B.js', 'c.txt', '10.txt', '9.txt', 'a b.js', "it's.js", 'q"x.js', '-n', '--lines=1', 'new\nline.js', 'é.js', 'e.js',
  '.hidden.js', '[x].js', 'star*.js', 'd1/x.txt', 'd1/y.js', 'd1/.dot.txt', 'd2/sub/z.js', 'd2/w.txt', 'z.md',
];

const GLOBS = ['*', '*.js', '*.txt', '?.js', 'd?/*', 'd1/*.txt', '[a-c]*', '[!a]*.js', '.*.js', '"a "*', "'it'*", '\\[x\\]*', 'star\\**', 'd2/*/*', '*/y.js', '[0-9]*', '?', 'e*', 'é*'];

const LITERALS = ['a.js', "'a b.js'", 'd1/x.txt', '-'];

/** Valid options for a reader, as words. */
function options(reader: string, r: () => number): string[] {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const sets: Record<string, readonly string[][]> = {
    cat: [['-n'], ['-A'], ['-bs'], ['--number'], ['--show-ends']],
    head: [['-n', '3'], ['-n3'], ['-c', '5'], ['-q'], ['-v'], ['-5'], ['--lines=2'], ['--bytes', '4']],
    tail: [['-n', '+2'], ['-c3'], ['-q'], ['-2'], ['--lines=1']],
    wc: [['-l'], ['-lw'], ['-c'], ['--words'], ['-L']],
    ls: [['-l'], ['-la'], ['-1'], ['-d'], ['--color=never'], ['-hS']],
  };
  const out: string[] = [];
  const n = Math.floor(r() * 3);
  for (let i = 0; i < n; i++) out.push(...pick(sets[reader] ?? [[]]));
  return out;
}

/** A command with one reader call, maybe inside a list or pipeline. */
function command(r: () => number): string {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const reader = pick(Object.keys(READERS));
  const words = [reader, ...options(reader, r)];
  if (r() < 0.15) words.push('--');
  const operands = 1 + Math.floor(r() * 3);
  for (let i = 0; i < operands; i++) words.push(r() < 0.75 ? pick(GLOBS) : pick(LITERALS));
  const call = words.join(' ');
  return pick([call, `${call} | tr a a`, `true && ${call}`, `${call}; echo done`]);
}

/** Arguments bash passes each reader for `cmd` in `cwd` (readers replaced by functions that print them). */
function bashArgv(cmd: string, cwd: string): string[][] {
  const fns = Object.keys(READERS)
    .map((name) => `${name}() { printf '%s\\0' "<${name}>" "$@"; printf '\\1'; }`)
    .join('\n');
  const shell = findBash();
  if (shell === null) throw new Error('no bash');
  // The environment `runBash` gives the command.
  const r = spawnSync(shell, ['-c', `${fns}\n${cmd}`], { cwd, env: process.env, encoding: 'utf8' });
  if (r.status === null) throw new Error(`bash failed: ${r.stderr}`);
  return r.stdout
    .split('\x01')
    .filter((chunk) => chunk.includes('\0'))
    .map((chunk) => chunk.slice(chunk.indexOf('<')).split('\0').slice(0, -1));
}

interface Lab {
  readonly ws: string;
  readonly base: string;
  readonly ctx: SessionContext;
  readonly tools: NodeToolRuntime;
  policy(permissions: Record<string, unknown>, mode?: string): Promise<{ adapter: ClaudeHostAdapter; policy: PolicySnapshot<ClaudePolicy>; ctx: SessionContext }>;
}

/** Whether names in `dir` are case-sensitive: a file created as `case-probe` is not found as `CASE-PROBE`. */
async function isCaseSensitive(dir: string): Promise<boolean> {
  const probe = path.join(dir, 'case-probe');
  await writeFile(probe, '');
  try {
    return !(await access(path.join(dir, 'CASE-PROBE')).then(() => true, () => false));
  } finally {
    await rm(probe, { force: true });
  }
}

async function makeLab(): Promise<Lab> {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'acm-expand-')));
  const ws = path.join(base, 'ws');
  const home = path.join(base, 'home');
  await mkdir(path.join(home, '.claude'), { recursive: true });
  // `b.js` and `B.js` are one file where names ignore case (APFS, NTFS): keep only `B.js` there, which still orders differently by locale.
  const caseSensitive = await isCaseSensitive(base);
  for (const rel of FILES) {
    if (!caseSensitive && rel === 'b.js') continue;
    await mkdir(path.dirname(path.join(ws, rel)), { recursive: true });
    await writeFile(path.join(ws, rel), `content of ${rel}\nline 2\n`);
  }
  await symlink('a.js', path.join(ws, 'link.js'));
  const ctx = makeContext(ws, { host: 'claude', permissionMode: 'default', sources: { cwd: 'roots' } });
  const tools = new NodeToolRuntime({ stateDir: path.join(base, 'state') });
  return {
    ws,
    base,
    ctx,
    tools,
    async policy(permissions, mode) {
      await writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({ permissions }));
      const adapter = new ClaudeHostAdapter({ env: {}, home, managedDir: null, stateDir: path.join(base, 'state'), readParent: async () => undefined });
      const c = mode === undefined ? ctx : { ...ctx, permissionMode: mode, sources: { ...ctx.sources, permissionMode: 'ctx-file' as const } };
      const policy = await adapter.loadPolicy(c);
      if ('error' in policy) throw new Error(policy.error);
      return { adapter, policy, ctx: c };
    },
  };
}

async function prepareBash(lab: Lab, policy: PolicySnapshot, command: string): Promise<PreparedCallOf<'bash'>> {
  const prepared = await lab.tools.prepare({ id: 'c1', tool: 'bash', args: { command } }, lab.ctx, policy);
  if (prepared.tool !== 'bash') throw new Error('not bash');
  return prepared;
}

describe.runIf(posix)('glob expansion of pure readers', () => {
  let lab: Lab;
  beforeAll(async () => {
    lab = await makeLab();
  });
  afterAll(async () => {
    await rm(lab.base, { recursive: true, force: true });
  });

  /** Locales whose collations order names differently (`B.js` vs `a.js`, `é.js` vs `e.js`); those installed are used. */
  const LOCALES = ['C', 'en_US.UTF-8', 'pt_BR.UTF-8', 'C.UTF-8'].filter(
    (l) => l === 'C' || spawnSync('locale', ['-a'], { encoding: 'utf8' }).stdout.toLowerCase().replace(/-/g, '').split('\n').includes(l.toLowerCase().replace(/-/g, '')),
  );

  it.each(LOCALES)('passes each reader exactly the arguments bash would (LC_ALL=%s), and validates exactly the globbed files', async (locale) => {
    const saved = process.env['LC_ALL'];
    process.env['LC_ALL'] = locale;
    try {
      await readerProperty(locale);
    } finally {
      if (saved === undefined) delete process.env['LC_ALL'];
      else process.env['LC_ALL'] = saved;
    }
  });

  it('orders matches as the locale does, not by byte', async () => {
    const utf8 = LOCALES.find((l) => l !== 'C');
    if (utf8 === undefined) return;
    const { policy } = await lab.policy({ allow: ['Bash'] });
    const saved = process.env['LC_ALL'];
    try {
      process.env['LC_ALL'] = 'C';
      const c = (await prepareBash(lab, policy, 'cat [aBe]*.js')).effect.command;
      process.env['LC_ALL'] = utf8;
      const u = (await prepareBash(lab, policy, 'cat [aBe]*.js')).effect.command;
      expect(c).toMatch(/^cat -- 'B\.js' 'a b\.js' 'a\.js' 'e\.js'$/);
      expect(u).not.toBe(c); // `B.js` sorts among the `b`s in a UTF-8 collation
    } finally {
      if (saved === undefined) delete process.env['LC_ALL'];
      else process.env['LC_ALL'] = saved;
    }
  });

  it('does not expand on Windows (Git Bash): the command stays as written', async () => {
    const plan = planGlobExpansion('cat *.js');
    if (!plan) throw new Error('no plan');
    const jail = await Jail.create({ cwd: lab.ws, roots: [], protectedPaths: [] });
    expect(await expandBashGlobs(plan, lab.ws, jail, undefined, 'win32')).toBeUndefined();
    expect(await expandBashGlobs(plan, lab.ws, jail, undefined, 'linux')).toMatchObject({ command: expect.stringMatching(/^cat -- /) });
  });

  async function readerProperty(locale: string): Promise<void> {
    const { policy } = await lab.policy({ allow: ['Bash'] });
    const r = rng(20261116 + locale.length);
    let expanded = 0;
    let refused = 0;
    for (let i = 0; i < 200; i++) {
      const cmd = command(r);
      let prepared: PreparedCallOf<'bash'>;
      try {
        prepared = await prepareBash(lab, policy, cmd);
      } catch (err) {
        // A glob that matches a directory for a file reader is refused, never run.
        expect(err, cmd).toBeInstanceOf(ToolError);
        expect(err instanceof ToolError ? err.message : '', cmd).toMatch(/is a directory/);
        refused++;
        continue;
      }
      const expansion = prepared.effect.expansion;
      if (expansion === undefined) {
        // Left as written only when some glob matched nothing (bash would pass it literally).
        expect(prepared.effect.command, cmd).toBe(cmd);
        continue;
      }
      expanded++;
      expect(expansion.original, cmd).toBe(cmd);
      const want = bashArgv(cmd, lab.ws);
      const got = bashArgv(prepared.effect.command, lab.ws);
      expect(got.length, cmd).toBe(want.length);
      for (let k = 0; k < want.length; k++) {
        const w = want[k] ?? [];
        const g = [...(got[k] ?? [])];
        // The rewrite has a `--` before the operands; it added it when the command had none.
        const at = g.indexOf('--');
        expect(at, `${cmd}\n${prepared.effect.command}`).toBeGreaterThan(0);
        if (!w.includes('--')) g.splice(at, 1);
        expect(g, `${cmd}\n${prepared.effect.command}`).toEqual(w);
      }
      // The validated entries are exactly what bash expands each glob word to, in order.
      const globs = planGlobExpansion(cmd)?.globs ?? [];
      const fromBash = globs.flatMap((glob) => (bashArgv(`cat -- ${glob.raw}`, lab.ws)[0] ?? []).slice(2).map((a) => path.resolve(lab.ws, a)));
      expect(expansion.entries.map((e) => e.path), cmd).toEqual(fromBash);
    }
    // The property is not vacuous.
    expect(expanded, locale).toBeGreaterThan(70);
    expect(refused, locale).toBeGreaterThan(5);
  }

  it('decides the expanded command as the rules decide the files written by hand', async () => {
    const ruleSets: { permissions: Record<string, unknown>; mode?: string }[] = [
      { permissions: { allow: ['Bash'] } },
      { permissions: { allow: ['Bash(cat:*)', 'Bash(wc:*)', 'Bash(ls:*)', 'Bash(head:*)'] } },
      { permissions: { allow: ['Bash'], deny: ['Read(./a.js)'] } },
      { permissions: { allow: ['Bash(tail:*)', 'Bash(wc -l:*)'], ask: ['Read(./d1/**)'] } },
      { permissions: { deny: ['Read(./*.txt)'] }, mode: 'bypassPermissions' },
      { permissions: { allow: ['Read'] }, mode: 'acceptEdits' },
    ];
    const r = rng(7);
    const cmds = Array.from({ length: 120 }, () => command(r));
    let compared = 0;
    for (const set of ruleSets) {
      const { adapter, policy, ctx } = await lab.policy(set.permissions, set.mode);
      for (const cmd of cmds) {
        let prepared: PreparedCallOf<'bash'>;
        try {
          prepared = await prepareBash(lab, policy, cmd);
        } catch {
          continue;
        }
        if (prepared.effect.expansion === undefined) continue;
        // By hand: the same files, without the inserted `--` unless a file name needs it.
        const c = prepared.effect.command;
        const byHand = /(^| )'-/.test(c) ? c : c.replaceAll(" -- '", " '");
        const handPrepared: PreparedCallOf<'bash'> = { ...prepared, args: { ...prepared.args, command: byHand }, effect: { command: byHand, cwd: prepared.effect.cwd, timeoutMs: prepared.effect.timeoutMs, containment: prepared.effect.containment } };
        const a = adapter.checkStatic(prepared, ctx, policy).kind;
        const b = adapter.checkStatic(handPrepared, ctx, policy).kind;
        expect(a, `${JSON.stringify(set)}\n${cmd}\n${prepared.effect.command}\n${byHand}`).toBe(b);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(200);
  });

  it('leaves every command outside the grammar as written', async () => {
    const { policy } = await lab.policy({ allow: ['Bash'] });
    const outside = [
      'cat $(ls)', 'cat `ls`', 'cat $F*', 'cat "$F"*', 'cat ${D}/*', 'cat *.js > out.txt', 'cat < a.js *.js', 'wc -l *.js 2>/dev/null', 'cat *.js 2>&1',
      'ls -R *', 'ls --recursive d*', 'ls -lR d*', 'ls -L *', 'ls --dereference *', 'cat ../*', 'cat d1/../*', 'cat /etc/*', 'cat ~/*', 'cat ~/x/*',
      'cat -x *', 'cat --bogus *', 'wc --files0-from=a.js *', 'tail -f *.js', 'tail --follow *.js', 'head -n x *.js', 'cat *.js -n', 'cat a.js -n *.js',
      'cat {a,b}.js', 'cat *.{js,txt}', 'cat **/*.js', 'cd d1 && cat *', 'pushd d1; cat *', '(cat *.js)', '{ cat *.js; }',
      'for f in *.js; do cat $f; done', 'if true; then cat *.js; fi', 'f() { cat *.js; }; f', 'cat() { echo; }; cat *.js', 'X=1 cat *.js', 'rg x *.js',
      'sort *.js', '/bin/cat *.js', 'command cat *.js', 'timeout 5 cat *.js', 'eval cat *.js', 'bash -c "cat *.js"', 'cat $\'*\'.js', 'cat $"*".js',
      'echo $(cat *.js)', 'cat <(cat *.js)', 'cat d1/', 'cat d1//*.txt', 'cat *.js/',
    ];
    for (const cmd of outside) {
      expect(planGlobExpansion(cmd), cmd).toBeUndefined();
      const prepared = await prepareBash(lab, policy, cmd);
      expect(prepared.effect.command, cmd).toBe(cmd);
      expect(prepared.effect.expansion, cmd).toBeUndefined();
    }
  });

  it('expands only the reader parts of a compound command', async () => {
    const { policy } = await lab.policy({ allow: ['Bash'] });
    const prepared = await prepareBash(lab, policy, 'ls d1; wc -l d1/* d2/w.txt; node --test 2>&1 | head -80; cat *.md');
    expect(prepared.effect.command).toBe("ls d1; wc -l -- 'd1/x.txt' 'd1/y.js' d2/w.txt; node --test 2>&1 | head -80; cat -- 'z.md'");
  });

  it('refuses a glob with more matches than the cap instead of running a partial list', async () => {
    const { policy } = await lab.policy({ allow: ['Bash'] });
    await mkdir(path.join(lab.ws, 'many'));
    await Promise.all(Array.from({ length: 1001 }, (_, i) => writeFile(path.join(lab.ws, 'many', `f${i}.txt`), 'x\n')));
    await expect(prepareBash(lab, policy, 'wc -l many/*')).rejects.toThrow(/more than 1000 entries/);
    await rm(path.join(lab.ws, 'many'), { recursive: true });
  });

  it('keeps a symbolic link inside the workspace and records what it points to', async () => {
    const { policy } = await lab.policy({ allow: ['Bash'] });
    const prepared = await prepareBash(lab, policy, 'cat lin*');
    expect(prepared.effect.command).toBe("cat -- 'link.js'");
    const [entry] = prepared.effect.expansion?.entries ?? [];
    expect(entry?.identity).toMatch(/:link$/);
    expect(entry?.targetIdentity).toMatch(/:file$/);
  });
});
