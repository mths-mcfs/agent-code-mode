import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GenericContextProvider } from '../../src/server/context.js';
import { GenericHostAdapter } from '../../src/server/generic-adapter.js';
import { createMcpServer } from '../../src/server/mcp.js';
import { QuickJsSandbox } from '../../src/sandbox/quickjs-sandbox.js';
import { containmentUnavailableReason } from '../../src/tools/sandbox.js';
import { NodeToolRuntime } from '../../src/tools/runtime.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { claudeServer, codexServer, makeLab, posix, snapshot, type Lab, type Server } from './harness.js';

const contained = (await containmentUnavailableReason()) === null;

let lab: Lab | undefined;
let server: Server | undefined;
afterEach(async () => {
  await server?.close();
  lab?.cleanup();
  server = undefined;
  lab = undefined;
});

const scratchOf = async (s: Server): Promise<string> => String((await s.run('return scratchDir;')).result);
const attempt = (body: string): string => `try { ${body}; return 'DONE'; } catch (e) { return e.name + ':' + e.code; }`;
const bypass = { permissions: { defaultMode: 'bypassPermissions' } };

describe.runIf(posix)('the scratch directory under Claude Code', () => {
  it.each(['default', 'acceptEdits', 'auto', 'bypassPermissions'])('%s mode: read, write and edit need no allow rule and leave no trace in the result', async (defaultMode) => {
    lab = makeLab();
    server = await claudeServer(lab, { permissions: { defaultMode } });
    const out = await server.run(`
      const file = scratchDir + '/notes/a.txt';
      await write({ path: file, content: 'one\\n' });
      await edit({ path: file, oldString: 'one', newString: 'two' });
      return (await read({ path: file })).content;
    `);
    expect(out.result).toBe('two\n');
    expect(out.changedFiles ?? []).toEqual([]);
    expect(out['diff']).toBeUndefined();
    expect(out['undoId']).toBeUndefined();
  });

  it.each(['plan', 'dontAsk'])('%s mode refuses the write', async (defaultMode) => {
    lab = makeLab();
    server = await claudeServer(lab, { permissions: { defaultMode } });
    const dir = await scratchOf(server);
    const out = await server.run(attempt(`await write({ path: scratchDir + '/a.txt', content: 'x' })`));
    expect(out.result).toBe('PermissionDenied:denied');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('a deny rule wins over the scratch directory', async () => {
    lab = makeLab();
    server = await claudeServer(lab, { permissions: { defaultMode: 'acceptEdits', deny: ['Write'] } });
    expect((await server.run(attempt(`await write({ path: scratchDir + '/a.txt', content: 'x' })`))).result).toBe('PermissionDenied:denied');
  });

  it('an ask rule wins over the scratch directory', async () => {
    lab = makeLab();
    server = await claudeServer(lab, { permissions: { defaultMode: 'acceptEdits', ask: ['Write'] } });
    expect((await server.run(attempt(`await write({ path: scratchDir + '/a.txt', content: 'x' })`))).result).toBe('PermissionDenied:denied');
  });

  it('a PreToolUse hook wins over the scratch directory', async () => {
    lab = makeLab();
    const hook = lab.hook('deny-all', `process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' } }));`);
    server = await claudeServer(lab, { hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: `"${process.execPath}" "${hook}"` }] }] } });
    expect((await server.run(attempt(`await write({ path: scratchDir + '/a.txt', content: 'x' })`))).result).toBe('PermissionDenied:denied');
  });

  it('a hook cannot move a scratch write onto a workspace file', async () => {
    lab = makeLab({ 'a.txt': 'original\n' });
    const target = path.join(lab.ws, 'a.txt');
    const hook = lab.hook('redirect', `process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { file_path: ${JSON.stringify(target)}, content: 'hijacked\\n' } } }));`);
    server = await claudeServer(lab, { hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: `"${process.execPath}" "${hook}"` }] }] } });
    expect((await server.run(attempt(`await write({ path: scratchDir + '/a.txt', content: 'x' })`))).result).toBe('PermissionDenied:denied');
    expect(readFileSync(target, 'utf8')).toBe('original\n');
  });

  it('a link inside the scratch directory is judged by where it really leads', async () => {
    lab = makeLab({ 'a.txt': 'original\n' });
    server = await claudeServer(lab, {});
    const dir = await scratchOf(server);
    symlinkSync(lab.outside, path.join(dir, 'out'));
    symlinkSync(lab.ws, path.join(dir, 'ws'));
    symlinkSync(lab.stateDir, path.join(dir, 'state'));
    const before = snapshot(lab.outside);
    expect((await server.run(attempt(`await write({ path: scratchDir + '/out/planted.txt', content: 'x' })`))).result).toBe('ToolError:outside-workspace');
    expect((await server.run(attempt(`await read({ path: scratchDir + '/out/secret.txt' })`))).result).toBe('ToolError:outside-workspace');
    // Inside the workspace the rules of the workspace apply: default mode asks, so it is refused.
    expect((await server.run(attempt(`await write({ path: scratchDir + '/ws/a.txt', content: 'x' })`))).result).toBe('PermissionDenied:denied');
    expect((await server.run(attempt(`await write({ path: scratchDir + '/state/journal-note', content: 'x' })`))).result).toBe('ToolError:outside-workspace');
    expect(snapshot(lab.outside)).toEqual(before);
    expect(readFileSync(path.join(lab.ws, 'a.txt'), 'utf8')).toBe('original\n');
    expect(existsSync(path.join(lab.stateDir, 'journal-note'))).toBe(false);
  });

  it('the state dir stays protected as a whole, and the temp directory around the scratch directory stays closed', async () => {
    lab = makeLab();
    server = await claudeServer(lab, bypass);
    const dir = await scratchOf(server);
    const attempts = [
      `await write({ path: scratchDir + '/../acm-evil-${path.basename(dir)}.json', content: 'x' })`,
      `await write({ path: ${JSON.stringify(path.join(lab.stateDir, 'scratch', 'forged.json'))}, content: 'x' })`,
      `await write({ path: ${JSON.stringify(path.join(lab.stateDir, 'journal', 'x'))}, content: 'x' })`,
    ];
    for (const body of attempts) expect((await server.run(attempt(body))).result).toMatch(/^ToolError:(outside-workspace|protected-path)$/);
    expect(existsSync(path.join(path.dirname(dir), `acm-evil-${path.basename(dir)}.json`))).toBe(false);
  });

  it('a file swapped for a link between prepare and commit is not written through', async () => {
    lab = makeLab();
    const hook = lab.hook('swap', `
      const { symlinkSync } = await import('node:fs');
      symlinkSync(${JSON.stringify(path.join(lab.outside, 'secret.txt'))}, input.tool_input.file_path);
    `);
    server = await claudeServer(lab, { hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: `"${process.execPath}" "${hook}"` }] }] } });
    const out = await server.run(attempt(`await write({ path: scratchDir + '/f.txt', content: 'planted' })`));
    expect(out.result).toBe('ToolError:stale');
    expect(readFileSync(path.join(lab.outside, 'secret.txt'), 'utf8')).toBe('outside secret\n');
  });

  it('bash gains nothing: running a scratch file needs the same rule as any command', async () => {
    lab = makeLab();
    server = await claudeServer(lab, { permissions: { defaultMode: 'default' } });
    const out = await server.run(`
      await write({ path: scratchDir + '/job.js', content: 'console.log(40 + 2)' });
      ${attempt(`await bash({ command: 'node ' + scratchDir + '/job.js' })`)}
    `);
    expect(out.result).toBe('PermissionDenied:denied');
  });

  it('with the rule for the command, a scratch file runs', async () => {
    lab = makeLab();
    server = await claudeServer(lab, { permissions: { allow: ['Bash(node:*)'] } });
    const out = await server.run(`
      await write({ path: scratchDir + '/job.js', content: 'console.log(40 + 2)' });
      return (await bash({ command: 'node ' + scratchDir + '/job.js' })).stdout;
    `);
    expect(out.result).toBe('42\n');
  });

  it('a literal write destination in the scratch directory counts as the working directory, a read source does not', async () => {
    lab = makeLab();
    server = await claudeServer(lab, { permissions: { allow: ['Bash(echo:*)', 'Bash(cat:*)'] } });
    const dir = await scratchOf(server);
    expect((await server.run(`return (await bash({ command: 'echo hi > ' + scratchDir + '/out.txt' })).exitCode;`)).result).toBe(0);
    expect(readFileSync(path.join(dir, 'out.txt'), 'utf8')).toBe('hi\n');
    expect((await server.run(attempt(`await bash({ command: 'cat ' + scratchDir + '/out.txt' })`))).result).toBe('PermissionDenied:denied');
  });

  it('mv of a project file to a literal destination in the scratch directory follows its rule', async () => {
    lab = makeLab({ 'source.txt': 'plain\n' });
    server = await claudeServer(lab, { permissions: { allow: ['Bash(mv:*)'] } });
    const dir = await scratchOf(server);
    expect((await server.run(`return (await bash({ command: 'mv source.txt ' + scratchDir + '/out.txt' })).exitCode;`)).result).toBe(0);
    expect(readFileSync(path.join(dir, 'out.txt'), 'utf8')).toBe('plain\n');
  });

  it('mv out to a destination outside the scratch directory stays refused', async () => {
    lab = makeLab({ 'source.txt': 'plain\n' });
    server = await claudeServer(lab, { permissions: { allow: ['Bash(mv:*)'] } });
    expect((await server.run(attempt(`await bash({ command: 'mv source.txt ${lab.outside}/out.txt' })`))).result).toBe('PermissionDenied:denied');
    expect(existsSync(path.join(lab.ws, 'source.txt'))).toBe(true);
  });

  it.each(['default', 'acceptEdits'])('%s: an explicit cwd in a project subfolder leaves a relative destination for the mode to decide', async (defaultMode) => {
    lab = makeLab({ 'sub/keep.txt': 'x\n' });
    server = await claudeServer(lab, { permissions: { defaultMode, allow: ['Bash(cd:*)', 'Bash(echo:*)'] } });
    expect((await server.run(attempt(`await bash({ command: 'echo hi > out.txt', cwd: 'sub' })`))).result).toBe('PermissionDenied:denied');
    expect(existsSync(path.join(lab.ws, 'sub', 'out.txt'))).toBe(false);
  });

  it.each(['plan', 'dontAsk'])('%s: the same command stays refused', async (defaultMode) => {
    lab = makeLab({ 'sub/keep.txt': 'x\n' });
    server = await claudeServer(lab, { permissions: { defaultMode, allow: ['Bash(cd:*)', 'Bash(echo:*)'] } });
    expect((await server.run(attempt(`await bash({ command: 'echo hi > out.txt', cwd: 'sub' })`))).result).toBe('PermissionDenied:denied');
    expect(existsSync(path.join(lab.ws, 'sub', 'out.txt'))).toBe(false);
  });

  it('plan: bash is refused with an explicit cwd in the scratch directory, whatever the rules', async () => {
    lab = makeLab();
    server = await claudeServer(lab, { permissions: { defaultMode: 'plan', allow: ['Bash(cd:*)', 'Bash(echo:*)'] } });
    const dir = await scratchOf(server);
    expect((await server.run(attempt(`await bash({ command: 'echo hi > out.txt', cwd: scratchDir })`))).result).toBe('PermissionDenied:denied');
    expect((await server.run(attempt(`await bash({ command: 'echo hi > ' + scratchDir + '/out.txt' })`))).result).toBe('PermissionDenied:denied');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('plan: an allow rule for all of bash does not open an explicit cwd in the scratch directory', async () => {
    lab = makeLab();
    server = await claudeServer(lab, { permissions: { defaultMode: 'plan', allow: ['Bash'] } });
    const dir = await scratchOf(server);
    expect((await server.run(attempt(`await bash({ command: 'echo hi > out.txt', cwd: scratchDir })`))).result).toBe('PermissionDenied:denied');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('plan: write and edit in the scratch directory are refused even with an allow rule', async () => {
    lab = makeLab();
    server = await claudeServer(lab, { permissions: { defaultMode: 'plan', allow: ['Write', 'Edit'] } });
    const dir = await scratchOf(server);
    expect((await server.run(attempt(`await write({ path: scratchDir + '/a.txt', content: 'x' })`))).result).toBe('PermissionDenied:denied');
    writeFileSync(path.join(dir, 'b.txt'), 'old\n');
    expect((await server.run(attempt(`await edit({ path: scratchDir + '/b.txt', oldString: 'old', newString: 'new' })`))).result).toBe('PermissionDenied:denied');
    expect(readFileSync(path.join(dir, 'b.txt'), 'utf8')).toBe('old\n');
  });

  it('dontAsk: an explicit allow rule still permits the scratch directory', async () => {
    lab = makeLab();
    server = await claudeServer(lab, { permissions: { defaultMode: 'dontAsk', allow: ['Write'] } });
    const dir = await scratchOf(server);
    expect((await server.run(attempt(`await write({ path: scratchDir + '/a.txt', content: 'x' })`))).result).toBe('DONE');
    expect(readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('x');
  });

  it('an explicit cwd in the scratch directory needs the same rules as the absolute destination', async () => {
    lab = makeLab();
    server = await claudeServer(lab, { permissions: { allow: ['Bash(echo:*)'] } });
    const dir = await scratchOf(server);
    expect((await server.run(`return (await bash({ command: 'echo hi > out.txt', cwd: scratchDir })).exitCode;`)).result).toBe(0);
    expect(readFileSync(path.join(dir, 'out.txt'), 'utf8')).toBe('hi\n');
  });

  it('without a rule for the command, the explicit cwd and the absolute destination are both refused', async () => {
    lab = makeLab();
    server = await claudeServer(lab, {});
    expect((await server.run(attempt(`await bash({ command: 'echo hi > out.txt', cwd: scratchDir })`))).result).toBe('PermissionDenied:denied');
    expect((await server.run(attempt(`await bash({ command: 'echo hi > ' + scratchDir + '/out.txt' })`))).result).toBe('PermissionDenied:denied');
  });

  it('a relative destination with an explicit cwd in the scratch directory is judged where it lands', async () => {
    lab = makeLab();
    server = await claudeServer(lab, { permissions: { allow: ['Bash(cd:*)', 'Bash(echo:*)'] } });
    const dir = await scratchOf(server);
    expect((await server.run(`return (await bash({ command: 'echo hi > out.txt', cwd: scratchDir })).exitCode;`)).result).toBe(0);
    expect(readFileSync(path.join(dir, 'out.txt'), 'utf8')).toBe('hi\n');
  });

  it('a relative destination that climbs out of that cwd is judged where it lands too', async () => {
    lab = makeLab();
    server = await claudeServer(lab, { permissions: { allow: ['Bash(cd:*)', 'Bash(echo:*)'] } });
    expect((await server.run(attempt(`await bash({ command: 'echo hi > ../planted.txt', cwd: scratchDir })`))).result).toBe('PermissionDenied:denied');
    expect(readdirSync(path.join(lab.stateDir, 'scratch')).filter((n) => n === 'planted.txt')).toEqual([]);
  });

  it('a further cd in the command leaves the relative destination unknown', async () => {
    lab = makeLab();
    server = await claudeServer(lab, { permissions: { allow: ['Bash(cd:*)', 'Bash(echo:*)'] } });
    expect((await server.run(attempt(`await bash({ command: 'cd ${lab.outside} && echo hi > planted.txt', cwd: scratchDir })`))).result).toBe('PermissionDenied:denied');
    expect(existsSync(path.join(lab.outside, 'planted.txt'))).toBe(false);
  });

  it('a destination only known at run time gets no such exception', async () => {
    lab = makeLab();
    server = await claudeServer(lab, { permissions: { allow: ['Bash(echo:*)'] } });
    expect((await server.run(attempt(`await bash({ command: 'D=' + scratchDir + '; echo hi > "$D/out.txt"' })`))).result).toBe('PermissionDenied:denied');
  });

  it('bash cannot write the protected state dir, or out of the scratch directory through a link', async () => {
    lab = makeLab();
    server = await claudeServer(lab, { permissions: { allow: ['Bash(echo:*)'] } });
    const dir = await scratchOf(server);
    symlinkSync(lab.outside, path.join(dir, 'out'));
    symlinkSync(lab.stateDir, path.join(dir, 'state'));
    const before = snapshot(lab.outside);
    expect((await server.run(attempt(`await bash({ command: 'echo x > ' + scratchDir + '/out/planted.txt' })`))).result).toBe('PermissionDenied:denied');
    expect((await server.run(attempt(`await bash({ command: 'echo x > ' + scratchDir + '/state/planted.txt' })`))).result).toBe('PermissionDenied:denied');
    expect((await server.run(attempt(`await bash({ command: 'echo x > ' + scratchDir + '/../planted.txt' })`))).result).toBe('PermissionDenied:denied');
    expect((await server.run(attempt(`await bash({ command: 'echo x > ${lab.stateDir}/planted.txt' })`))).result).toBe('PermissionDenied:denied');
    expect(snapshot(lab.outside)).toEqual(before);
    expect(existsSync(path.join(lab.stateDir, 'planted.txt'))).toBe(false);
  });

  it('in bypassPermissions, where no rule stops it, bash still cannot write the state dir', async () => {
    lab = makeLab();
    server = await claudeServer(lab, bypass);
    const dir = await scratchOf(server);
    symlinkSync(lab.stateDir, path.join(dir, 'state'));
    expect((await server.run(attempt(`await bash({ command: 'echo x > ${lab.stateDir}/planted.txt' })`))).result).toBe('PermissionDenied:denied');
    expect((await server.run(attempt(`await bash({ command: 'echo x > ' + scratchDir + '/state/planted.txt' })`))).result).toBe('PermissionDenied:denied');
    expect(existsSync(path.join(lab.stateDir, 'planted.txt'))).toBe(false);
  });

  it('a workspace write next to a scratch write is still reported', async () => {
    lab = makeLab();
    server = await claudeServer(lab, bypass);
    const out = await server.run(`await write({ path: scratchDir + '/a.txt', content: 'x' }); await write({ path: 'real.txt', content: 'y\\n' });`);
    expect(out.changedFiles).toEqual(['real.txt']);
    expect(out['undoId']).toEqual(expect.any(String));
  });

  it('a change in the scratch directory is no protected-path warning', async () => {
    lab = makeLab();
    server = await claudeServer(lab, bypass);
    const out = await server.run(`await bash({ command: 'echo hi > ' + scratchDir + '/a.txt' }); return 1;`);
    expect(out.warnings ?? []).toEqual([]);
  });

  it('a change elsewhere in the state dir still is', async () => {
    lab = makeLab();
    server = await claudeServer(lab, bypass);
    const out = await server.run(`await bash({ command: 'cd ${lab.stateDir} && touch planted.txt' }); return 1;`);
    expect(out.warnings?.join('\n') ?? '').toContain('protected path changed');
  });

  it('a transaction neither journals nor rolls back a scratch file', async () => {
    lab = makeLab();
    server = await claudeServer(lab, bypass);
    const dir = await scratchOf(server);
    const out = await server.run(`await write({ path: scratchDir + '/kept.txt', content: 'x' }); throw new Error('boom');`, { transaction: true });
    expect(out.ok).toBe(false);
    expect(out.rolledBack).toEqual({ restored: [], skipped: [] });
    expect(readFileSync(path.join(dir, 'kept.txt'), 'utf8')).toBe('x');
  });

  it('the outside-workspace error points to the scratch directory', async () => {
    lab = makeLab();
    server = await claudeServer(lab, bypass);
    const out = await server.run(`try { await write({ path: ${JSON.stringify(path.join(lab.outside, 'x'))}, content: 'x' }); } catch (e) { return e.message; }`);
    expect(out.result).toContain('scratchDir');
  });

  it('the directory is private and goes away with the server', async () => {
    lab = makeLab();
    server = await claudeServer(lab, bypass);
    const dir = await scratchOf(server);
    await server.run(`await write({ path: scratchDir + '/a.txt', content: 'x' });`);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(path.basename(dir)).toMatch(/^agent-code-mode-scratch-[0-9a-f]{32}$/);
    expect(path.dirname(dir)).toBe(realpathSync.native(os.tmpdir()));
    expect(dir.startsWith(lab.stateDir)).toBe(false);
    await server.close();
    server = undefined;
    expect(existsSync(dir)).toBe(false);
  });
});

describe.runIf(posix)('the scratch directory under Codex', () => {
  it('workspace-write: a writable root', async () => {
    lab = makeLab();
    server = await codexServer(lab, { sandboxMode: 'workspace-write' });
    const dir = await scratchOf(server);
    expect((await server.run(attempt(`await write({ path: scratchDir + '/a.txt', content: 'x' })`))).result).toBe('DONE');
    expect(readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('x');
  });

  it('read-only: the write is still refused', async () => {
    lab = makeLab();
    server = await codexServer(lab, { sandboxMode: 'read-only' });
    const dir = await scratchOf(server);
    expect((await server.run(attempt(`await write({ path: scratchDir + '/a.txt', content: 'x' })`))).result).toBe('PermissionDenied:denied');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('the rest of the state dir stays protected', async () => {
    lab = makeLab();
    server = await codexServer(lab, { sandboxMode: 'workspace-write' });
    expect((await server.run(attempt(`await write({ path: scratchDir + '/../evil.json', content: 'x' })`))).result).toMatch(/^ToolError:(outside-workspace|protected-path)$/);
  });

  describe.runIf(contained)('with the OS sandbox', () => {
    it('bash writes into the scratch directory and nowhere else in the state dir', async () => {
      lab = makeLab();
      // The state dir sits inside a writable root here, the case in which only the explicit denies protect it.
      server = await codexServer(lab, { sandboxMode: 'workspace-write', extraToml: `[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(lab.base)}]\n` });
      const dir = await scratchOf(server);
      mkdirSync(path.join(lab.stateDir, 'journal'), { recursive: true });
      const out = await server.run(`
        const a = await bash({ command: 'echo inside > ' + scratchDir + '/a.txt' });
        const b = await bash({ command: 'echo outside > ${lab.stateDir}/journal/planted.txt' });
        const c = await bash({ command: 'cd ${lab.stateDir} && echo outside > brand-new.txt' });
        return [a.exitCode, b.exitCode, c.exitCode];
      `);
      expect(out.result).toEqual([0, expect.any(Number), expect.any(Number)]);
      expect((out.result as number[])[1]).not.toBe(0);
      expect((out.result as number[])[2]).not.toBe(0);
      expect(existsSync(path.join(lab.stateDir, 'brand-new.txt'))).toBe(false);
      expect(readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('inside\n');
      expect(existsSync(path.join(lab.stateDir, 'journal', 'planted.txt'))).toBe(false);
    });
  });
});

describe('the scratch directory under the generic adapter', () => {
  it('does not exist', async () => {
    lab = makeLab();
    const server2 = createMcpServer({
      version: '0.0.0',
      host: 'generic',
      env: {},
      serverCwd: lab.ws,
      stateDir: lab.stateDir,
      createRuntime: () => ({ host: 'generic', contextProvider: new GenericContextProvider(), adapter: new GenericHostAdapter({ stateDir: lab?.stateDir ?? '' }), tools: new NodeToolRuntime({ stateDir: lab?.stateDir ?? '' }), sandbox: new QuickJsSandbox(), maxTimeoutMs: 20_000 }),
    });
    const client = new Client({ name: 't', version: '1.0.0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server2.connect(b);
    await client.connect(a);
    const res = await client.callTool({ name: 'run', arguments: { code: 'return typeof scratchDir;' } });
    expect(JSON.stringify(res)).toContain('undefined');
    expect(existsSync(path.join(lab.stateDir, 'scratch'))).toBe(false);
    await client.close();
  });
});
