import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Dispatcher } from '../../core/dispatcher.js';
import type { PolicySnapshot, PreparedCall, SessionContext } from '../../core/types.js';
import { MemoryToolRuntime } from '../../testing/memory-tool-runtime.js';
import { CodexHostAdapter, type CodexPolicy } from './adapter.js';
import { applyHunk, parsePatch } from './apply-patch.js';
import { CodexContextProvider } from './context.js';
import { commandHookHash } from './hooks.js';
import { patchPath, shellCommandFor } from './native.js';
import { memoryIo } from './test-io.js';

const posix = process.platform !== 'win32';
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

const tmp = mkdtempSync(path.join(os.tmpdir(), 'acm-codex-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function hook(name: string, body: string): string {
  const file = path.join(tmp, `${name}.mjs`);
  writeFileSync(
    file,
    `import { readFileSync, writeFileSync } from 'node:fs';\nconst input = JSON.parse(readFileSync(0, 'utf8'));\n${body}\n`,
  );
  return `"${process.execPath}" "${file}"`;
}

const hooks = {
  denyRm: hook('deny-rm', `if (String(input.tool_input.command).includes('rm ')) { process.stderr.write('rm is not allowed'); process.exit(2); }`),
  denyJson: hook('deny-json', `console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'blocked by policy' } }));`),
  rewrite: hook('rewrite-echo', `console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { command: 'echo rewritten' } } }));`),
  sleep: hook('sleep-forever', `writeFileSync(process.env.PID_FILE ?? '${path.join(tmp, 'pid').replace(/\\/g, '\\\\')}', String(process.pid)); setInterval(() => {}, 1000);`),
  crash: hook('crash', `throw new Error('boom');`),
  badJson: hook('bad-json', `process.stdout.write('{not json');`),
  silent2: hook('exit2-silent', `process.exit(2);`),
  ask: hook('ask', `console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'confirm' } }));`),
  allowOnly: hook('allow-only', `console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }));`),
  text: hook('plain-text', `console.log('looks fine to me');`),
  record: hook('record', `writeFileSync(${JSON.stringify(path.join(tmp, 'stdin.json'))}, JSON.stringify(input)); writeFileSync(${JSON.stringify(path.join(tmp, 'cwd.txt'))}, process.cwd());`),
  wrongEvent: hook('wrong-event', `console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', permissionDecision: 'allow', updatedInput: { command: 'echo x' } } }));`),
  extraField: hook('extra-field', `console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { command: 'echo x', extra: 1 } } }));`),
  patchRewrite: hook(
    'patch-rewrite',
    `console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { command: String(input.tool_input.command).replace('+world', '+WORLD') } } }));`,
  ),
};

interface Group {
  matcher?: string;
  hooks: { type: 'command'; command: string; timeout?: number }[];
}

function hooksJson(groups: Group[]): string {
  return JSON.stringify({ hooks: { PreToolUse: groups } });
}

const WS = path.join(tmp, 'ws');
mkdirSync(path.join(WS, 'sub'), { recursive: true });

function ctx(over: Partial<SessionContext> = {}): SessionContext {
  return { host: 'codex', cwd: WS, roots: [], permissionMode: 'default', sources: {}, sessionId: 's1', turnId: 't1', model: 'm1', toolUseId: 'call-9', ...over };
}

function adapter(files: Record<string, string>, extra: { argv?: string[]; current?: Record<string, string> } = {}): CodexHostAdapter {
  return new CodexHostAdapter({
    io: () => memoryIo({ files, argv: extra.argv ?? ['codex'] }),
    hookEnv: { ...process.env, SHELL: '/bin/sh' },
    stateDir: '/state',
    tmpDirs: { slashTmp: '/tmp', tmpdir: null },
    readCurrent: async (abs) => extra.current?.[abs] ?? null,
  });
}

async function policyOf(a: CodexHostAdapter, c = ctx()): Promise<PolicySnapshot<CodexPolicy>> {
  const p = await a.loadPolicy(c);
  if ('error' in p) throw new Error(p.error);
  return p;
}

const bash = (command: string, cwd = WS): PreparedCall => ({ id: 'c1', tool: 'bash', args: { command }, effect: { command, shell: { path: '/bin/bash', args: ['-c'] }, cwd, timeoutMs: 1000, containment: { mode: 'none' } } });
const write = (absPath: string, before: string | null, after: string): PreparedCall => ({
  id: 'c2',
  tool: 'write',
  args: { path: path.posix.relative(WS, absPath) || absPath, content: after },
  effect: { absPath, beforeHash: before === null ? null : sha(before), afterContent: after, diff: '' },
});
const edit = (absPath: string, before: string, after: string): PreparedCall => ({
  id: 'c3',
  tool: 'edit',
  args: { path: path.posix.relative(WS, absPath), oldString: 'x', newString: 'y' },
  effect: { absPath, beforeHash: sha(before), afterContent: after, diff: '', matchedOldString: 'x', matchStrategy: 'exact', replacements: 1 },
});
const read = (absPath: string): PreparedCall => ({ id: 'c4', tool: 'read', args: { path: absPath, offset: 3, limit: 10 }, effect: { absPath, offset: 3, limit: 10 } });

async function authorize(a: CodexHostAdapter, prepared: PreparedCall, c = ctx()) {
  const p = await policyOf(a, c);
  return a.authorize(prepared, c, p, new AbortController().signal);
}

const managed = (groups: Group[]): Record<string, string> => ({ '/etc/codex/hooks.json': hooksJson(groups) });

describe.runIf(posix)('Codex hooks', () => {
  it('denies on exit 2 with stderr', async () => {
    const a = adapter(managed([{ matcher: 'Bash', hooks: [{ type: 'command', command: hooks.denyRm }] }]));
    expect(await authorize(a, bash('rm -rf build'))).toEqual({ kind: 'deny', source: 'hook', reason: 'rm is not allowed' });
    expect(await authorize(a, bash('ls'))).toEqual({ kind: 'allow' });
  });

  it('denies on JSON permissionDecision deny', async () => {
    const a = adapter(managed([{ hooks: [{ type: 'command', command: hooks.denyJson }] }]));
    expect(await authorize(a, bash('ls'))).toEqual({ kind: 'deny', source: 'hook', reason: 'blocked by policy' });
  });

  it('maps updatedInput back to bash args', async () => {
    const a = adapter(managed([{ matcher: 'Bash', hooks: [{ type: 'command', command: hooks.rewrite }] }]));
    const decision = await authorize(a, bash('echo original'));
    expect(decision).toMatchObject({ kind: 'allow', updatedArgs: { command: 'echo rewritten' } });
    expect(decision).not.toHaveProperty('bindsPreparedFile');
  });

  it('times out, kills the hook and denies', async () => {
    const a = adapter(managed([{ hooks: [{ type: 'command', command: hooks.sleep, timeout: 1 }] }]));
    const d = await authorize(a, bash('ls'));
    expect(d).toMatchObject({ kind: 'deny', source: 'hook-timeout' });
    const pid = Number(readFileSync(path.join(tmp, 'pid'), 'utf8'));
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('fails closed where Codex is non-blocking: crash, invalid JSON, exit 2 without stderr, ask, allow alone', async () => {
    for (const cmd of [hooks.crash, hooks.badJson, hooks.silent2, hooks.ask, hooks.allowOnly, hooks.wrongEvent, hooks.extraField]) {
      const a = adapter(managed([{ hooks: [{ type: 'command', command: cmd }] }]));
      expect(await authorize(a, bash('ls')), cmd).toMatchObject({ kind: 'deny', source: 'hook-error' });
    }
  });

  it('denies when a hook prints output that is not JSON (Codex ignores it)', async () => {
    const a = adapter(managed([{ hooks: [{ type: 'command', command: hooks.text }] }]));
    expect(await authorize(a, bash('ls'))).toMatchObject({ kind: 'deny', source: 'hook-error', reason: expect.stringContaining('not JSON') });
  });

  it('matches hook matchers with Rust regex semantics', async () => {
    for (const matcher of ['\\ABash\\z', '(?i)^bash$', '^(?P<t>Ba)sh$', '[[:upper:]]ash', 'B\\x{61}sh']) {
      const a = adapter(managed([{ matcher, hooks: [{ type: 'command', command: hooks.denyJson }] }]));
      expect(await authorize(a, bash('ls')), matcher).toMatchObject({ kind: 'deny', source: 'hook' });
    }
    for (const matcher of ['(?x) ^ Write $', '(?i)\\P{Lu}ash']) {
      const odd = adapter(managed([{ matcher, hooks: [{ type: 'command', command: hooks.record }] }]));
      rmSync(path.join(tmp, 'stdin.json'), { force: true });
      expect(await authorize(odd, bash('ls')), matcher).toMatchObject({ kind: 'deny', source: 'unsupported-config' });
      expect(existsSync(path.join(tmp, 'stdin.json'))).toBe(false);
    }
    const other = adapter(managed([{ matcher: '\\Aapply_patch\\z', hooks: [{ type: 'command', command: hooks.denyJson }] }]));
    expect(await authorize(other, bash('ls'))).toEqual({ kind: 'allow' });
  });

  it('matches apply_patch with the Write|Edit alias, and Bash hooks do not', async () => {
    const file = `${WS}/a.txt`;
    const a = adapter(managed([{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: hooks.denyJson }] }]), { current: { [file]: 'hello\n' } });
    expect(await authorize(a, write(file, 'hello\n', 'hello\nworld\n'))).toMatchObject({ kind: 'deny', source: 'hook' });
    expect(await authorize(a, edit(file, 'hello\n', 'bye\n'))).toMatchObject({ kind: 'deny', source: 'hook' });
    expect(await authorize(a, bash('ls'))).toEqual({ kind: 'allow' });
    const regex = adapter(managed([{ matcher: '^apply_', hooks: [{ type: 'command', command: hooks.denyJson }] }]), { current: { [file]: 'hello\n' } });
    expect(await authorize(regex, write(file, 'hello\n', 'x\n'))).toMatchObject({ kind: 'deny' });
  });

  it('runs only user hooks whose trusted_hash matches', async () => {
    const group: Group = { matcher: 'Bash', hooks: [{ type: 'command', command: hooks.denyJson }] };
    const key = '/home/u/.codex/hooks.json:pre_tool_use:0:0';
    const hash = commandHookHash({ matcher: 'Bash', command: hooks.denyJson, timeoutSec: 600, async: false });
    const files = (state: string) => ({ '/home/u/.codex/hooks.json': hooksJson([group]), '/home/u/.codex/config.toml': state });
    expect(await authorize(adapter(files('')), bash('ls'))).toEqual({ kind: 'allow' });
    expect(await authorize(adapter(files(`[hooks.state."${key}"]\ntrusted_hash = "${hash}"\n`)), bash('ls'))).toMatchObject({ kind: 'deny', source: 'hook' });
    expect(await authorize(adapter(files(`[hooks.state."${key}"]\ntrusted_hash = "sha256:other"\n`)), bash('ls'))).toEqual({ kind: 'allow' });
    expect(await authorize(adapter(files(`[hooks.state."${key}"]\ntrusted_hash = "${hash}"\nenabled = false\n`)), bash('ls'))).toEqual({ kind: 'allow' });
    expect(await authorize(adapter(files(''), { argv: ['codex', '--dangerously-bypass-hook-trust'] }), bash('ls'))).toMatchObject({ kind: 'deny' });
  });

  it('denies calls matched by a hook whose trust cannot be verified, without running it', async () => {
    const files = (cmd: string) => ({
      '/home/u/.codex/hooks.json': hooksJson([{ hooks: [{ type: 'command', command: cmd }] }]),
      '/home/u/.codex/config.toml': '[hooks]\nstate = "corrupted"\n',
    });
    for (const cmd of [hooks.denyJson, hooks.crash, hooks.rewrite]) {
      expect(await authorize(adapter(files(cmd)), bash('ls'))).toMatchObject({ kind: 'deny', source: 'unsupported-config', reason: expect.stringContaining('trust') });
    }
  });

  it('reads hook trust from the --profile layer', async () => {
    const key = '/home/u/.codex/hooks.json:pre_tool_use:0:0';
    const hash = commandHookHash({ matcher: undefined, command: hooks.denyJson, timeoutSec: 600, async: false });
    const files = { '/home/u/.codex/hooks.json': hooksJson([{ hooks: [{ type: 'command', command: hooks.denyJson }] }]), '/home/u/.codex/work.config.toml': `[hooks.state."${key}"]\ntrusted_hash = "${hash}"\n` };
    expect(await authorize(adapter(files, { argv: ['codex', '-p', 'work'] }), bash('ls'))).toMatchObject({ kind: 'deny', source: 'hook' });
  });

  it('refuses required hooks it cannot load and plugin hooks of an unverifiable installation', async () => {
    const required = adapter({ '/etc/codex/requirements.toml': '[[hooks.PreToolUse]]\n[[hooks.PreToolUse.hooks]]\ntype = "prompt"\n' });
    expect(await required.loadPolicy(ctx())).toMatchObject({ error: expect.stringContaining('required hook') });
    const plugin = adapter({ '/home/u/.codex/config.toml': '[plugins."tool@market"]\nenabled = true\n' });
    expect(await plugin.loadPolicy(ctx())).toMatchObject({ error: expect.stringContaining('active installation') });
  });

  it('respects features.hooks and allow_managed_hooks_only', async () => {
    const userHooks = { '/home/u/.codex/hooks.json': hooksJson([{ hooks: [{ type: 'command', command: hooks.denyJson }] }]) };
    const off = adapter({ ...managed([{ hooks: [{ type: 'command', command: hooks.denyJson }] }]), '/home/u/.codex/config.toml': '[features]\nhooks = false\n' });
    expect(await authorize(off, bash('ls'))).toEqual({ kind: 'allow' });
    const managedOnly = adapter({ ...userHooks, '/home/u/.codex/config.toml': '[hooks]\nstate = 1\n', '/etc/codex/requirements.toml': 'allow_managed_hooks_only = true\n' });
    expect(await authorize(managedOnly, bash('ls'))).toEqual({ kind: 'allow' });
  });

  it('reads inline [hooks] tables from config.toml', async () => {
    const toml = `[[hooks.PreToolUse]]\nmatcher = "Bash"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(hooks.denyRm)}\n`;
    expect(await authorize(adapter({ '/etc/codex/config.toml': toml }), bash('rm x'))).toMatchObject({ kind: 'deny', source: 'hook' });
  });

  it('refuses a broken hooks.json instead of skipping it', async () => {
    expect(await adapter({ '/etc/codex/hooks.json': '{' }).loadPolicy(ctx())).toMatchObject({ error: expect.stringContaining('invalid JSON') });
    expect(await adapter({ '/etc/codex/hooks.json': '{"hooks":{},"extra":1}' }).loadPolicy(ctx())).toMatchObject({ error: expect.stringContaining('invalid hooks file') });
  });
});

describe.runIf(posix)('exactness: what the hook sees is what will be applied', () => {
  const recorded = (): Record<string, unknown> => JSON.parse(readFileSync(path.join(tmp, 'stdin.json'), 'utf8'));

  it('shows bash as Bash {command} with the Codex hook input fields', async () => {
    const a = adapter(managed([{ hooks: [{ type: 'command', command: hooks.record }] }]));
    const call = bash('git status && ls -la', `${WS}/sub`);
    await authorize(a, call);
    const input = recorded();
    expect(input).toEqual({
      session_id: 's1',
      turn_id: 't1',
      transcript_path: null,
      cwd: `${WS}/sub`,
      hook_event_name: 'PreToolUse',
      model: 'm1',
      permission_mode: 'default',
      tool_name: 'Bash',
      tool_input: { command: call.tool === 'bash' ? call.effect.command : '' },
      tool_use_id: 'call-9/c1',
    });
    expect(readFileSync(path.join(tmp, 'cwd.txt'), 'utf8')).toBe(realpathSync(WS));
  });

  it('builds no native input for a call no hook matches', async () => {
    const a = new CodexHostAdapter({
      io: () => memoryIo({ files: managed([{ matcher: 'Bash', hooks: [{ type: 'command', command: hooks.record }] }]), argv: ['codex'] }),
      readCurrent: () => Promise.reject(new Error('must not read')),
    });
    expect(await authorize(a, write(`${WS}/a.txt`, 'a\n', 'b\n'))).toEqual({ kind: 'allow' });
  });

  it('shows the effective read range, and no stand-in command for searches', async () => {
    expect(shellCommandFor({ id: 'r', tool: 'read', args: { path: 'a' }, effect: { absPath: '/w/a', offset: 1, limit: 2000 } })).toBe("sed -n '1,2000p' -- '/w/a'");
    const grep: PreparedCall = { id: 'g', tool: 'grep', args: { pattern: 'x' }, effect: { absRoot: '/w', pattern: 'x', glob: '*.ts', ignoreCase: false, maxResults: 5 } };
    expect(shellCommandFor(grep)).toBeUndefined();
    const a = adapter({});
    expect(a.checkStatic(grep, ctx(), await policyOf(a))).toMatchObject({ kind: 'deny' });
  });

  it('shows write and edit as an apply_patch that reproduces the after content', async () => {
    const file = `${WS}/src/app.ts`;
    const before = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';
    const after = 'const a = 1;\nconst b = 20;\nconst c = 3;\nexport { a };\n';
    const a = adapter(managed([{ hooks: [{ type: 'command', command: hooks.record }] }]), { current: { [file]: before } });
    for (const call of [write(file, before, after), edit(file, before, after), write(`${WS}/new.txt`, null, 'fresh\n')]) {
      expect(await authorize(a, call)).toEqual({ kind: 'allow' });
      const input = recorded();
      expect(input['tool_name']).toBe('apply_patch');
      const toolInput = input['tool_input'];
      if (typeof toolInput !== 'object' || toolInput === null || !('command' in toolInput) || typeof toolInput.command !== 'string') throw new Error('no command');
      const { hunks } = parsePatch(toolInput.command);
      const hunk = hunks[0];
      if (hunk === undefined || call.tool === 'bash' || call.tool === 'read' || call.tool === 'grep' || call.tool === 'glob') throw new Error('bad');
      expect(path.posix.resolve(WS, hunk.path)).toBe(call.effect.absPath);
      const current = call.effect.beforeHash === null ? null : before;
      expect(applyHunk(hunk.kind === 'add' ? null : current, hunk)).toBe(call.effect.afterContent);
    }
  });

  it('shows read as the sed command Codex would run', async () => {
    const a = adapter(managed([{ hooks: [{ type: 'command', command: hooks.record }] }]));
    await authorize(a, read(`${WS}/it's.txt`));
    expect(recorded()['tool_input']).toEqual({ command: `sed -n '3,12p' -- '${WS}/it'\\''s.txt'` });
  });

  it('denies a change the Codex patch format cannot show exactly when a hook would see it', async () => {
    const withHook = adapter(managed([{ matcher: 'Write', hooks: [{ type: 'command', command: hooks.record }] }]), { current: { [`${WS}/a.txt`]: 'a\n' } });
    for (const call of [write(`${WS}/crlf.txt`, null, 'hello\r\n'), write(`${WS}/nonl.txt`, null, 'hello'), write(`${WS}/a.txt`, 'a\n', 'a\nb')]) {
      expect(await authorize(withHook, call)).toMatchObject({ kind: 'deny', source: 'unsupported-config' });
    }
    expect(await authorize(withHook, write(`${WS}/ok.txt`, null, 'hello\n'))).toEqual({ kind: 'allow' });
    const bashOnly = adapter(managed([{ matcher: 'Bash', hooks: [{ type: 'command', command: hooks.record }] }]));
    expect(await authorize(bashOnly, write(`${WS}/crlf.txt`, null, 'hello\r\n'))).toEqual({ kind: 'allow' });
  });

  it('maps a rewritten apply_patch back to a write', async () => {
    const file = `${WS}/hello.txt`;
    const a = adapter(managed([{ hooks: [{ type: 'command', command: hooks.patchRewrite }] }]), { current: { [file]: 'hello\n' } });
    expect(await authorize(a, write(file, 'hello\n', 'hello\nworld\n'))).toMatchObject({
      kind: 'allow',
      updatedArgs: { path: 'hello.txt', content: 'hello\nWORLD\n' },
      bindsPreparedFile: true,
    });
    expect(await authorize(a, edit(file, 'hello\n', 'hello\nworld\n'))).toMatchObject({
      kind: 'allow',
      updatedArgs: { path: 'hello.txt', oldString: 'hello\n', newString: 'hello\nWORLD\n' },
      bindsPreparedFile: true,
    });
  });

  it('denies when the file changed after prepare', async () => {
    const file = `${WS}/a.txt`;
    const a = new CodexHostAdapter({ io: () => memoryIo({ files: managed([{ hooks: [{ type: 'command', command: hooks.record }] }]), argv: ['codex'] }), stateDir: '/state' });
    const real = path.join(tmp, 'changed.txt');
    writeFileSync(real, 'now\n');
    expect(await authorize(a, write(real, 'before\n', 'after\n'))).toMatchObject({ kind: 'deny', source: 'hook-error' });
    void file;
  });
});

describe.runIf(posix)('sandbox mode × tool', () => {
  const rules = { '/home/u/.codex/rules/default.rules': 'prefix_rule(pattern=["rm"], decision="forbidden")\nprefix_rule(pattern=["git", "push"], decision="prompt")\n' };

  async function decide(mode: string, prepared: PreparedCall, files: Record<string, string> = {}, argv: string[] = ['codex']) {
    const a = adapter(files, { argv: [...argv, '-s', mode] });
    const c = ctx({ sandboxMode: mode });
    const p = await policyOf(a, c);
    return { decision: a.checkStatic(prepared, c, p), containment: p.bashContainment };
  }

  it('returns the containment of each mode', async () => {
    expect((await decide('read-only', bash('ls'))).containment).toEqual({ mode: 'sandbox', readOnly: true, writableRoots: [], network: false });
    expect((await decide('workspace-write', bash('ls'), { '/home/u/.codex/config.toml': '[sandbox_workspace_write]\nwritable_roots = ["/data"]\nnetwork_access = true\n' })).containment).toEqual({
      mode: 'sandbox',
      readOnly: false,
      writableRoots: [WS, '/data', '/tmp'],
      network: true,
    });
    expect((await decide('danger-full-access', bash('ls'))).containment).toEqual({ mode: 'none' });
  });

  it('decides write/edit per mode', async () => {
    const inside = write(`${WS}/a.txt`, null, 'x');
    const outside = write('/etc/x.conf', null, 'x');
    const git = write(`${WS}/.git/config`, null, 'x');
    expect((await decide('read-only', inside)).decision.kind).toBe('ask');
    expect((await decide('workspace-write', inside)).decision.kind).toBe('allow');
    expect((await decide('workspace-write', write('/tmp/scratch', null, 'x'))).decision.kind).toBe('allow');
    expect((await decide('workspace-write', outside)).decision.kind).toBe('ask');
    expect((await decide('workspace-write', git)).decision.kind).toBe('ask');
    expect((await decide('danger-full-access', outside)).decision.kind).toBe('allow');
    expect((await decide('workspace-write', write(`${WS}/..name/a.txt`, null, 'x'))).decision.kind).toBe('allow');
    expect(patchPath(`${WS}/..name/a.txt`, WS)).toBe('..name/a.txt');
    expect(patchPath(path.dirname(WS), WS)).toBe(path.dirname(WS));
    expect((await decide('read-only', inside, {}, ['codex', 'exec'])).decision).toMatchObject({ kind: 'deny', source: 'rule' });
  });

  it('applies exec policy rules to bash and to shell-shaped reads in every mode', async () => {
    for (const mode of ['read-only', 'workspace-write', 'danger-full-access']) {
      expect((await decide(mode, bash('ls'), rules)).decision.kind).toBe('allow');
      expect((await decide(mode, bash('ls && rm -rf x'), rules)).decision).toMatchObject({ kind: 'deny', source: 'rule' });
      expect((await decide(mode, bash('git push origin'), rules)).decision.kind).toBe('ask');
      expect((await decide(mode, read(`${WS}/a.txt`), rules)).decision.kind).toBe('allow');
    }
    const sedRule = { '/home/u/.codex/rules/default.rules': 'prefix_rule(pattern=["sed"], decision="forbidden")\n' };
    expect((await decide('read-only', read(`${WS}/a.txt`), sedRule)).decision.kind).toBe('deny');
    expect((await decide('read-only', bash('rm -rf build'))).decision.kind).toBe('ask');
    expect((await decide('read-only', bash('ls'), {}, ['codex', '-a', 'untrusted'])).decision.kind).toBe('ask');
    expect((await decide('read-only', bash("echo 'x"))).decision).toMatchObject({ kind: 'deny', source: 'rule' });
  });

  it('falls back to bash -lc for scripts that are not plain, like Codex', async () => {
    const bashRule = { '/home/u/.codex/rules/default.rules': 'prefix_rule(pattern=["bash"], decision="forbidden")\n' };
    for (const cmd of ['echo ok # comment', 'echo {1..3}', 'echo a\\ b', 'echo ok &&', '"echo" ok', 'echo "$HOME"']) {
      expect((await decide('danger-full-access', bash(cmd), bashRule)).decision, cmd).toMatchObject({ kind: 'deny', source: 'rule' });
    }
    for (const cmd of ['echo ok', "echo 'a b' | wc -l", 'a && b\nc']) {
      expect((await decide('danger-full-access', bash(cmd), bashRule)).decision, cmd).toEqual({ kind: 'allow' });
    }
  });

  it('evaluates a script Codex would not split as the argv of the executor too', async () => {
    const rule = { '/home/u/.codex/rules/default.rules': 'prefix_rule(pattern=["bash", "-c"], decision="forbidden")\n' };
    expect((await decide('danger-full-access', bash('echo "$HOME"'), rule)).decision).toMatchObject({ kind: 'deny', source: 'rule' });
    expect((await decide('danger-full-access', bash('echo ok'), rule)).decision).toEqual({ kind: 'allow' });
  });

  it('evaluates commands behind wrappers and trap actions', async () => {
    const blocked = { '/home/u/.codex/rules/default.rules': 'prefix_rule(pattern=["blocked"], decision="forbidden")\n' };
    const wrapped = [
      'command blocked',
      "trap 'blocked' EXIT",
      'trap -- "blocked x" INT',
      'env X=1 blocked',
      'env -i -u HOME blocked',
      'env -S "blocked now"',
      'sudo -u root blocked',
      'exec blocked',
      'builtin blocked',
      'nohup blocked',
      'nice -n 5 blocked',
      'timeout -s KILL 5 blocked',
      'time -p blocked',
      'stdbuf -oL blocked',
      'xargs -n 1 blocked',
      'find . -name x -exec blocked {} ;',
      "eval 'blocked x'",
      'sudo env A=1 command blocked',
    ];
    for (const cmd of wrapped) expect((await decide('danger-full-access', bash(cmd), blocked)).decision, cmd).toMatchObject({ kind: 'deny', source: 'rule' });
    expect((await decide('danger-full-access', bash("trap 'rm -rf /tmp/example' EXIT"))).decision.kind).toBe('ask');
    expect((await decide('danger-full-access', bash('env --mystery blocked'), blocked)).decision.kind).toBe('ask');
    // A forbidden program named as an argument asks: it may run through a wrapper this check does not model.
    expect((await decide('danger-full-access', bash('timeout 5 echo blocked'), blocked)).decision.kind).toBe('ask');
    expect((await decide('danger-full-access', bash('command -v blocked'), blocked)).decision.kind).toBe('ask');
    expect((await decide('danger-full-access', bash("env -S rm '#' -rf x"))).decision.kind).toBe('ask');
    expect((await decide('danger-full-access', bash("env -S 'ls $X'"), blocked)).decision.kind).toBe('ask');
    expect((await decide('danger-full-access', bash("env -S 'blocked\vnow'"), blocked)).decision.kind).toBe('ask');
  });

  it('asks when run-time expansion could reach a rule or the forced-rm check', async () => {
    for (const cmd of ['rm $FLAGS x', 'rm -* x', '$CMD -rf x', 'git $SUB', 'git ~/x', '~/bin/git push']) {
      expect((await decide('danger-full-access', bash(cmd), { '/home/u/.codex/rules/default.rules': 'prefix_rule(pattern=["git", "push"], decision="prompt")\n' })).decision.kind, cmd).toBe('ask');
    }
    expect((await decide('danger-full-access', bash('echo $HOME'))).decision).toEqual({ kind: 'allow' });
    const printfRule = { '/home/u/.codex/rules/default.rules': 'prefix_rule(pattern=["printf", "%s", "A=a:/home/u/b"], decision="forbidden")\n' };
    for (const cmd of ['printf %s A="a":~/b', 'printf %s "A"=~/b']) {
      expect((await decide('danger-full-access', bash(cmd), printfRule)).decision.kind, cmd).toBe('ask');
    }
  });

  it('asks when a shell reads its script from standard input', async () => {
    for (const cmd of ['bash <<< "rm -rf /"', 'echo rm -rf x | sh', 'bash -s < script.sh', 'bash -e']) {
      expect((await decide('danger-full-access', bash(cmd))).decision.kind, cmd).toBe('ask');
    }
    expect((await decide('danger-full-access', bash('bash ./script.sh'))).decision).toEqual({ kind: 'allow' });
  });

  it('evaluates the applet behind busybox', async () => {
    const rmRule = { '/home/u/.codex/rules/default.rules': 'prefix_rule(pattern=["rm"], decision="forbidden")\n' };
    expect((await decide('danger-full-access', bash('busybox rm -rf x'), rmRule)).decision).toMatchObject({ kind: 'deny', source: 'rule' });
  });

  it('fails the load on bad rules and unknown sandbox modes', async () => {
    const bad = adapter({ '/home/u/.codex/rules/x.rules': 'network_rule(host="a", protocol="https", decision="allow")' });
    expect(await bad.loadPolicy(ctx())).toMatchObject({ error: expect.stringContaining('outside the supported rules subset') });
    expect(await adapter({}).loadPolicy(ctx({ sandboxMode: 'mystery' }))).toMatchObject({ error: expect.stringContaining('mystery') });
  });

  it('protects Codex policy files and the state dir', async () => {
    const p = await policyOf(adapter({}));
    expect(p.protectedPaths).toEqual(expect.arrayContaining([`${WS}/.codex/**`, '/tmp/.codex/**', '/home/u/.codex/**', '/etc/codex/**', '/state/**', `${WS}/.mcp.json`]));
    // An OS sandbox denies writing literal directories only: every pattern has an absolute prefix and no wildcard before its last segment.
    for (const pattern of p.protectedPaths) expect(pattern, pattern).toMatch(/^\/[^*?[]*(\/\*\*)?$/);
    // Every folder from the project root down to the cwd keeps its .codex protected.
    const nested = await policyOf(adapter({ [`${WS}/sub/.keep`]: '' }), ctx({ cwd: `${WS}/sub` }));
    expect(nested.protectedPaths).toEqual(expect.arrayContaining([`${WS}/sub/.codex/**`]));
    // In workspace-write, Codex's read-only folders of each writable root are protected too.
    const ww = await policyOf(adapter({}, { argv: ['codex', '-s', 'workspace-write'] }), ctx({ sandboxMode: 'workspace-write' }));
    expect(ww.protectedPaths).toEqual(expect.arrayContaining([`${WS}/.git/**`, `${WS}/.agents/**`, `${WS}/.aws/**`, '/tmp/.git/**']));
    const linked = new CodexHostAdapter({ io: () => ({ ...memoryIo({ dirs: ['/link'], argv: ['codex'] }), realpath: (x: string) => (x === '/link' ? '/real' : x) }), stateDir: '/link/state' });
    expect((await policyOf(linked)).protectedPaths).toEqual(expect.arrayContaining(['/link/state/**', '/real/state/**']));
  });

  it('watches the config, hooks and rules of every Codex config folder, not the state dir', async () => {
    const p = await policyOf(adapter({}), ctx({ cwd: `${WS}/sub` }));
    expect(p.watchedPaths).toEqual(
      expect.arrayContaining([
        `${WS}/sub/.codex/config.toml`,
        `${WS}/sub/.codex/hooks.json`,
        '/home/u/.codex/config.toml',
        '/home/u/.codex/rules/*.rules',
        '/etc/codex/requirements.toml',
        '/etc/codex/managed_config.toml',
        `${WS}/sub/.mcp.json`,
      ]),
    );
    expect((p.watchedPaths ?? []).some((w) => w.startsWith('/state'))).toBe(false);
    const profiled = await policyOf(adapter({ '/home/u/.codex/fast.config.toml': 'model = "m"\n' }, { argv: ['codex', '--profile', 'fast'] }));
    expect(profiled.watchedPaths).toContain('/home/u/.codex/fast.config.toml');
  });

  it('lets the turn metadata narrow the sandbox mode, never widen it', async () => {
    expect((await policyOf(adapter({}), ctx({ sandboxMode: 'danger-full-access' }))).bashContainment).toMatchObject({ mode: 'sandbox', readOnly: true });
    expect((await policyOf(adapter({}, { argv: ['codex', '-s', 'danger-full-access'] }), ctx({ sandboxMode: 'read-only' }))).bashContainment).toMatchObject({ readOnly: true });
    const req = adapter({ '/etc/codex/requirements.toml': 'allowed_sandbox_modes = ["read-only", "danger-full-access"]\n' }, { argv: ['codex', '-s', 'danger-full-access'] });
    expect((await policyOf(req, ctx({ sandboxMode: 'workspace-write' }))).bashContainment).toMatchObject({ mode: 'sandbox', readOnly: true });
  });

  it('fails the load when a listed rule file disappears', async () => {
    const a = new CodexHostAdapter({ io: () => ({ ...memoryIo({ argv: ['codex'] }), listFiles: (d: string) => (d === '/home/u/.codex/rules' ? ['gone.rules'] : []) }), stateDir: '/state' });
    expect(await a.loadPolicy(ctx())).toMatchObject({ error: expect.stringContaining('disappeared') });
  });
});

describe.runIf(posix)('dispatcher integration', () => {
  it('runs bash only through an executor whose dialect it evaluates', async () => {
    const c = ctx({ sandboxMode: 'danger-full-access' });
    const a = adapter({}, { argv: ['codex', '-s', 'danger-full-access'] });
    const policy = await a.loadPolicy(c);
    const known = new MemoryToolRuntime({ root: WS });
    expect((await new Dispatcher({ adapter: a, tools: known, ctx: c, policy }).dispatch('bash', { command: 'echo hi' })).ok).toBe(true);
    for (const shell of [{ path: '/usr/bin/fish', args: ['-c'] }, { path: '/bin/bash', args: ['-lc'] }, { path: 'bash', args: ['-c'] }]) {
      const unknown = new MemoryToolRuntime({ root: WS, shell });
      const reply = await new Dispatcher({ adapter: a, tools: unknown, ctx: c, policy }).dispatch('bash', { command: 'echo hi' });
      expect(reply, JSON.stringify(shell)).toMatchObject({ ok: false, error: { code: 'denied', source: 'unsupported-config' } });
      expect(unknown.commits).toEqual([]);
    }
  });

  it('runs grep and glob as the exact rg command the rules and hooks judged', async () => {
    const c = ctx({ sandboxMode: 'danger-full-access' });
    const tools = new MemoryToolRuntime({
      root: WS,
      files: { 'a.ts': 'x\n' },
      bashResult: (e) => ({
        exitCode: 0,
        signal: null,
        stdout: e.command.includes('--files') ? `${WS}/a.ts\0` : `${JSON.stringify({ type: 'match', data: { path: { text: `${WS}/a.ts` }, lines: { text: 'x\n' }, line_number: 1 } })}\n`,
        stderr: '',
        truncated: false,
        timedOut: false,
      }),
    });
    const a = adapter(managed([{ matcher: 'Bash', hooks: [{ type: 'command', command: hooks.record }] }]), { argv: ['codex', '-s', 'danger-full-access'] });
    const d = new Dispatcher({ adapter: a, tools, ctx: c, policy: await a.loadPolicy(c) });
    expect(await d.dispatch('grep', { pattern: 'x', maxResults: 7 })).toEqual({ ok: true, value: { columns: ['file', 'line', 'text'], rows: [['a.ts', 1, 'x']], count: 1, truncated: false, filtered: 0 } });
    const input: unknown = JSON.parse(readFileSync(path.join(tmp, 'stdin.json'), 'utf8'));
    expect(input).toMatchObject({ tool_name: 'Bash', tool_input: { command: tools.commits[0]?.target } });
    expect(tools.commits[0]?.target).toMatch(/^rg --json .* -e 'x' -- .* \| head -n 24$/);
    expect(await d.dispatch('glob', { pattern: '*.ts' })).toEqual({ ok: true, value: { files: ['a.ts'], truncated: false, filtered: 0 } });
    expect(d.bashCommits).toBe(0);
    expect(d.calls.map((x) => x.tool)).toEqual(['grep', 'glob']);
  });

  it('denies a search that a rule on rg or head forbids, or that a hook rewrites', async () => {
    const c = ctx({ sandboxMode: 'danger-full-access' });
    for (const program of ['rg', 'head']) {
      const tools = new MemoryToolRuntime({ root: WS });
      const a = adapter({ '/home/u/.codex/rules/default.rules': `prefix_rule(pattern=["${program}"], decision="forbidden")\n` }, { argv: ['codex', '-s', 'danger-full-access'] });
      const reply = await new Dispatcher({ adapter: a, tools, ctx: c, policy: await a.loadPolicy(c) }).dispatch('grep', { pattern: 'x' });
      expect(reply, program).toMatchObject({ ok: false, error: { code: 'denied', source: 'rule' } });
      expect(tools.commits).toEqual([]);
    }
    const tools = new MemoryToolRuntime({ root: WS });
    const a = adapter(managed([{ matcher: 'Bash', hooks: [{ type: 'command', command: hooks.rewrite }] }]), { argv: ['codex', '-s', 'danger-full-access'] });
    const reply = await new Dispatcher({ adapter: a, tools, ctx: c, policy: await a.loadPolicy(c) }).dispatch('glob', { pattern: '*.ts' });
    expect(reply).toMatchObject({ ok: false, error: { code: 'denied', source: 'hook' } });
    expect(tools.commits).toEqual([]);
  });

  it('re-prepares a hook rewrite and commits exactly the rewritten command', async () => {
    const tools = new MemoryToolRuntime({ root: WS });
    const a = adapter(managed([{ matcher: 'Bash', hooks: [{ type: 'command', command: hooks.rewrite }] }]), { argv: ['codex', '-s', 'danger-full-access'] });
    const c = ctx({ sandboxMode: 'danger-full-access' });
    const policy = await a.loadPolicy(c);
    const d = new Dispatcher({ adapter: a, tools, ctx: c, policy });
    const reply = await d.dispatch('bash', { command: 'echo original' });
    expect(reply.ok).toBe(true);
    expect(tools.commits.map((x) => x.target)).toEqual(['echo rewritten']);
  });

  function patchRewriteSetup(initial: string, afterHook: (tools: MemoryToolRuntime) => void = () => undefined) {
    const tools = new MemoryToolRuntime({ root: WS, files: { 'hello.txt': initial } });
    class Racing extends CodexHostAdapter {
      override async authorize(...args: Parameters<CodexHostAdapter['authorize']>) {
        const decision = await super.authorize(...args);
        afterHook(tools);
        return decision;
      }
    }
    const a = new Racing({
      io: () => memoryIo({ files: managed([{ hooks: [{ type: 'command', command: hooks.patchRewrite }] }]), argv: ['codex', '-s', 'danger-full-access'] }),
      hookEnv: { ...process.env, SHELL: '/bin/sh' },
      stateDir: '/state',
      tmpDirs: { slashTmp: '/tmp', tmpdir: null },
      readCurrent: async (abs) => tools.files.get(abs) ?? null,
    });
    return { tools, a };
  }

  it('commits a patch rewrite against the version the hook evaluated', async () => {
    const { tools, a } = patchRewriteSetup('hello\n');
    const c = ctx({ sandboxMode: 'danger-full-access' });
    const d = new Dispatcher({ adapter: a, tools, ctx: c, policy: await a.loadPolicy(c) });
    expect((await d.dispatch('write', { path: 'hello.txt', content: 'hello\nworld\n' })).ok).toBe(true);
    expect(tools.read('hello.txt')).toBe('hello\nWORLD\n');
  });

  it('denies a patch rewrite when the file changed after the hook evaluated it', async () => {
    const { tools, a } = patchRewriteSetup('hello\n', (t) => t.externalWrite('hello.txt', 'changed meanwhile\n'));
    const c = ctx({ sandboxMode: 'danger-full-access' });
    const d = new Dispatcher({ adapter: a, tools, ctx: c, policy: await a.loadPolicy(c) });
    const reply = await d.dispatch('write', { path: 'hello.txt', content: 'hello\nworld\n' });
    expect(reply).toMatchObject({ ok: false, error: { code: 'denied', source: 'hook' } });
    expect(tools.read('hello.txt')).toBe('changed meanwhile\n');
    expect(tools.commits).toHaveLength(0);
  });

  it('denies every call when the config cannot be loaded', async () => {
    const tools = new MemoryToolRuntime({ root: WS });
    const a = adapter({ '/home/u/.codex/config.toml': 'not = = toml' });
    const c = ctx();
    const d = new Dispatcher({ adapter: a, tools, ctx: c, policy: await a.loadPolicy(c) });
    const reply = await d.dispatch('bash', { command: 'ls' });
    expect(reply).toMatchObject({ ok: false, error: { code: 'denied', source: 'unsupported-config' } });
  });
});

describe('CodexContextProvider', () => {
  it('reads _meta and the server cwd, never tool args', async () => {
    const cwd = path.resolve(tmp);
    const c = await new CodexContextProvider().resolve({
      env: {},
      roots: [],
      serverCwd: cwd,
      meta: {
        callId: 'exec-1',
        sessionId: 'ses',
        threadId: 'thr',
        'x-codex-turn-metadata': { session_id: 'ses', turn_id: 'turn', model: 'gpt', sandbox: 'seccomp', sandbox_mode: 'workspace-write', extra: 1 },
        _ctx: { cwd: '/evil' },
      },
    });
    expect(c).toMatchObject({ host: 'codex', cwd, sessionId: 'ses', turnId: 'turn', model: 'gpt', sandboxMode: 'workspace-write', toolUseId: 'exec-1' });
    const junk = await new CodexContextProvider().resolve({ env: {}, roots: [], serverCwd: cwd, meta: { callId: 5 } });
    expect(junk.toolUseId).toBeUndefined();
    for (const turn of ['nope', { sandbox_mode: 'mystery' }]) {
      await expect(new CodexContextProvider().resolve({ env: {}, roots: [], serverCwd: cwd, meta: { 'x-codex-turn-metadata': turn } })).rejects.toThrow(/turn metadata/);
    }
  });
});

describe.runIf(posix)('Codex requirements.toml mcp_servers allowlist, through the adapter', () => {
  const tools = ['[mcp_servers.ok.tools.t]', 'approval_mode = "approve"', '[mcp_servers.blocked.tools.t]', 'approval_mode = "approve"'].join('\n');
  const files = {
    '/home/u/.codex/config.toml': `[mcp_servers.ok]\ncommand = "node"\n[mcp_servers.blocked]\ncommand = "other-server"\n${tools}\n`,
    '/etc/codex/requirements.toml': '[mcp_servers.ok.identity]\ncommand = "node"\n[mcp_servers.blocked.identity]\ncommand = "node"\n',
  };

  it('leaves a server the allowlist does not admit out of the startable servers, and refuses calls to it unsent', async () => {
    const a = adapter(files);
    const policy = await policyOf(a);
    expect(policy.mcp?.servers.map((s) => [s.name, s.autostart])).toEqual([['ok', true]]);
    expect(policy.mcp?.notes.join(' ')).toContain('"blocked" (Codex config.toml): not allowed by mcp_servers of /etc/codex/requirements.toml');
    const sent: string[] = [];
    const mcp = { call: async (_s: unknown, e: { qualifiedName: string }) => (sent.push(e.qualifiedName), { isError: false }), close: async () => undefined };
    const d = new Dispatcher({ adapter: a, tools: new MemoryToolRuntime({ root: ctx().cwd }), ctx: ctx(), policy, mcp });
    const blocked = await d.dispatch('mcp', { server: 'blocked', tool: 't' });
    expect(blocked.ok).toBe(false);
    expect(await d.dispatch('mcp', { server: 'ok', tool: 't' })).toMatchObject({ ok: true });
    expect(sent).toEqual(['mcp__ok__t']);
  });

  it('starts every approved server when requirements.toml has no mcp_servers', async () => {
    const policy = await policyOf(adapter({ '/home/u/.codex/config.toml': files['/home/u/.codex/config.toml'] }));
    expect(policy.mcp?.servers.map((s) => s.name)).toEqual(['ok', 'blocked']);
  });
});
