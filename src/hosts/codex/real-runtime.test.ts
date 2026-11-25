import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Dispatcher } from '../../core/dispatcher.js';
import type { SessionContext } from '../../core/types.js';
import { NodeToolRuntime } from '../../tools/runtime.js';
import { CodexHostAdapter } from './adapter.js';
import { memoryIo } from './test-io.js';

const hasRg = spawnSync('rg', ['--version']).status === 0;
const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'acm-codex-real-')));
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe.runIf(process.platform === 'linux' || process.platform === 'darwin')('Codex adapter over the real tool runtime', () => {
  const ws = path.join(base, 'ws');
  mkdirSync(ws, { recursive: true });
  writeFileSync(path.join(ws, 'a.ts'), 'needle\n');

  async function dispatcher(mode: string) {
    const c: SessionContext = { host: 'codex', cwd: ws, roots: [], permissionMode: 'default', sources: {}, sandboxMode: mode };
    const a = new CodexHostAdapter({ io: () => memoryIo({ argv: ['codex', '-s', mode, '-a', 'never'], dirs: [ws] }), stateDir: path.join(base, 'state'), tmpDirs: { slashTmp: '/tmp', tmpdir: null } });
    const policy = await a.loadPolicy(c);
    if ('error' in policy) throw new Error(policy.error);
    return new Dispatcher({ adapter: a, tools: new NodeToolRuntime({ stateDir: path.join(base, 'state') }), ctx: c, policy });
  }

  it('runs bash and grep under workspace-write, and the sandbox denies writing .codex', async () => {
    const d = await dispatcher('workspace-write');
    const bash = await d.dispatch('bash', { command: 'echo hello > out.txt && cat out.txt' });
    expect(bash).toMatchObject({ ok: true, value: { exitCode: 0, stdout: 'hello\n' } });
    if (hasRg) {
      expect(await d.dispatch('grep', { pattern: 'needle' })).toEqual({ ok: true, value: { matches: [{ file: path.join(ws, 'a.ts'), line: 1, text: 'needle' }], truncated: false } });
      expect(await d.dispatch('glob', { pattern: '*.ts' })).toEqual({ ok: true, value: { files: [path.join(ws, 'a.ts')], truncated: false } });
    } else {
      // Without ripgrep a Codex search fails and says why.
      expect(await d.dispatch('grep', { pattern: 'needle' })).toMatchObject({ ok: false, error: { code: 'tool-error', message: expect.stringMatching(/^rg is not installed/) } });
    }
    const blocked = await d.dispatch('bash', { command: 'mkdir -p .codex && echo x > .codex/x' });
    expect(blocked.ok).toBe(true);
    if (blocked.ok && 'exitCode' in blocked.value) expect(blocked.value.exitCode).not.toBe(0);
    expect(existsSync(path.join(ws, '.codex', 'x'))).toBe(false);
  });

  it('denies a forbidden rm disguised as a shell option before -c, leaving the file', async () => {
    writeFileSync(path.join(ws, 'keep.txt'), 'keep\n');
    const c: SessionContext = { host: 'codex', cwd: ws, roots: [], permissionMode: 'default', sources: {}, sandboxMode: 'danger-full-access' };
    const a = new CodexHostAdapter({
      io: () => memoryIo({ files: { '/home/u/.codex/rules/default.rules': 'prefix_rule(pattern=["rm"], decision="forbidden")\n' }, argv: ['codex', '-s', 'danger-full-access', '-a', 'never'], dirs: [ws] }),
      stateDir: path.join(base, 'state'),
      tmpDirs: { slashTmp: '/tmp', tmpdir: null },
    });
    const policy = await a.loadPolicy(c);
    const d = new Dispatcher({ adapter: a, tools: new NodeToolRuntime({ stateDir: path.join(base, 'state') }), ctx: c, policy });
    for (const cmd of ["bash -O extglob -c 'rm -f keep.txt'", "bash -o posix -c 'rm -f keep.txt'", "$'\\x72m' -f keep.txt"]) {
      expect(await d.dispatch('bash', { command: cmd }), cmd).toMatchObject({ ok: false, error: { code: 'denied' } });
    }
    expect(existsSync(path.join(ws, 'keep.txt'))).toBe(true);
  });
});

describe('grep pattern dialect at prepare', () => {
  it('names both engines and ignoreCase for a Rust-only pattern', async () => {
    const ws = path.join(base, 'dialect');
    mkdirSync(ws, { recursive: true });
    const c: SessionContext = { host: 'codex', cwd: ws, roots: [], permissionMode: 'default', sources: {}, sandboxMode: 'danger-full-access' };
    const a = new CodexHostAdapter({ io: () => memoryIo({ argv: ['codex', '-s', 'danger-full-access'], dirs: [ws] }), stateDir: path.join(base, 'state'), tmpDirs: { slashTmp: null, tmpdir: null } });
    const policy = await a.loadPolicy(c);
    const tools = new NodeToolRuntime({ stateDir: path.join(base, 'state') });
    const reply = await new Dispatcher({ adapter: a, tools, ctx: c, policy }).dispatch('grep', { pattern: '(?i)todo' });
    expect(reply).toMatchObject({ ok: false, error: { code: 'invalid-args', message: expect.stringMatching(/both JavaScript and ripgrep.*ignoreCase/s) } });
  });
});
