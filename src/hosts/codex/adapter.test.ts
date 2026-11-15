import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { memoryIo } from './test-io.js';

const posix = process.platform !== 'win32';
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

const tmp = mkdtempSync(path.join(os.tmpdir(), 'acm-codex-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Writes an example hook script and returns the command that runs it. */
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
  record: hook('record', `writeFileSync(${JSON.stringify(path.join(tmp, 'stdin.json'))}, JSON.stringify(input));`),
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

const bash = (command: string, cwd = WS): PreparedCall => ({ id: 'c1', tool: 'bash', args: { command }, effect: { command, cwd, timeoutMs: 1000, containment: { mode: 'none' } } });
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
    expect(await authorize(a, bash('echo original'))).toMatchObject({ kind: 'allow', updatedArgs: { command: 'echo rewritten' } });
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
    for (const cmd of [hooks.crash, hooks.badJson, hooks.silent2, hooks.ask, hooks.allowOnly]) {
      const a = adapter(managed([{ hooks: [{ type: 'command', command: cmd }] }]));
      expect(await authorize(a, bash('ls')), cmd).toMatchObject({ kind: 'deny', source: 'hook-error' });
    }
    // Plain text output is ignored by Codex, and here too.
    const a = adapter(managed([{ hooks: [{ type: 'command', command: hooks.text }] }]));
    expect(await authorize(a, bash('ls'))).toEqual({ kind: 'allow' });
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
    // --dangerously-bypass-hook-trust runs it without state.
    expect(await authorize(adapter(files(''), { argv: ['codex', '--dangerously-bypass-hook-trust'] }), bash('ls'))).toMatchObject({ kind: 'deny' });
  });

  it('falls back to deny-only when the trust store cannot be parsed', async () => {
    const files = (cmd: string) => ({
      '/home/u/.codex/hooks.json': hooksJson([{ hooks: [{ type: 'command', command: cmd }] }]),
      '/home/u/.codex/config.toml': '[hooks]\nstate = "corrupted"\n',
    });
    expect(await authorize(adapter(files(hooks.denyJson)), bash('ls'))).toMatchObject({ kind: 'deny', source: 'hook' });
    expect(await authorize(adapter(files(hooks.crash)), bash('ls'))).toEqual({ kind: 'allow' });
    expect(await authorize(adapter(files(hooks.rewrite)), bash('ls'))).toMatchObject({ kind: 'deny', source: 'unsupported-config' });
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

  it('maps a rewritten apply_patch back to a write', async () => {
    const file = `${WS}/hello.txt`;
    const a = adapter(managed([{ hooks: [{ type: 'command', command: hooks.patchRewrite }] }]), { current: { [file]: 'hello\n' } });
    expect(await authorize(a, write(file, 'hello\n', 'hello\nworld\n'))).toMatchObject({ kind: 'allow', updatedArgs: { path: 'hello.txt', content: 'hello\nWORLD\n' } });
    expect(await authorize(a, edit(file, 'hello\n', 'hello\nworld\n'))).toMatchObject({ kind: 'allow', updatedArgs: { path: 'hello.txt', oldString: 'hello\n', newString: 'hello\nWORLD\n' } });
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
    const a = adapter(files, { argv });
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
    // With approval never, what Codex would ask is rejected.
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

  it('fails the load on bad rules and unknown sandbox modes', async () => {
    const bad = adapter({ '/home/u/.codex/rules/x.rules': 'network_rule(host="a", protocol="https", decision="allow")' });
    expect(await bad.loadPolicy(ctx())).toMatchObject({ error: expect.stringContaining('outside the supported rules subset') });
    expect(await adapter({}).loadPolicy(ctx({ sandboxMode: 'mystery' }))).toMatchObject({ error: expect.stringContaining('mystery') });
  });

  it('protects Codex policy files and the state dir', async () => {
    const p = await policyOf(adapter({}));
    expect(p.protectedPaths).toEqual(expect.arrayContaining(['**/.codex/**', '/home/u/.codex/**', '/etc/codex/**', '/state/**', `${WS}/.mcp.json`]));
  });
});

describe.runIf(posix)('dispatcher integration', () => {
  it('re-prepares a hook rewrite and commits exactly the rewritten command', async () => {
    const tools = new MemoryToolRuntime({ root: WS });
    const a = adapter(managed([{ matcher: 'Bash', hooks: [{ type: 'command', command: hooks.rewrite }] }]));
    const c = ctx({ sandboxMode: 'danger-full-access' });
    const policy = await a.loadPolicy(c);
    const d = new Dispatcher({ adapter: a, tools, ctx: c, policy });
    const reply = await d.dispatch('bash', { command: 'echo original' });
    expect(reply.ok).toBe(true);
    expect(tools.commits.map((x) => x.target)).toEqual(['echo rewritten']);
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
    const junk = await new CodexContextProvider().resolve({ env: {}, roots: [], serverCwd: cwd, meta: { 'x-codex-turn-metadata': 'nope', callId: 5 } });
    expect(junk.sandboxMode).toBeUndefined();
    expect(junk.toolUseId).toBeUndefined();
  });
});
