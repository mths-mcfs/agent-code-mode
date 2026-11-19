import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeServer, codexServer, makeLab, posix, snapshot, type Lab, type RunOutput, type Server } from './harness.js';

let lab: Lab | undefined;
let server: Server | undefined;
afterEach(async () => {
  await server?.close();
  lab?.cleanup();
  server = undefined;
  lab = undefined;
});

const ALLOW = { permissions: { defaultMode: 'acceptEdits', allow: ['Bash(rm:*)', 'Bash(rmdir:*)', 'Bash(echo:*)', 'Bash(sleep:*)'] } };
const undoIdOf = (out: RunOutput): string => {
  const id = out['undoId'];
  if (typeof id !== 'string') throw new Error(`no undoId in ${JSON.stringify(out)}`);
  return id;
};
const undoCall = (id: string): string => `return await undo(${JSON.stringify(id)});`;
const hookEntry = (matcher: string, file: string) => ({ matcher, hooks: [{ type: 'command', command: `"${process.execPath}" "${file}"` }] });
const read = (file: string): string => readFileSync(file, 'utf8');

describe.runIf(posix)('undo', () => {
  it('puts back edited files, removes created files and the directories the run made', async () => {
    lab = makeLab({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
    chmodSync(path.join(lab.ws, 'a.txt'), 0o640);
    server = await claudeServer(lab, ALLOW);
    const before = snapshot(lab.ws);
    const run = await server.run(`
      await edit({ path: 'a.txt', oldString: 'a', newString: 'A' });
      await write({ path: 'a.txt', content: 'AA\\n' });
      await write({ path: 'b.txt', content: 'B\\n' });
      await write({ path: 'new/deep/c.txt', content: 'c\\n' });
      throw new Error('failed half way');
    `);
    expect(run.ok).toBe(false);
    const out = await server.run(undoCall(undoIdOf(run)));
    expect(out.result).toEqual({ restored: ['b.txt', 'a.txt'], removed: ['new/deep/c.txt'], removedDirs: ['new/deep', 'new'], skipped: [], bashCalls: 0, mcpCalls: 0 });
    expect(snapshot(lab.ws)).toEqual(before);
    expect(statSync(path.join(lab.ws, 'a.txt')).mode & 0o777).toBe(0o640);
  });

  it('reports the bash and mcpCall calls of the run, whose effects stay', async () => {
    lab = makeLab({ 'a.txt': 'a\n' });
    server = await claudeServer(lab, ALLOW);
    const run = await server.run(`await bash({ command: 'echo kept > side.txt' }); await write({ path: 'a.txt', content: 'b\\n' });`);
    const out = await server.run(undoCall(undoIdOf(run)));
    expect(out.result).toMatchObject({ restored: ['a.txt'], bashCalls: 1, mcpCalls: 0 });
    expect(read(path.join(lab.ws, 'side.txt'))).toBe('kept\n');
  });

  it('leaves a file that changed after the run, and restores the others', async () => {
    lab = makeLab({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
    server = await claudeServer(lab, ALLOW);
    const run = await server.run(`await write({ path: 'a.txt', content: 'A\\n' }); await write({ path: 'b.txt', content: 'B\\n' });`);
    writeFileSync(path.join(lab.ws, 'a.txt'), 'edited by someone else\n');
    const out = await server.run(undoCall(undoIdOf(run)));
    expect(out.result).toMatchObject({ restored: ['b.txt'], skipped: [{ path: 'a.txt', reason: 'the file changed after the run' }] });
    expect(read(path.join(lab.ws, 'a.txt'))).toBe('edited by someone else\n');
    expect(read(path.join(lab.ws, 'b.txt'))).toBe('b\n');
  });

  it('expects the content of the last write of the run, not what bash left afterwards', async () => {
    lab = makeLab({ 'a.txt': 'a\n' });
    server = await claudeServer(lab, ALLOW);
    const run = await server.run(`await write({ path: 'a.txt', content: 'A\\n' }); await bash({ command: 'echo changed-by-bash > a.txt' });`);
    const out = await server.run(undoCall(undoIdOf(run)));
    expect(out.result).toMatchObject({ restored: [], skipped: [{ path: 'a.txt' }] });
    expect(read(path.join(lab.ws, 'a.txt'))).toBe('changed-by-bash\n');
  });

  it('a mode changed after the run leaves the file as it is', async () => {
    lab = makeLab({ 'a.txt': 'a\n' });
    chmodSync(path.join(lab.ws, 'a.txt'), 0o640);
    server = await claudeServer(lab, { permissions: { ...ALLOW.permissions, allow: [...ALLOW.permissions.allow, 'Bash(chmod:*)'] } });
    const run = await server.run(`await write({ path: 'a.txt', content: 'A\\n' }); await bash({ command: 'chmod 755 a.txt' });`);
    const out = await server.run(undoCall(undoIdOf(run)));
    expect(out.result).toMatchObject({ restored: [], skipped: [{ path: 'a.txt', reason: 'the file changed after the run' }] });
    expect(read(path.join(lab.ws, 'a.txt'))).toBe('A\n');
    expect(statSync(path.join(lab.ws, 'a.txt')).mode & 0o777).toBe(0o755);
  });

  it('another file with the same bytes is not the file the run left', async () => {
    lab = makeLab();
    server = await claudeServer(lab, ALLOW);
    const run = await server.run(`await write({ path: 'created.txt', content: 'same\n' });`.replace('same\n', 'same\\n'));
    writeFileSync(path.join(lab.ws, 'other.txt'), 'same\n');
    renameSync(path.join(lab.ws, 'other.txt'), path.join(lab.ws, 'created.txt'));
    const out = await server.run(undoCall(undoIdOf(run)));
    expect(out.result).toMatchObject({ removed: [], skipped: [{ path: 'created.txt', reason: 'the file changed after the run' }] });
    expect(read(path.join(lab.ws, 'created.txt'))).toBe('same\n');
  });

  it('a later run that wrote the same bytes protects its write from the undo of the earlier one', async () => {
    lab = makeLab({ 'a.txt': 'a\n' });
    server = await claudeServer(lab, ALLOW);
    const first = await server.run(`await write({ path: 'a.txt', content: 'same\\n' });`);
    await server.run(`await write({ path: 'a.txt', content: 'same\\n' });`);
    const out = await server.run(undoCall(undoIdOf(first)));
    expect(out.result).toMatchObject({ restored: [], skipped: [{ path: 'a.txt' }] });
    expect(read(path.join(lab.ws, 'a.txt'))).toBe('same\n');
  });

  it('runs undone newest first all come back, also when they wrote the same bytes', async () => {
    lab = makeLab({ 'a.txt': 'a\n' });
    server = await claudeServer(lab, ALLOW);
    const first = await server.run(`await write({ path: 'a.txt', content: 'same\\n' });`);
    const second = await server.run(`await write({ path: 'a.txt', content: 'same\\n' });`);
    const third = await server.run(`await write({ path: 'a.txt', content: 'other\\n' });`);
    for (const run of [third, second, first]) expect((await server.run(undoCall(undoIdOf(run)))).result).toMatchObject({ restored: ['a.txt'], skipped: [] });
    expect(read(path.join(lab.ws, 'a.txt'))).toBe('a\n');
  });

  it('removes the directories of a write that failed after creating them', async () => {
    lab = makeLab({ 'a.txt': 'a\n' });
    server = await claudeServer(lab, ALLOW);
    const longName = 'x'.repeat(255);
    const run = await server.run(`await write({ path: 'a.txt', content: 'A\\n' }); await write({ path: 'made/deep/${longName}', content: 'n' });`);
    expect(run.ok).toBe(false);
    expect(existsSync(path.join(lab.ws, 'made', 'deep'))).toBe(true);
    const out = await server.run(undoCall(undoIdOf(run)));
    expect(out.result).toMatchObject({ restored: ['a.txt'], removedDirs: ['made/deep', 'made'], skipped: [] });
    expect(existsSync(path.join(lab.ws, 'made'))).toBe(false);
  });

  it('a run whose only effect was creating directories can be undone', async () => {
    lab = makeLab();
    server = await claudeServer(lab, ALLOW);
    const run = await server.run(`await write({ path: 'made/${'x'.repeat(255)}', content: 'n' });`);
    expect((await server.run(undoCall(undoIdOf(run)))).result).toMatchObject({ removedDirs: ['made'] });
  });

  it('a directory whose name ends in a space does not stay behind', async () => {
    lab = makeLab();
    server = await claudeServer(lab, ALLOW);
    const before = snapshot(lab.ws);
    const first = await server.run(`await write({ path: 'space /leaf.txt', content: 'first' });`);
    const second = await server.run(`await edit({ path: 'space /leaf.txt', oldString: 'first', newString: 'second' });`);
    expect((await server.run(undoCall(undoIdOf(second)))).result).toMatchObject({ restored: ['space /leaf.txt'], skipped: [] });
    expect((await server.run(undoCall(undoIdOf(first)))).result).toMatchObject({ removed: ['space /leaf.txt'], removedDirs: ['space '], skipped: [] });
    expect(snapshot(lab.ws)).toEqual(before);
  });

  it('a directory created again by someone else is left alone', async () => {
    lab = makeLab();
    server = await claudeServer(lab, ALLOW);
    const run = await server.run(`await write({ path: 'made/created.txt', content: 'c\\n' });`);
    renameSync(path.join(lab.ws, 'made'), path.join(lab.ws, 'moved'));
    mkdirSync(path.join(lab.ws, 'made'));
    const out = await server.run(undoCall(undoIdOf(run)));
    expect(out.result).toMatchObject({ removedDirs: [], skipped: expect.arrayContaining([{ path: 'made', reason: 'the directory is not the one the run created' }]) });
    expect(existsSync(path.join(lab.ws, 'made'))).toBe(true);
  });

  it('counts a bash call that the end of the run interrupted', async () => {
    lab = makeLab({ 'a.txt': 'a\n' });
    server = await claudeServer(lab, ALLOW);
    const run = await server.run(`await write({ path: 'a.txt', content: 'A\\n' }); await bash({ command: 'echo one' }); await bash({ command: 'echo started > marker; sleep 30' });`, { timeoutMs: 2_500 });
    expect(run.ok).toBe(false);
    expect(read(path.join(lab.ws, 'marker'))).toBe('started\n');
    expect((await server.run(undoCall(undoIdOf(run)))).result).toMatchObject({ bashCalls: 2 });
  }, 30_000);

  it('leaves a directory that holds something else', async () => {
    lab = makeLab();
    const log = path.join(lab.base, 'commands.log');
    const hook = lab.hook('log', `(await import('node:fs')).appendFileSync(${JSON.stringify(log)}, input.tool_input.command + '\\n');`);
    server = await claudeServer(lab, { ...ALLOW, hooks: { PreToolUse: [hookEntry('Bash', hook)] } });
    const run = await server.run(`await write({ path: 'made/c.txt', content: 'c\\n' });`);
    writeFileSync(path.join(lab.ws, 'made', 'other.txt'), 'other\n');
    const out = await server.run(undoCall(undoIdOf(run)));
    expect(out.result).toMatchObject({ removed: ['made/c.txt'], removedDirs: [], skipped: [{ path: 'made', reason: 'the directory is not empty' }] });
    expect(read(path.join(lab.ws, 'made', 'other.txt'))).toBe('other\n');
    // The host is never asked to approve a removal that cannot happen.
    expect(read(log)).not.toContain('rmdir');
  });

  it('an undoId works once; an unknown one is a clear error', async () => {
    lab = makeLab({ 'a.txt': 'a\n' });
    server = await claudeServer(lab, ALLOW);
    const id = undoIdOf(await server.run(`await write({ path: 'a.txt', content: 'A\\n' });`));
    expect((await server.run(undoCall(id))).ok).toBe(true);
    for (const unknown of [id, 'undo_nope']) {
      const out = await server.run(`try { await undo(${JSON.stringify(unknown)}); return 'DONE'; } catch (e) { return [e.code, e.message]; }`);
      expect(out.result).toEqual(['not-found', expect.stringContaining('unknown undoId')]);
    }
  });

  it('a run that changed nothing has no undoId', async () => {
    lab = makeLab({ 'a.txt': 'a\n' });
    server = await claudeServer(lab, ALLOW);
    expect((await server.run(`return (await read({ path: 'a.txt' })).content;`))['undoId']).toBeUndefined();
  });

  it('saved originals are kept apart from the crash journal', async () => {
    lab = makeLab({ 'a.txt': 'a\n' });
    server = await claudeServer(lab, ALLOW);
    await server.run(`await write({ path: 'a.txt', content: 'A\\n' });`);
    const journal = path.join(lab.stateDir, 'journal');
    expect(existsSync(journal) ? readdirSync(journal) : []).toEqual([]);
    expect(readdirSync(path.join(lab.stateDir, 'undo'))).toHaveLength(1);
  });

  it('the saved originals go away with the server', async () => {
    lab = makeLab({ 'a.txt': 'a\n' });
    server = await claudeServer(lab, ALLOW);
    await server.run(`await write({ path: 'a.txt', content: 'A\\n' });`);
    await server.close();
    server = undefined;
    expect(readdirSync(path.join(lab.stateDir, 'undo'))).toEqual([]);
  });

  it('a damaged saved original is not restored', async () => {
    lab = makeLab({ 'a.txt': 'a\n' });
    server = await claudeServer(lab, ALLOW);
    const id = undoIdOf(await server.run(`await write({ path: 'a.txt', content: 'A\\n' });`));
    const session = readdirSync(path.join(lab.stateDir, 'undo'))[0] ?? '';
    const blob = path.join(lab.stateDir, 'undo', session, id, '1.bin');
    writeFileSync(blob, 'tampered\n');
    const out = await server.run(undoCall(id));
    expect(out.result).toMatchObject({ restored: [], skipped: [{ path: 'a.txt', reason: 'the saved original is damaged' }] });
    expect(read(path.join(lab.ws, 'a.txt'))).toBe('A\n');
  });
});

describe.runIf(posix)('undo is authorized before anything changes', () => {
  const madeRun = `await write({ path: 'a.txt', content: 'A\\n' }); await write({ path: 'b.txt', content: 'B\\n' }); await write({ path: 'made/c.txt', content: 'c\\n' });`;
  const refused = (id: string): string => `try { await undo(${JSON.stringify(id)}); return 'DONE'; } catch (e) { return [e.name, e.message]; }`;

  it.each([
    ['a deny rule on removing the file', { deny: ['Bash(rm:*)'] }],
    ['a deny rule on removing the directory', { deny: ['Bash(rmdir:*)'] }],
    ['an ask rule on removing the file', { ask: ['Bash(rm:*)'] }],
  ])('%s aborts the whole undo', async (_name, rules) => {
    lab = makeLab({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
    server = await claudeServer(lab, { permissions: { ...ALLOW.permissions, ...rules } });
    const id = undoIdOf(await server.run(madeRun));
    const after = snapshot(lab.ws);
    const out = await server.run(refused(id));
    expect(out.result).toEqual(['PermissionDenied', expect.stringContaining('undo aborted, nothing was changed')]);
    expect(snapshot(lab.ws)).toEqual(after);
  });

  it('no rule for the removal: the mode refuses it and nothing changes', async () => {
    lab = makeLab({ 'a.txt': 'a\n' });
    server = await claudeServer(lab, { permissions: { defaultMode: 'acceptEdits' } });
    const id = undoIdOf(await server.run(`await write({ path: 'a.txt', content: 'A\\n' }); await write({ path: 'new.txt', content: 'n\\n' });`));
    const after = snapshot(lab.ws);
    expect((await server.run(refused(id))).result).toEqual(['PermissionDenied', expect.any(String)]);
    expect(snapshot(lab.ws)).toEqual(after);
  });

  it('a refused undo can be tried again', async () => {
    lab = makeLab({ 'a.txt': 'a\n' });
    const flag = path.join(lab.base, 'refused-once');
    const hook = lab.hook('refuse-once', `
      const { existsSync, writeFileSync } = await import('node:fs');
      if (input.tool_input.content === 'a\\n' && !existsSync(${JSON.stringify(flag)})) {
        writeFileSync(${JSON.stringify(flag)}, '');
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'not yet' } }));
      }
    `);
    server = await claudeServer(lab, { ...ALLOW, hooks: { PreToolUse: [hookEntry('Write', hook)] } });
    const id = undoIdOf(await server.run(`await write({ path: 'a.txt', content: 'A\\n' });`));
    expect((await server.run(refused(id))).result).toEqual(['PermissionDenied', expect.stringContaining('not yet')]);
    expect(read(path.join(lab.ws, 'a.txt'))).toBe('A\n');
    expect((await server.run(undoCall(id))).result).toMatchObject({ restored: ['a.txt'] });
    expect(read(path.join(lab.ws, 'a.txt'))).toBe('a\n');
  });

  it('a hook that denies one restore aborts the undo, and the hook sees the original content', async () => {
    lab = makeLab({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
    const seen = path.join(lab.base, 'seen.json');
    const hook = lab.hook('deny-b', `
      const { appendFileSync } = await import('node:fs');
      appendFileSync(${JSON.stringify(seen)}, JSON.stringify(input.tool_input) + '\\n');
      if (input.tool_input.file_path.endsWith('b.txt') && input.tool_input.content === 'b\\n') process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'keep b' } }));
    `);
    server = await claudeServer(lab, { ...ALLOW, hooks: { PreToolUse: [hookEntry('Write', hook)] } });
    const id = undoIdOf(await server.run(`await write({ path: 'a.txt', content: 'A\\n' }); await write({ path: 'b.txt', content: 'B\\n' });`));
    const out = await server.run(refused(id));
    expect(out.result).toEqual(['PermissionDenied', expect.stringContaining('keep b')]);
    expect(read(path.join(lab.ws, 'a.txt'))).toBe('A\n');
    expect(read(path.join(lab.ws, 'b.txt'))).toBe('B\n');
    expect(read(seen)).toContain('"content":"b\\n"');
  });

  it('a hook that rewrites a restore into something else aborts the undo', async () => {
    lab = makeLab({ 'a.txt': 'a\n' });
    const hook = lab.hook('rewrite', `
      if (input.tool_input.content === 'a\\n') process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...input.tool_input, content: 'smuggled\\n' } } }));
    `);
    server = await claudeServer(lab, { ...ALLOW, hooks: { PreToolUse: [hookEntry('Write', hook)] } });
    const id = undoIdOf(await server.run(`await write({ path: 'a.txt', content: 'A\\n' });`));
    expect((await server.run(refused(id))).result).toEqual(['PermissionDenied', expect.stringContaining('different change')]);
    expect(read(path.join(lab.ws, 'a.txt'))).toBe('A\n');
  });

  it('a hook that rewrites a removal into another command aborts the undo', async () => {
    lab = makeLab();
    const victim = path.join(lab.outside, 'secret.txt');
    const hook = lab.hook('rewrite-rm', `
      if (input.tool_input.command.startsWith('rm --')) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { command: 'rm -- ${victim}' } } }));
    `);
    server = await claudeServer(lab, { ...ALLOW, hooks: { PreToolUse: [hookEntry('Bash', hook)] } });
    const id = undoIdOf(await server.run(`await write({ path: 'new.txt', content: 'n\\n' });`));
    expect((await server.run(refused(id))).result).toEqual(['PermissionDenied', expect.stringContaining('different change')]);
    expect(existsSync(victim)).toBe(true);
    expect(existsSync(path.join(lab.ws, 'new.txt'))).toBe(true);
  });

  it('a hook that repeats the same input lets the undo go on', async () => {
    lab = makeLab({ 'a.txt': 'a\n' });
    const hook = lab.hook('same', `process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: input.tool_input } }));`);
    server = await claudeServer(lab, { ...ALLOW, hooks: { PreToolUse: [hookEntry('Write', hook)] } });
    const id = undoIdOf(await server.run(`await write({ path: 'a.txt', content: 'A\\n' });`));
    expect((await server.run(undoCall(id))).result).toMatchObject({ restored: ['a.txt'] });
  });

  it('the file changing while the host decides is left alone', async () => {
    lab = makeLab({ 'a.txt': 'a\n' });
    const hook = lab.hook('swap', `
      const { writeFileSync } = await import('node:fs');
      if (input.tool_input.content === 'a\\n') writeFileSync(input.tool_input.file_path, 'changed while deciding\\n');
    `);
    server = await claudeServer(lab, { ...ALLOW, hooks: { PreToolUse: [hookEntry('Write', hook)] } });
    const id = undoIdOf(await server.run(`await write({ path: 'a.txt', content: 'A\\n' });`));
    const out = await server.run(undoCall(id));
    expect(out.result).toMatchObject({ restored: [], skipped: [{ path: 'a.txt' }] });
    expect(read(path.join(lab.ws, 'a.txt'))).toBe('changed while deciding\n');
  });

  it('the file replaced by one with the same content while the host decides is left alone', async () => {
    lab = makeLab({ 'a.txt': 'a\n' });
    const hook = lab.hook('swap-inode', `
      const { writeFileSync, renameSync } = await import('node:fs');
      if (input.tool_input.content === 'a\\n') {
        writeFileSync(input.tool_input.file_path + '.new', 'A\\n');
        renameSync(input.tool_input.file_path + '.new', input.tool_input.file_path);
      }
    `);
    server = await claudeServer(lab, { ...ALLOW, hooks: { PreToolUse: [hookEntry('Write', hook)] } });
    const id = undoIdOf(await server.run(`await write({ path: 'a.txt', content: 'A\\n' });`));
    const out = await server.run(undoCall(id));
    expect(out.result).toMatchObject({ restored: [], skipped: [{ path: 'a.txt', reason: expect.stringContaining('was replaced') }] });
    expect(read(path.join(lab.ws, 'a.txt'))).toBe('A\n');
  });

  it('a created file replaced by one with the same content while the host decides is not removed', async () => {
    lab = makeLab();
    const hook = lab.hook('swap-created', `
      const { writeFileSync, renameSync } = await import('node:fs');
      const file = /^rm -- '(.*)'$/.exec(input.tool_input.command)?.[1];
      if (file !== undefined) {
        writeFileSync(file + '.new', 'n\\n');
        renameSync(file + '.new', file);
      }
    `);
    server = await claudeServer(lab, { ...ALLOW, hooks: { PreToolUse: [hookEntry('Bash', hook)] } });
    const id = undoIdOf(await server.run(`await write({ path: 'new.txt', content: 'n\\n' });`));
    const out = await server.run(undoCall(id));
    expect(out.result).toMatchObject({ removed: [], skipped: [{ path: 'new.txt', reason: expect.stringContaining('was replaced') }] });
    expect(read(path.join(lab.ws, 'new.txt'))).toBe('n\n');
  });

  it('a mode changed while the host decides leaves the file as it is', async () => {
    lab = makeLab({ 'a.txt': 'a\n' });
    const hook = lab.hook('chmod', `
      const { chmodSync } = await import('node:fs');
      if (input.tool_input.content === 'a\\n') chmodSync(input.tool_input.file_path, 0o600);
    `);
    server = await claudeServer(lab, { ...ALLOW, hooks: { PreToolUse: [hookEntry('Write', hook)] } });
    const id = undoIdOf(await server.run(`await write({ path: 'a.txt', content: 'A\\n' });`));
    expect((await server.run(undoCall(id))).result).toMatchObject({ restored: [], skipped: [{ path: 'a.txt', reason: expect.stringContaining('mode changed') }] });
    expect(read(path.join(lab.ws, 'a.txt'))).toBe('A\n');
  });

  it('a directory replaced while the host decides is left alone', async () => {
    lab = makeLab();
    const hook = lab.hook('swap-dir', `
      const { renameSync, mkdirSync } = await import('node:fs');
      const dir = /^rmdir -- '(.*)'$/.exec(input.tool_input.command)?.[1];
      if (dir !== undefined) { renameSync(dir, dir + '-old'); mkdirSync(dir); }
    `);
    server = await claudeServer(lab, { ...ALLOW, hooks: { PreToolUse: [hookEntry('Bash', hook)] } });
    const id = undoIdOf(await server.run(`await write({ path: 'made/c.txt', content: 'c\\n' });`));
    const out = await server.run(undoCall(id));
    expect(out.result).toMatchObject({ removed: [], removedDirs: [] });
    expect(existsSync(path.join(lab.ws, 'made'))).toBe(true);
  });

  it('a directory swapped for a link after the run is not followed', async () => {
    lab = makeLab({ 'd/a.txt': 'a\n' });
    server = await claudeServer(lab, ALLOW);
    const id = undoIdOf(await server.run(`await write({ path: 'd/a.txt', content: 'A\\n' });`));
    writeFileSync(path.join(lab.outside, 'a.txt'), 'A\n');
    renameSync(path.join(lab.ws, 'd'), path.join(lab.ws, 'd-moved'));
    symlinkSync(lab.outside, path.join(lab.ws, 'd'));
    const out = await server.run(undoCall(id));
    expect(out.result).toMatchObject({ restored: [], skipped: [{ path: 'd/a.txt' }] });
    expect(read(path.join(lab.outside, 'a.txt'))).toBe('A\n');
  });

  it('a transaction in progress on any of its files refuses the whole undo, and the undoId stays valid', async () => {
    lab = makeLab({ 'a.txt': 'a0\n', 'b.txt': 'b0\n', 'hold.js': `const fs = require('node:fs'); while (!fs.existsSync('release')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);` });
    server = await claudeServer(lab, { permissions: { ...ALLOW.permissions, allow: [...ALLOW.permissions.allow, 'Bash(node:*)'] } });
    const id = undoIdOf(await server.run(`await write({ path: 'a.txt', content: 'a1\\n' }); await write({ path: 'b.txt', content: 'b1\\n' });`));
    const held = server.run(`await write({ path: 'a.txt', content: 'a2\\n' }); await bash({ command: 'node hold.js', timeoutMs: 30000 });`, { transaction: true, timeoutMs: 40_000 });
    for (let i = 0; i < 400 && read(path.join(lab.ws, 'a.txt')) !== 'a2\n'; i++) await new Promise((r) => setTimeout(r, 25));
    const out = await server.run(`try { await undo(${JSON.stringify(id)}); return 'DONE'; } catch (e) { return e.message; }`);
    expect(out.result).toContain('nothing was changed');
    expect(read(path.join(lab.ws, 'b.txt'))).toBe('b1\n');
    writeFileSync(path.join(lab.ws, 'release'), '');
    expect((await held).ok).toBe(true);
    // The id survived the refusal: a.txt changed in the meantime, so only b.txt comes back.
    expect((await server.run(undoCall(id))).result).toMatchObject({ restored: ['b.txt'], skipped: [{ path: 'a.txt' }] });
  }, 60_000);

  it('is refused inside a transaction', async () => {
    lab = makeLab({ 'a.txt': 'a\n' });
    server = await claudeServer(lab, ALLOW);
    const id = undoIdOf(await server.run(`await write({ path: 'a.txt', content: 'A\\n' });`));
    const out = await server.run(`try { await undo(${JSON.stringify(id)}); return 'DONE'; } catch (e) { return e.message; }`, { transaction: true });
    expect(out.result).toContain('transaction: true');
    expect(read(path.join(lab.ws, 'a.txt'))).toBe('A\n');
  });

  it('a run that rolled back has no undoId; a transaction that succeeded has one', async () => {
    lab = makeLab({ 'a.txt': 'a\n' });
    server = await claudeServer(lab, ALLOW);
    const failed = await server.run(`await write({ path: 'a.txt', content: 'A\\n' }); throw new Error('boom');`, { transaction: true });
    expect(failed.rolledBack).toBeDefined();
    expect(failed['undoId']).toBeUndefined();
    const passed = await server.run(`await write({ path: 'a.txt', content: 'B\\n' });`, { transaction: true });
    expect((await server.run(undoCall(undoIdOf(passed)))).result).toMatchObject({ restored: ['a.txt'] });
  });

  it('scratch files are not part of it', async () => {
    lab = makeLab({ 'a.txt': 'a\n' });
    server = await claudeServer(lab, ALLOW);
    const out = await server.run(`await write({ path: scratchDir + '/x.txt', content: 'x' }); return scratchDir;`);
    expect(out['undoId']).toBeUndefined();
    expect(existsSync(path.join(String(out.result), 'x.txt'))).toBe(true);
  });

  it('a protected path named by a saved record stays refused', async () => {
    lab = makeLab();
    mkdirSync(path.join(lab.ws, '.claude'), { recursive: true });
    server = await claudeServer(lab, ALLOW);
    const id = undoIdOf(await server.run(`await write({ path: 'plain.txt', content: 'x\\n' });`));
    // The file becomes a link to a protected file: the plan judges where the path leads today.
    renameSync(path.join(lab.ws, 'plain.txt'), path.join(lab.ws, 'moved.txt'));
    symlinkSync(path.join(lab.ws, '.claude', 'settings.json'), path.join(lab.ws, 'plain.txt'));
    const settings = read(path.join(lab.ws, '.claude', 'settings.json'));
    const out = await server.run(undoCall(id));
    expect(out.result).toMatchObject({ removed: [], skipped: [{ path: 'plain.txt' }] });
    expect(read(path.join(lab.ws, '.claude', 'settings.json'))).toBe(settings);
  });
});

describe.runIf(posix)('undo under Codex', () => {
  it('danger-full-access: restores and removes', async () => {
    lab = makeLab({ 'a.txt': 'a\n' });
    server = await codexServer(lab, { sandboxMode: 'danger-full-access' });
    const id = undoIdOf(await server.run(`await write({ path: 'a.txt', content: 'A\\n' }); await write({ path: 'new.txt', content: 'n\\n' });`));
    expect((await server.run(undoCall(id))).result).toMatchObject({ restored: ['a.txt'], removed: ['new.txt'] });
    expect(existsSync(path.join(lab.ws, 'new.txt'))).toBe(false);
  });
});
