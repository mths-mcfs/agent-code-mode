import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Dispatcher } from '../../core/dispatcher.js';
import type { SessionContext } from '../../core/types.js';
import { NodeToolRuntime } from '../../tools/runtime.js';
import { CodexHostAdapter } from './adapter.js';
import { nodeConfigIo } from './config.js';
import { commandHookHash } from './hooks.js';

const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'acm-codex-live-')));
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe.runIf(process.platform === 'linux')('live: temp CODEX_HOME, real config, rules and trusted hook, real runtime', () => {
  const codexHome = path.join(base, 'codex-home');
  const ws = path.join(base, 'ws');
  mkdirSync(path.join(codexHome, 'rules'), { recursive: true });
  mkdirSync(ws, { recursive: true });
  const hookScript = path.join(base, 'deny-secret.mjs');
  writeFileSync(hookScript, "import { readFileSync } from 'node:fs';\nconst input = JSON.parse(readFileSync(0, 'utf8'));\nif (String(input.tool_input.command).includes('secret')) { process.stderr.write('searching for secrets is blocked'); process.exit(2); }\n");
  const hookCommand = `"${process.execPath}" "${hookScript}"`;
  writeFileSync(path.join(codexHome, 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: hookCommand }] }] } }));
  const hash = commandHookHash({ matcher: 'Bash', command: hookCommand, timeoutSec: 600, async: false });
  writeFileSync(
    path.join(codexHome, 'config.toml'),
    `sandbox_mode = "workspace-write"\napproval_policy = "never"\n\n[hooks.state."${path.join(codexHome, 'hooks.json')}:pre_tool_use:0:0"]\ntrusted_hash = "${hash}"\n`,
  );
  writeFileSync(path.join(codexHome, 'rules', 'default.rules'), 'prefix_rule(pattern=["rm"], decision="forbidden")\n');
  writeFileSync(path.join(ws, 'victim.txt'), 'keep\n');
  writeFileSync(path.join(ws, 'notes.ts'), 'needle\nsecret\n');

  async function dispatcher() {
    const env = { ...process.env, CODEX_HOME: codexHome };
    const io = { ...nodeConfigIo(env), home: path.join(base, 'home'), systemDir: path.join(base, 'etc-codex'), parentArgv: () => ['codex'] };
    const c: SessionContext = { host: 'codex', cwd: ws, roots: [], permissionMode: 'default', sources: {}, sandboxMode: 'workspace-write' };
    // No temp dirs among the writable roots, so a write next to the workspace is outside them.
    const a = new CodexHostAdapter({ io: () => io, hookEnv: { ...process.env, SHELL: '/bin/sh' }, stateDir: path.join(base, 'state'), tmpDirs: { slashTmp: null, tmpdir: null } });
    const policy = await a.loadPolicy(c);
    if ('error' in policy) throw new Error(policy.error);
    expect(policy.payload).toMatchObject({ sandboxMode: 'workspace-write', approvalPolicy: 'never' });
    expect(policy.payload.hooks).toHaveLength(1);
    return new Dispatcher({ adapter: a, tools: new NodeToolRuntime({ stateDir: path.join(base, 'state') }), ctx: c, policy });
  }

  it('denies a disguised rm and leaves the file', async () => {
    const d = await dispatcher();
    for (const command of ["bash -O extglob -c 'rm -f victim.txt'", "$'\\x72m' -f victim.txt", 'function f { rm -f victim.txt; }; f', "watch 'rm -f victim.txt'"]) {
      expect(await d.dispatch('bash', { command }), command).toMatchObject({ ok: false, error: { code: 'denied', source: 'rule' } });
    }
    expect(readFileSync(path.join(ws, 'victim.txt'), 'utf8')).toBe('keep\n');
  });

  it('runs a search the hook allows and denies one the hook denies', async () => {
    const d = await dispatcher();
    expect(await d.dispatch('grep', { pattern: 'needle' })).toEqual({ ok: true, value: { matches: [{ file: path.join(ws, 'notes.ts'), line: 1, text: 'needle' }], truncated: false, filtered: 0 } });
    expect(await d.dispatch('grep', { pattern: 'secret' })).toMatchObject({ ok: false, error: { code: 'denied', source: 'hook', message: expect.stringContaining('blocked') } });
  });

  it('treats <root>/..name as inside the writable root', async () => {
    const d = await dispatcher();
    expect(await d.dispatch('write', { path: '..name/a.txt', content: 'inside\n' })).toMatchObject({ ok: true });
    expect(readFileSync(path.join(ws, '..name', 'a.txt'), 'utf8')).toBe('inside\n');
    const bash = await d.dispatch('bash', { command: 'echo also > ..name/b.txt' });
    expect(bash).toMatchObject({ ok: true, value: { exitCode: 0 } });
    expect(existsSync(path.join(ws, '..name', 'b.txt'))).toBe(true);
    // The sandbox still keeps writes outside the writable roots out.
    const outside = await d.dispatch('bash', { command: `echo x > ${path.join(base, 'outside.txt')}` });
    expect(outside.ok && 'exitCode' in outside.value ? outside.value.exitCode : 0).not.toBe(0);
    expect(existsSync(path.join(base, 'outside.txt'))).toBe(false);
  });
});
