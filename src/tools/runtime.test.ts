import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolError } from '../core/errors.js';
import type { PolicySnapshot, PreparedCall, SessionContext, ToolArgsMap, ToolCall, ToolName, ToolResult } from '../core/types.js';
import { makeContext } from '../testing/context.js';
import { windowsPathProblem } from './jail.js';
import { NodeToolRuntime } from './runtime.js';

const IS_WINDOWS = process.platform === 'win32';

let base: string;
let ws: string;
let outside: string;
let ctx: SessionContext;
let policy: PolicySnapshot;
let rt: NodeToolRuntime;
let outsideBefore: Record<string, string>;
let seq = 0;

/** Every entry under `dir` with its type and content (links are not followed). */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = path.join(d, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) out[p] = `link:${readlinkSync(p)}`;
      else if (st.isDirectory()) {
        out[p] = 'dir';
        walk(p);
      } else out[p] = `file:${readFileSync(p, 'utf8')}`;
    }
  };
  walk(dir);
  return out;
}

function call<K extends ToolName>(tool: K, args: ToolArgsMap[K]): ToolCall {
  return { id: `c${++seq}`, tool, args } as ToolCall;
}

async function prep<K extends ToolName>(tool: K, args: ToolArgsMap[K]): Promise<PreparedCall> {
  return rt.prepare(call(tool, args), ctx, policy);
}

async function run<K extends ToolName>(tool: K, args: ToolArgsMap[K]): Promise<ToolResult> {
  return rt.commit(await prep(tool, args), new AbortController().signal);
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ToolError) return err.code;
    throw err;
  }
  return 'resolved';
}

function link(target: string, at: string): void {
  symlinkSync(target, at, statSync(target, { throwIfNoEntry: false })?.isDirectory() ? 'dir' : 'file');
}

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'acm-tools-')));
  ws = path.join(base, 'ws');
  outside = path.join(base, 'outside');
  mkdirSync(ws);
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'secret.txt'), 'secret value\n');
  mkdirSync(path.join(outside, 'deep'));
  writeFileSync(path.join(outside, 'deep', 'more.txt'), 'secret value too\n');
  ctx = makeContext(ws);
  policy = {
    host: 'generic',
    bashContainment: { mode: 'none' },
    protectedPaths: [`${ws}/.claude/settings*.json`, `${ws}/.claude/hooks/**`, `${ws}/.codex/**`, `${ws}/.mcp.json`],
    payload: null,
  };
  rt = new NodeToolRuntime({ stateDir: path.join(base, 'state') });
  outsideBefore = snapshot(outside);
});

afterEach(() => {
  // Every attack test also asserts that nothing outside the jail changed.
  expect(snapshot(outside)).toEqual(outsideBefore);
  rmSync(base, { recursive: true, force: true });
});

describe('path traversal', () => {
  it('refuses ../, absolute paths outside and ~', async () => {
    // `..` after a missing component fails as the operating system would.
    expect(await code(prep('write', { path: 'a/../../outside/new.txt', content: 'x' }))).toBe('not-found');
    for (const p of ['../outside/secret.txt', `${outside}/secret.txt`, '~/acm-must-not-exist.txt', '~']) {
      expect(await code(prep('read', { path: p }))).toBe('outside-workspace');
      expect(await code(prep('write', { path: p, content: 'x' }))).toBe('outside-workspace');
      expect(await code(prep('edit', { path: p, oldString: 'secret', newString: 'x' }))).toBe('outside-workspace');
    }
    expect(await code(prep('grep', { pattern: 'secret', path: '..' }))).toBe('outside-workspace');
    expect(await code(prep('glob', { pattern: '**/*', path: outside }))).toBe('outside-workspace');
    expect(await code(prep('bash', { command: 'pwd', cwd: '../outside' }))).toBe('outside-workspace');
    expect(existsSync(path.join(os.homedir(), 'acm-must-not-exist.txt'))).toBe(false);
  });

  it('refuses NUL bytes and very long paths', async () => {
    expect(await code(prep('write', { path: 'a\0b', content: 'x' }))).toBe('invalid-args');
    const long = `${'a'.repeat(250)}/`.repeat(40) + 'f.txt';
    const result = await code(run('write', { path: long, content: 'x' }));
    // Windows with long-path support accepts it; it must then be inside the workspace.
    if (result === 'resolved') expect(readFileSync(path.join(ws, long), 'utf8')).toBe('x');
    else {
      expect(['invalid-args', 'tool-error']).toContain(result);
      expect(readdirSync(ws)).toEqual([]);
    }
  });

  it('keeps unicode lookalikes of .. inside the workspace', async () => {
    for (const p of ['\u2025/outside/x.txt', '\uff0e\uff0e/outside/x.txt', '.\u2024/outside/x.txt']) {
      const prepared = await prep('write', { path: p, content: 'x' });
      expect(prepared.tool === 'write' && prepared.effect.absPath.startsWith(`${ws}${path.sep}`)).toBe(true);
    }
  });

  it('flags Windows alias spellings', () => {
    expect(windowsPathProblem('\\\\?\\C:\\x')).not.toBeNull();
    expect(windowsPathProblem('\\\\server\\share\\x')).not.toBeNull();
    expect(windowsPathProblem('C:\\ws\\.env::$DATA')).not.toBeNull();
    expect(windowsPathProblem('C:\\ws\\file.txt:stream')).not.toBeNull();
    expect(windowsPathProblem('C:\\ws\\.git.\\config')).not.toBeNull();
    expect(windowsPathProblem('C:\\ws\\src\\a.ts')).toBeNull();
  });
});

describe.skipIf(IS_WINDOWS)('symlinks', () => {
  beforeEach(() => {
    link(outside, path.join(ws, 'link-out'));
    link(path.join(outside, 'secret.txt'), path.join(ws, 'file-link'));
    symlinkSync(path.join(outside, 'not-yet.txt'), path.join(ws, 'dangling'));
    writeFileSync(path.join(ws, 'inside.txt'), 'inside secret value\n');
  });

  it('does not let read, write or edit follow a link out', async () => {
    for (const p of ['file-link', 'link-out/secret.txt', 'link-out/deep/more.txt', 'dangling', 'link-out/new.txt']) {
      expect(await code(prep('read', { path: p }))).toBe('outside-workspace');
      expect(await code(prep('write', { path: p, content: 'pwned' }))).toBe('outside-workspace');
      expect(await code(prep('edit', { path: p, oldString: 'secret', newString: 'pwned' }))).toBe('outside-workspace');
    }
    expect(await code(prep('grep', { pattern: 'x', path: 'link-out' }))).toBe('outside-workspace');
    expect(await code(prep('glob', { pattern: '*', path: 'link-out' }))).toBe('outside-workspace');
    expect(existsSync(path.join(outside, 'not-yet.txt'))).toBe(false);
  });

  it('does not let grep or glob walk through links', async () => {
    const grep = await run('grep', { pattern: 'secret' });
    expect('matches' in grep ? grep.matches.map((m) => m.file) : []).toEqual([path.join(ws, 'inside.txt')]);
    const glob = await run('glob', { pattern: '**/*' });
    expect('files' in glob ? glob.files : []).toEqual([path.join(ws, 'inside.txt')]);
  });

  it('refuses a write when the file was swapped for a link after prepare', async () => {
    writeFileSync(path.join(ws, 'f.txt'), 'one\n');
    const write = await prep('write', { path: 'f.txt', content: 'pwned\n' });
    const edit = await prep('edit', { path: 'f.txt', oldString: 'one', newString: 'pwned' });
    const read = await prep('read', { path: 'f.txt' });
    rmSync(path.join(ws, 'f.txt'));
    link(path.join(outside, 'secret.txt'), path.join(ws, 'f.txt'));
    const signal = new AbortController().signal;
    expect(await code(rt.commit(write, signal))).toBe('stale');
    expect(await code(rt.commit(edit, signal))).toBe('stale');
    expect(await code(rt.commit(read, signal))).toBe('stale');
  });

  it('refuses a create when a link appears at the name after prepare', async () => {
    const write = await prep('write', { path: 'new.txt', content: 'pwned\n' });
    symlinkSync(path.join(outside, 'created-by-link.txt'), path.join(ws, 'new.txt'));
    expect(await code(rt.commit(write, new AbortController().signal))).toBe('stale');
    expect(existsSync(path.join(outside, 'created-by-link.txt'))).toBe(false);
  });

  it('refuses a write when a parent directory was replaced by a link after prepare', async () => {
    mkdirSync(path.join(ws, 'dir'));
    writeFileSync(path.join(ws, 'dir', 'secret.txt'), 'secret value\n');
    const write = await prep('write', { path: 'dir/secret.txt', content: 'pwned\n' });
    const create = await prep('write', { path: 'dir/fresh.txt', content: 'pwned\n' });
    const nested = await prep('write', { path: 'dir/a/b/c.txt', content: 'pwned\n' });
    renameSync(path.join(ws, 'dir'), path.join(ws, 'dir-moved'));
    link(outside, path.join(ws, 'dir'));
    const signal = new AbortController().signal;
    expect(await code(rt.commit(write, signal))).toBe('stale');
    expect(await code(rt.commit(create, signal))).toBe('stale');
    expect(await code(rt.commit(nested, signal))).toBe('stale');
  });

  it('refuses writing through a link that bash created mid-run', async () => {
    const pending = await prep('write', { path: 'via-later.txt', content: 'pwned\n' });
    const bash = await run('bash', { command: `ln -s ${JSON.stringify(path.join(outside, 'secret.txt'))} via.txt && ln -s ${JSON.stringify(path.join(outside, 'later.txt'))} via-later.txt` });
    expect('exitCode' in bash && bash.exitCode).toBe(0);
    expect(await code(prep('write', { path: 'via.txt', content: 'pwned\n' }))).toBe('outside-workspace');
    expect(await code(rt.commit(pending, new AbortController().signal))).toBe('stale');
    expect(existsSync(path.join(outside, 'later.txt'))).toBe(false);
  });

  it('follows links that stay inside the workspace', async () => {
    link(path.join(ws, 'inside.txt'), path.join(ws, 'alias.txt'));
    const read = await run('read', { path: 'alias.txt' });
    expect('content' in read && read.path).toBe(path.join(ws, 'inside.txt'));
  });
});

describe('protected paths', () => {
  it('refuses writes and edits to host config and .git, but allows reads', async () => {
    mkdirSync(path.join(ws, '.git'));
    writeFileSync(path.join(ws, '.git', 'config'), '[core]\n');
    mkdirSync(path.join(ws, '.claude'));
    writeFileSync(path.join(ws, '.claude', 'settings.json'), '{}\n');
    for (const p of ['.claude/settings.json', '.claude/settings.local.json', '.codex/config.toml', '.git/config', '.git/hooks/pre-commit', 'sub/.git/config', '.mcp.json']) {
      expect(await code(prep('write', { path: p, content: 'x' }))).toBe('protected-path');
    }
    expect(await code(prep('edit', { path: '.git/config', oldString: '[core]', newString: '[x]' }))).toBe('protected-path');
    expect(await code(prep('edit', { path: '.claude/settings.json', oldString: '{}', newString: '{"x":1}' }))).toBe('protected-path');
    const read = await run('read', { path: '.git/config' });
    expect('content' in read && read.content).toBe('[core]\n');
    expect(readFileSync(path.join(ws, '.git', 'config'), 'utf8')).toBe('[core]\n');
  });

  it.skipIf(IS_WINDOWS)('matches patterns written through an alias of the workspace', async () => {
    const alias = path.join(base, 'alias');
    link(ws, alias);
    const aliasCtx = makeContext(alias);
    const p = { ...policy, protectedPaths: [`${alias}/.claude/settings*.json`, `${alias}/.codex/**`] };
    expect(await code(rt.prepare(call('write', { path: '.claude/settings.json', content: '{}' }), aliasCtx, p))).toBe('protected-path');
    expect(await code(rt.prepare(call('write', { path: '.codex/config.toml', content: '' }), aliasCtx, p))).toBe('protected-path');
    expect(await code(rt.prepare(call('write', { path: 'ok.txt', content: '' }), aliasCtx, p))).toBe('resolved');
  });

  it('expands ~ in protected patterns', async () => {
    const home = path.join(ws, 'home');
    mkdirSync(home);
    const homeCtx = makeContext(ws);
    const p = { ...policy, protectedPaths: [`~/.claude/**`] };
    const prevHome = process.env['HOME'];
    process.env['HOME'] = home;
    try {
      if (os.homedir() !== home) return; // os.homedir ignores HOME on this platform
      expect(await code(rt.prepare(call('write', { path: 'home/.claude/x.json', content: '1' }), homeCtx, p))).toBe('protected-path');
    } finally {
      process.env['HOME'] = prevHome;
    }
  });
});

describe('write and edit', () => {
  it('refuses an ambiguous edit without writing', async () => {
    writeFileSync(path.join(ws, 'a.ts'), 'x = 1\ny = 2\nx = 1\n');
    expect(await code(prep('edit', { path: 'a.ts', oldString: 'x = 1', newString: 'x = 3' }))).toBe('invalid-args');
    expect(await code(prep('edit', { path: 'a.ts', oldString: 'nothing like it', newString: 'z' }))).toBe('not-found');
    expect(readFileSync(path.join(ws, 'a.ts'), 'utf8')).toBe('x = 1\ny = 2\nx = 1\n');
  });

  it('refuses a commit when the file changed after prepare', async () => {
    writeFileSync(path.join(ws, 'a.ts'), 'x = 1\n');
    const edit = await prep('edit', { path: 'a.ts', oldString: 'x = 1', newString: 'x = 2' });
    const write = await prep('write', { path: 'a.ts', content: 'overwritten\n' });
    writeFileSync(path.join(ws, 'a.ts'), 'x = 1 // changed\n');
    expect(await code(rt.commit(edit, new AbortController().signal))).toBe('stale');
    expect(await code(rt.commit(write, new AbortController().signal))).toBe('stale');
    expect(readFileSync(path.join(ws, 'a.ts'), 'utf8')).toBe('x = 1 // changed\n');

    const create = await prep('write', { path: 'b.ts', content: 'mine\n' });
    writeFileSync(path.join(ws, 'b.ts'), 'theirs\n');
    expect(await code(rt.commit(create, new AbortController().signal))).toBe('stale');
    expect(readFileSync(path.join(ws, 'b.ts'), 'utf8')).toBe('theirs\n');
  });

  it('applies a tolerant edit and carries the exact matched text and diff', async () => {
    writeFileSync(path.join(ws, 'f.js'), 'function f() {\n    if (x) {\n        return 1;\n    }\n}\n');
    const prepared = await prep('edit', { path: 'f.js', oldString: 'if (x) {\n    return 1;\n}', newString: 'if (x) {\n    return 2;\n}' });
    if (prepared.tool !== 'edit') throw new Error('unreachable');
    expect(prepared.effect.matchStrategy).toBe('indentation');
    expect(prepared.effect.matchedOldString).toBe('    if (x) {\n        return 1;\n    }');
    expect(prepared.effect.diff).toContain('--- a/f.js\n+++ b/f.js\n');
    expect(prepared.effect.diff).toContain('-        return 1;\n+        return 2;\n');
    const result = await rt.commit(prepared, new AbortController().signal);
    expect('replacements' in result && result.replacements).toBe(1);
    expect(readFileSync(path.join(ws, 'f.js'), 'utf8')).toBe(prepared.effect.afterContent);
  });

  it.skipIf(IS_WINDOWS)('writes atomically, keeps the mode and creates parents', async () => {
    writeFileSync(path.join(ws, 'run.sh'), '#!/bin/sh\necho 1\n');
    chmodSync(path.join(ws, 'run.sh'), 0o751);
    const result = await run('write', { path: 'run.sh', content: '#!/bin/sh\necho 2\n' });
    expect('created' in result && result.created).toBe(false);
    expect(statSync(path.join(ws, 'run.sh')).mode & 0o777).toBe(0o751);
    const created = await run('write', { path: 'new/deep/file.txt', content: 'hi' });
    expect('created' in created && created.created).toBe(true);
    expect(readFileSync(path.join(ws, 'new/deep/file.txt'), 'utf8')).toBe('hi');
    expect(readdirSync(path.join(ws, 'new/deep'))).toEqual(['file.txt']);
  });

  it('refuses edits of binary files and directories', async () => {
    writeFileSync(path.join(ws, 'b.bin'), Buffer.from([0, 1, 2, 3]));
    mkdirSync(path.join(ws, 'd'));
    expect(await code(prep('edit', { path: 'b.bin', oldString: 'a', newString: 'b' }))).toBe('tool-error');
    expect(await code(prep('write', { path: 'd', content: 'x' }))).toBe('invalid-args');
    expect(await code(prep('edit', { path: 'missing.txt', oldString: 'a', newString: 'b' }))).toBe('not-found');
  });
});

describe('read', () => {
  it('returns a window of lines and the total', async () => {
    writeFileSync(path.join(ws, 'r.txt'), 'l1\nl2\nl3\nl4\n');
    const all = await run('read', { path: 'r.txt' });
    expect(all).toEqual({ path: path.join(ws, 'r.txt'), content: 'l1\nl2\nl3\nl4\n', startLine: 1, totalLines: 4, truncated: false });
    const part = await run('read', { path: 'r.txt', offset: 2, limit: 2 });
    expect(part).toEqual({ path: path.join(ws, 'r.txt'), content: 'l2\nl3\n', startLine: 2, totalLines: 4, truncated: true });
  });

  it('returns the exact text, so writing the content back keeps the file byte for byte', async () => {
    for (const text of ['a\nb\n', 'a\nb', 'a\n\n', '\n', '']) {
      writeFileSync(path.join(ws, 'exact.txt'), text);
      const all = await run('read', { path: 'exact.txt' });
      expect('content' in all && all.content).toBe(text);
      const first = await run('read', { path: 'exact.txt', limit: 1 });
      const rest = await run('read', { path: 'exact.txt', offset: 2 });
      expect(('content' in first ? first.content : '') + ('content' in rest ? rest.content : '')).toBe(text);
    }
  });

  it('caps the bytes returned and refuses binary files', async () => {
    writeFileSync(path.join(ws, 'big.txt'), `${'x'.repeat(1000)}\n`.repeat(1000));
    const big = await run('read', { path: 'big.txt' });
    expect('content' in big && big.truncated).toBe(true);
    expect('content' in big && Buffer.byteLength(big.content)).toBeLessThanOrEqual(256 * 1024);
    writeFileSync(path.join(ws, 'b.bin'), Buffer.from([0x89, 0x50, 0, 0, 1]));
    expect(await code(run('read', { path: 'b.bin' }))).toBe('tool-error');
    expect(await code(prep('read', { path: 'missing' }))).toBe('not-found');
  });
});

describe('grep and glob', () => {
  beforeEach(() => {
    mkdirSync(path.join(ws, 'src'));
    mkdirSync(path.join(ws, 'node_modules', 'dep'), { recursive: true });
    mkdirSync(path.join(ws, 'build'));
    mkdirSync(path.join(ws, '.git'));
    writeFileSync(path.join(ws, '.gitignore'), 'build/\n*.log\n!keep.log\n');
    writeFileSync(path.join(ws, 'src', 'a.ts'), 'const needle = 1;\nother\n');
    writeFileSync(path.join(ws, 'src', 'b.js'), 'needle again\n');
    writeFileSync(path.join(ws, 'src', 'nested.ts'), 'NEEDLE upper\n');
    writeFileSync(path.join(ws, 'node_modules', 'dep', 'i.js'), 'needle in deps\n');
    writeFileSync(path.join(ws, 'build', 'out.js'), 'needle built\n');
    writeFileSync(path.join(ws, 'debug.log'), 'needle log\n');
    writeFileSync(path.join(ws, 'keep.log'), 'needle kept\n');
    writeFileSync(path.join(ws, '.git', 'HEAD'), 'needle git\n');
  });

  it('grep skips .git, node_modules and gitignored files', async () => {
    const r = await run('grep', { pattern: 'needle' });
    if (!('matches' in r)) throw new Error('unreachable');
    expect(r.matches.map((m) => path.relative(ws, m.file)).sort()).toEqual(['keep.log', path.join('src', 'a.ts'), path.join('src', 'b.js')]);
    const ci = await run('grep', { pattern: 'needle', ignoreCase: true, glob: '*.ts' });
    if (!('matches' in ci)) throw new Error('unreachable');
    expect(ci.matches.map((m) => [path.basename(m.file), m.line, m.text])).toEqual([
      ['a.ts', 1, 'const needle = 1;'],
      ['nested.ts', 1, 'NEEDLE upper'],
    ]);
    const capped = await run('grep', { pattern: 'needle', maxResults: 1 });
    expect('matches' in capped && [capped.matches.length, capped.truncated]).toEqual([1, true]);
    expect(await code(prep('grep', { pattern: '(' }))).toBe('invalid-args');
  });

  it('glob lists sorted files with the same ignores', async () => {
    const r = await run('glob', { pattern: '**/*.{ts,js}' });
    expect('files' in r && r.files).toEqual([path.join(ws, 'src', 'a.ts'), path.join(ws, 'src', 'b.js'), path.join(ws, 'src', 'nested.ts')]);
    const capped = await run('glob', { pattern: '**/*', maxResults: 2 });
    expect('files' in capped && [capped.files.length, capped.truncated]).toEqual([2, true]);
    expect(await code(prep('glob', { pattern: `${outside}/*` }))).toBe('invalid-args');
  });
});

describe.skipIf(IS_WINDOWS)('bash cwd', () => {
  it('moves a non-default cwd into the command and keeps the effect cwd at the session cwd', async () => {
    mkdirSync(path.join(ws, "it's here"));
    const prepared = await prep('bash', { command: 'pwd', cwd: "it's here" });
    if (prepared.tool !== 'bash') throw new Error('unreachable');
    expect(prepared.effect.cwd).toBe(ws);
    expect(prepared.effect.command).toBe(`cd -- '${ws}/it'\\''s here' && pwd`);
    expect(prepared.args.command).toBe(prepared.effect.command);
    expect(prepared.effect.timeoutMs).toBe(120_000);
    const result = await rt.commit(prepared, new AbortController().signal);
    expect('stdout' in result && result.stdout.trim()).toBe(path.join(ws, "it's here"));
    const same = await prep('bash', { command: 'pwd', cwd: '.' });
    expect(same.tool === 'bash' && same.effect.command).toBe('pwd');
  });
});

describe.runIf(!IS_WINDOWS)('protected-path watch around bash', () => {
  const observe = () => {
    const warnings: string[] = [];
    return { warnings, observer: { warn: (m: string) => warnings.push(m) } };
  };
  const signal = () => new AbortController().signal;

  it('warns when a watched file changes during bash and keeps the result', async () => {
    const o = observe();
    mkdirSync(path.join(ws, '.claude'));
    const p = await prep('bash', { command: `printf hi; node -e "require('fs').writeFileSync('.claude/settings.local.json', '{}')"` });
    const result = await rt.commit(p, signal(), undefined, o.observer);
    expect(result).toMatchObject({ exitCode: 0, stdout: 'hi' });
    expect(o.warnings).toEqual([`protected path changed during bash call ${p.id}: ${path.join(ws, '.claude', 'settings.local.json')}`]);
  });

  it('checks after a failing or timed-out command too', async () => {
    const o = observe();
    mkdirSync(path.join(ws, '.claude'));
    const p = await prep('bash', { command: `touch .claude/settings.json; sleep 5`, timeoutMs: 300 });
    const result = await rt.commit(p, signal(), undefined, o.observer);
    expect(result).toMatchObject({ timedOut: true });
    expect(o.warnings.join('\n')).toContain('protected path changed during bash call');
  });

  it('reports what changed between bash calls and at the end of the run', async () => {
    const o = observe();
    mkdirSync(path.join(ws, '.claude'));
    await rt.commit(await prep('bash', { command: 'true' }), signal(), undefined, o.observer);
    writeFileSync(path.join(ws, '.mcp.json'), '{}');
    const second = await prep('bash', { command: 'true' });
    await rt.commit(second, signal(), undefined, o.observer);
    writeFileSync(path.join(ws, '.claude', 'settings.json'), '{}');
    await rt.finishRun(o.observer);
    expect(o.warnings).toEqual([
      `protected path changed during the run, after bash call ${second.id.replace(/\d+$/, (n) => String(Number(n) - 1))}: ${path.join(ws, '.mcp.json')}`,
      `protected path changed during the run, after bash call ${second.id}: ${path.join(ws, '.claude', 'settings.json')}`,
    ]);
  });

  it('refuses the command when the watched paths cannot be fingerprinted before it runs', async () => {
    policy = { ...policy, watchedPaths: [`${path.parse(ws).root}**/.codex/**`] };
    const p = await prep('bash', { command: 'touch ran.txt' });
    expect(await code(rt.commit(p, signal(), undefined, observe().observer))).toBe('containment-unavailable');
    expect(existsSync(path.join(ws, 'ran.txt'))).toBe(false);
  });

  it('a bash call with nothing watched changed adds no warning', async () => {
    const o = observe();
    await rt.commit(await prep('bash', { command: 'echo x > plain.txt' }), signal(), undefined, o.observer);
    await rt.finishRun(o.observer);
    expect(o.warnings).toEqual([]);
  });
});
