import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeServer, makeLab, posix, type Lab, type Server } from './harness.js';

/**
 * The detect-and-report net through `run`: a bash spelling the static check
 * cannot see into (a `node -e` that writes a protected file) is allowed by an
 * allow-all Bash rule. The write is not prevented, but the response says so
 * in `warnings`, keeps the call's result, and a transactional run is not
 * rolled back because of it.
 */
describe.runIf(posix)('protected paths changed by bash are reported (Claude)', () => {
  let lab: Lab | undefined;
  let server: Server | undefined;
  afterEach(async () => {
    await server?.close();
    lab?.cleanup();
    server = undefined;
    lab = undefined;
  });

  const nodeWrite = (file: string): string => `node -e "require('fs').writeFileSync(process.argv[1], 'planted')" ${JSON.stringify(file)}`;

  it('warns for the server state dir and keeps the result', async () => {
    lab = makeLab();
    server = await claudeServer(lab, { permissions: { allow: ['Bash'] } });
    const planted = path.join(lab.stateDir, 'planted');
    const out = await server.run(`const r = await bash({ command: ${JSON.stringify(`${nodeWrite(planted)}; echo done`)} }); return r.stdout;`);
    expect(out.ok).toBe(true);
    expect(out.result).toBe('done\n');
    expect(out.warnings).toEqual([`protected path changed during bash call c1: ${planted}`]);
    expect(readFileSync(planted, 'utf8')).toBe('planted');
  });

  it('warns for the project settings in a transaction, which is not rolled back', async () => {
    lab = makeLab();
    server = await claudeServer(lab, { permissions: { allow: ['Bash'], defaultMode: 'bypassPermissions' } });
    const local = path.join(lab.ws, '.claude', 'settings.local.json');
    const out = await server.run(
      `await write({ path: 'a.txt', content: 'kept' }); await bash({ command: ${JSON.stringify(nodeWrite(local))} }); return 'end';`,
      { transaction: true },
    );
    expect(out.ok).toBe(true);
    expect(out.result).toBe('end');
    expect(out.rolledBack).toBeUndefined();
    expect(out.warnings).toEqual([`protected path changed during bash call c2: ${local}`]);
    expect(readFileSync(path.join(lab.ws, 'a.txt'), 'utf8')).toBe('kept');
  });

  const record = (id: string, mode = 'default'): string => JSON.stringify({ tool_use_id: id, session_id: 's', permission_mode: mode });
  const nodeWriteText = (file: string, text: string): string =>
    `node -e "require('fs').writeFileSync(process.argv[1], Buffer.from(process.argv[2], 'base64'), { mode: 0o600 })" ${JSON.stringify(file)} ${Buffer.from(text).toString('base64')}`;

  it('a parallel companion-hook record is routine; an existing record rewritten is reported', async () => {
    lab = makeLab();
    server = await claudeServer(lab, { permissions: { allow: ['Bash'], defaultMode: 'bypassPermissions' } });
    const ctx = path.join(lab.stateDir, 'ctx');
    mkdirSync(ctx, { mode: 0o700 });
    chmodSync(ctx, 0o700);
    const fresh = path.join(ctx, 'toolu_parallel.json');
    const quiet = await server.run(`await bash({ command: ${JSON.stringify(nodeWriteText(fresh, record('toolu_parallel')))} }); return 'end';`);
    expect(quiet.ok).toBe(true);
    expect(quiet.warnings ?? []).toEqual([]);
    const loud = await server.run(`await bash({ command: ${JSON.stringify(nodeWriteText(fresh, record('toolu_parallel', 'bypassPermissions')))} }); return 'end';`);
    expect(loud.warnings).toEqual([`protected path changed during bash call c1: ${fresh}`]);
  });

  it('sees a hook rewritten through a linked directory, and a target rewritten through a link a previous call made', async () => {
    lab = makeLab();
    server = await claudeServer(lab, { permissions: { allow: ['Bash'], defaultMode: 'bypassPermissions' } });
    const real = path.join(lab.outside, 'hooks-real');
    mkdirSync(real);
    writeFileSync(path.join(real, 'hook.sh'), 'exit 0\n');
    mkdirSync(path.join(lab.ws, '.claude'), { recursive: true });
    symlinkSync(real, path.join(lab.ws, '.claude', 'hooks'));
    const viaDir = await server.run(`await bash({ command: ${JSON.stringify(nodeWrite(path.join(real, 'hook.sh')))} }); return 'end';`);
    expect(viaDir.warnings).toEqual([`protected path changed during bash call c1: ${path.join(lab.ws, '.claude', 'hooks', 'hook.sh')}`]);
    const target = path.join(lab.outside, 'settings-target.json');
    writeFileSync(target, '{}');
    const link = path.join(lab.ws, '.claude', 'settings.local.json');
    const twoCalls = await server.run(
      `await bash({ command: ${JSON.stringify(`node -e "require('fs').symlinkSync(process.argv[1], process.argv[2])" ${JSON.stringify(target)} ${JSON.stringify(link)}`)} }); await bash({ command: ${JSON.stringify(nodeWrite(target))} }); return 'end';`,
    );
    expect(twoCalls.warnings).toEqual([`protected path changed during bash call c1: ${link}`, `protected path changed during bash call c2: ${link}`]);
  });

  it("does not report the run's own journal, before or after bash", async () => {
    lab = makeLab();
    server = await claudeServer(lab, { permissions: { allow: ['Bash'], defaultMode: 'bypassPermissions' } });
    const out = await server.run(
      `await write({ path: 'a.txt', content: '1' }); await bash({ command: 'echo x > b.txt' }); await write({ path: 'a.txt', content: '2' }); await write({ path: 'c.txt', content: '3' }); return 'end';`,
      { transaction: true },
    );
    expect(out.ok).toBe(true);
    expect(out.warnings ?? []).toEqual([]);
  });
});
