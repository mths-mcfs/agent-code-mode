import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BASH_SANDBOX_AVAILABLE, callAt, claudeServer, codexServer, makeLab, posix, snapshot, type Lab, type Server } from './harness.js';

const scratchBaseOf = (lab: Lab): string => `${lab.stateDir}-scratch`;
const leftovers = (lab: Lab): string[] => (existsSync(scratchBaseOf(lab)) ? readdirSync(scratchBaseOf(lab)) : []);

describe.runIf(posix)('scratch directory, undo and test() through run', () => {
  let lab: Lab | undefined;
  let server: Server | undefined;
  afterEach(async () => {
    await server?.close();
    lab?.cleanup();
    server = undefined;
    lab = undefined;
  });

  describe('scratch', () => {
    it('gives each run a new private directory, keeps it out of changedFiles and the journal, and deletes it before the response', async () => {
      lab = makeLab({ 'a.txt': 'a\n' });
      server = await claudeServer(lab, {});
      const out = await server.run(
        `await write({ path: scratchDir + '/notes.txt', content: 'n\\n' });
         await edit({ path: scratchDir + '/notes.txt', oldString: 'n', newString: 'm' });
         await write({ path: 'a.txt', content: 'b\\n' });
         return { dir: scratchDir, text: (await read({ path: scratchDir + '/notes.txt' })).content };`,
        { transaction: true },
      );
      expect(out.ok).toBe(true);
      const result = out.result as { dir: string; text: string };
      expect(result.text).toBe('m\n');
      expect(path.dirname(result.dir)).toBe(scratchBaseOf(lab));
      expect(out.changedFiles).toEqual(['a.txt']);
      expect(existsSync(result.dir)).toBe(false);
      expect(leftovers(lab)).toEqual([]);
      const second = await server.run('return scratchDir;');
      expect(second.result).not.toBe(result.dir);
    });

    it('a run cannot read or write another session\'s scratch directory', async () => {
      lab = makeLab();
      server = await claudeServer(lab, {});
      const other = path.join(scratchBaseOf(lab), `${process.ppid}-${'c'.repeat(32)}`);
      mkdirSync(other, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(other, 'x'), 'secret');
      const out = await server.run(
        `const r = [];
         try { await read({ path: ${JSON.stringify(path.join(other, 'x'))} }); r.push('read'); } catch (e) { r.push(e.code); }
         try { await write({ path: ${JSON.stringify(path.join(other, 'y'))}, content: 'y' }); r.push('written'); } catch (e) { r.push(e.code); }
         return r;`,
      );
      expect(out.result).toEqual(['outside-workspace', 'outside-workspace']);
      expect(readdirSync(other)).toEqual(['x']);
    });

    it.runIf(BASH_SANDBOX_AVAILABLE)('lets sandboxed bash write there but still not outside the project', async () => {
      lab = makeLab();
      server = await claudeServer(lab, {}, { mode: 'default' });
      const before = snapshot(lab.outside);
      const out = await server.run(
        `const inScratch = await bash({ command: 'echo hi > note.txt && cat note.txt', cwd: scratchDir });
         const outside = await bash({ command: 'echo x > ${lab.outside}/written.txt' });
         return { inScratch: inScratch.stdout, outside: outside.exitCode };`,
      );
      expect(out.ok).toBe(true);
      expect(out.result).toEqual({ inScratch: 'hi\n', outside: expect.any(Number) });
      expect((out.result as { outside: number }).outside).not.toBe(0);
      expect(snapshot(lab.outside)).toEqual(before);
      expect(leftovers(lab)).toEqual([]);
    });

    it('has the permissions of the project directory under Claude: default mode refuses both writes', async () => {
      lab = makeLab();
      server = await claudeServer(lab, {}, { mode: 'default' });
      const out = await server.run(
        `const r = [];
         for (const p of [scratchDir + '/x', 'x']) { try { await write({ path: p, content: 'x' }); r.push('written'); } catch (e) { r.push(e.name); } }
         return r;`,
      );
      expect(out.result).toEqual(['PermissionDenied', 'PermissionDenied']);
    });

    it('run B cannot write into run A\'s scratch while A is still running', async () => {
      lab = makeLab();
      server = await claudeServer(lab, {});
      const handoff = path.join(lab.ws, 'a-dir.txt');
      const done = path.join(lab.ws, 'b-done.txt');
      const a = server.run(
        `await write({ path: 'a-dir.txt', content: scratchDir });
         await write({ path: scratchDir + '/a.txt', content: 'from A' });
         for (let i = 0; i < 200; i++) { try { await read({ path: 'b-done.txt' }); break; } catch { await bash({ command: 'sleep 0.05' }); } }
         return (await read({ path: scratchDir + '/a.txt' })).content;`,
      );
      for (let i = 0; i < 200 && !existsSync(handoff); i++) await new Promise((r) => setTimeout(r, 25));
      const aDir = readFileSync(handoff, 'utf8');
      const b = await server.run(
        `const r = [];
         try { await write({ path: ${JSON.stringify(aDir)} + '/a.txt', content: 'from B' }); r.push('written'); } catch (e) { r.push(e.code); }
         try { await write({ path: ${JSON.stringify(aDir)} + '/new.txt', content: 'from B' }); r.push('written'); } catch (e) { r.push(e.code); }
         r.push(scratchDir !== ${JSON.stringify(aDir)});
         await write({ path: 'b-done.txt', content: 'done' });
         return r;`,
      );
      expect(b.result).toEqual(['outside-workspace', 'outside-workspace', true]);
      expect((await a).result).toBe('from A');
      expect(existsSync(done)).toBe(true);
    });

    it('is not granted when a root the run may write holds the scratch base', async () => {
      lab = makeLab();
      server = await claudeServer(lab, { permissions: { additionalDirectories: [lab.base] } });
      const out = await server.run('return typeof scratchDir;');
      expect(out.result).toBe('undefined');
      expect(out.warnings).toEqual([expect.stringMatching(/no scratch directory: .* holds the scratch base/)]);
      expect(leftovers(lab)).toEqual([]);
    });

    it('is not granted under Claude settings that block writes outside the working directories', async () => {
      lab = makeLab();
      server = await claudeServer(lab, { permissions: { blockWritesOutsideWorkingDirectories: true } });
      const out = await server.run('return typeof scratchDir;');
      expect(out.result).toBe('undefined');
      expect(leftovers(lab)).toEqual([]);
    });

    // The lab sits in the system temp dir: a temp dir Codex makes writable stands elsewhere, so it does not hold the scratch base.
    const elsewhere = { slashTmp: '/nonexistent-acm-tmp', tmpdir: null };
    it.each([
      ['read-only', 'undefined'],
      ['workspace-write', 'string'],
      ['danger-full-access', 'string'],
    ])('under Codex %s it is %s', async (sandboxMode, type) => {
      lab = makeLab();
      server = await codexServer(lab, { sandboxMode, tmpDirs: elsewhere });
      const out = await server.run('return typeof scratchDir;');
      expect(out.result).toBe(type);
    });

    it('under Codex workspace-write it is not granted when the writable /tmp holds the scratch base', async () => {
      lab = makeLab();
      server = await codexServer(lab, { sandboxMode: 'workspace-write', tmpDirs: { slashTmp: path.dirname(lab.base), tmpdir: null } });
      const out = await server.run('return typeof scratchDir;');
      expect(out.result).toBe('undefined');
    });

    it.runIf(BASH_SANDBOX_AVAILABLE)('when a writable root holds the scratch base, neither bash nor write reaches other runs\' directories', async () => {
      lab = makeLab();
      const other = path.join(scratchBaseOf(lab), `${process.ppid}-${'a'.repeat(32)}`);
      mkdirSync(other, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(other, 'theirs.txt'), 'theirs');
      server = await codexServer(lab, { sandboxMode: 'workspace-write', tmpDirs: { slashTmp: path.dirname(lab.base), tmpdir: null } });
      const out = await server.run(
        `const viaBash = await bash({ command: 'echo mine > ${other}/theirs.txt; echo x > ${other}/new.txt; echo y > ${scratchBaseOf(lab)}/forged.owner' });
         let viaWrite; try { await write({ path: ${JSON.stringify(path.join(other, 'theirs.txt'))}, content: 'mine' }); viaWrite = 'written'; } catch (e) { viaWrite = e.code; }
         return { bash: viaBash.exitCode, viaWrite, scratch: typeof scratchDir };`,
      );
      expect(out.result).toMatchObject({ viaWrite: expect.stringMatching(/^(protected-path|outside-workspace)$/), scratch: 'undefined' });
      expect((out.result as { bash: number }).bash).not.toBe(0);
      expect(readFileSync(path.join(other, 'theirs.txt'), 'utf8')).toBe('theirs');
      expect(existsSync(path.join(other, 'new.txt'))).toBe(false);
      expect(existsSync(path.join(scratchBaseOf(lab), 'forged.owner'))).toBe(false);
    });

    it.runIf(BASH_SANDBOX_AVAILABLE)('protects a covered scratch base even when this run\'s scratch could not be made', async () => {
      lab = makeLab();
      const other = path.join(scratchBaseOf(lab), `${process.ppid}-${'b'.repeat(32)}`);
      mkdirSync(other, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(other, 'theirs.txt'), 'theirs');
      // A base others can read makes creating this run's scratch fail.
      chmodSync(scratchBaseOf(lab), 0o755);
      server = await codexServer(lab, { sandboxMode: 'workspace-write', tmpDirs: { slashTmp: path.dirname(lab.base), tmpdir: null } });
      const out = await server.run(`const r = await bash({ command: 'echo mine > ${other}/theirs.txt; echo x > ${other}/new.txt' }); return { bash: r.exitCode, scratch: typeof scratchDir };`);
      expect(out.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/no scratch directory: .*not private/)]));
      expect(out.result).toMatchObject({ scratch: 'undefined' });
      expect((out.result as { bash: number }).bash).not.toBe(0);
      expect(readFileSync(path.join(other, 'theirs.txt'), 'utf8')).toBe('theirs');
      expect(existsSync(path.join(other, 'new.txt'))).toBe(false);
    });

    it('under Codex workspace-write with both temp dirs excluded it is not granted', async () => {
      lab = makeLab();
      server = await codexServer(lab, { sandboxMode: 'workspace-write', extraToml: '[sandbox_workspace_write]\nexclude_slash_tmp = true\nexclude_tmpdir_env_var = true' });
      const out = await server.run('return typeof scratchDir;');
      expect(out.result).toBe('undefined');
    });
  });

  describe('undo', () => {
    it('puts back this run\'s writes and edits byte for byte and the run goes on', async () => {
      const original = '﻿first\r\nsecond\n';
      lab = makeLab({ 'a.txt': original, 'b.txt': 'b0\n' });
      server = await claudeServer(lab, {});
      const out = await server.run(
        `await write({ path: 'a.txt', content: 'changed' });
         await edit({ path: 'b.txt', oldString: 'b0', newString: 'b1' });
         await write({ path: 'new/dir/c.txt', content: 'c' });
         const u = await undo();
         await write({ path: 'kept.txt', content: 'k' });
         return u;`,
        { transaction: true },
      );
      expect(out.ok).toBe(true);
      expect(out.result).toEqual({ restored: ['new/dir/c.txt', 'b.txt', 'a.txt'], skipped: [] });
      expect(readFileSync(path.join(lab.ws, 'a.txt'), 'utf8')).toBe(original);
      expect(readFileSync(path.join(lab.ws, 'b.txt'), 'utf8')).toBe('b0\n');
      expect(existsSync(path.join(lab.ws, 'new'))).toBe(false);
      expect(readFileSync(path.join(lab.ws, 'kept.txt'), 'utf8')).toBe('k');
      expect(out.changedFiles).toEqual(['kept.txt']);
    });

    it('undoes only the paths given, and says which it did not write', async () => {
      lab = makeLab({ 'a.txt': 'a0', 'b.txt': 'b0' });
      server = await claudeServer(lab, {});
      const out = await server.run(
        `await write({ path: 'a.txt', content: 'a1' }); await write({ path: 'b.txt', content: 'b1' });
         return await undo({ paths: ['a.txt', 'never.txt'] });`,
        { transaction: true },
      );
      expect(out.result).toEqual({ restored: ['a.txt'], skipped: [{ path: 'never.txt', reason: expect.stringMatching(/not written or edited by this run/) }] });
      expect(readFileSync(path.join(lab.ws, 'b.txt'), 'utf8')).toBe('b1');
      expect(out.changedFiles).toEqual(['b.txt']);
    });

    it('leaves a file another process changed since, says why, and says bash is not undone', async () => {
      lab = makeLab({ 'a.txt': 'a0', 'w.js': '' });
      writeFileSync(path.join(lab.ws, 'w.js'), "require('fs').writeFileSync('a.txt', 'from another process');\n");
      server = await claudeServer(lab, { sandbox: { enabled: false }, permissions: { allow: ['Bash(node w.js)'] } });
      const out = await server.run(
        `await write({ path: 'a.txt', content: 'a1' });
         await bash({ command: 'node w.js' });
         return await undo();`,
        { transaction: true },
      );
      expect(out.ok).toBe(true);
      expect(out.result).toEqual({
        restored: [],
        skipped: [{ path: 'a.txt', reason: expect.stringMatching(/changed by another writer/) }],
        notUndone: '1 bash call(s) of this run are not undone',
      });
      expect(readFileSync(path.join(lab.ws, 'a.txt'), 'utf8')).toBe('from another process');
    });

    it('drops a file another process already put back from changedFiles and diff', async () => {
      lab = makeLab({ 'a.txt': 'a0', 'w.js': '' });
      writeFileSync(path.join(lab.ws, 'w.js'), "require('fs').writeFileSync('a.txt', 'a0');\n");
      server = await claudeServer(lab, { sandbox: { enabled: false }, permissions: { allow: ['Bash(node w.js)'] } });
      const out = await server.run(`await write({ path: 'a.txt', content: 'a1' }); await bash({ command: 'node w.js' }); return await undo();`, { transaction: true });
      expect(out.result).toMatchObject({ restored: ['a.txt'], skipped: [] });
      expect(out.changedFiles).toBeUndefined();
      expect(readFileSync(path.join(lab.ws, 'a.txt'), 'utf8')).toBe('a0');
    });

    it('needs a transaction', async () => {
      lab = makeLab({ 'a.txt': 'a0' });
      server = await claudeServer(lab, {});
      const out = await server.run(`await write({ path: 'a.txt', content: 'a1' }); try { await undo(); } catch (e) { return [e.name, e.code, e.message]; }`);
      expect(out.result).toEqual(['ToolError', 'invalid-args', expect.stringMatching(/transaction: true/)]);
      expect(readFileSync(path.join(lab.ws, 'a.txt'), 'utf8')).toBe('a1');
    });
  });

  describe('test()', () => {
    const project = {
      'math.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert';\ntest('adds', () => assert.equal(1 + 1, 2));\ntest('subtracts', () => assert.equal(3 - 1, 1));\n",
      'hang.mjs': 'setInterval(() => {}, 1000);\n',
    };
    const settings = { sandbox: { enabled: false }, permissions: { allow: ['Bash(node --test math.test.mjs)', 'Bash(node hang.mjs)'] } };

    it('runs the project tests through the bash path and reports the failing one', async () => {
      lab = makeLab(project);
      server = await claudeServer(lab, settings);
      const out = await server.run(`return await test({ command: 'node --test math.test.mjs' });`);
      expect(out.ok).toBe(true);
      // Node 22 reports in TAP when stdout is not a terminal, later versions with the spec reporter.
      expect(out.result).toMatchObject({ ok: false, exitCode: 1, runner: expect.stringMatching(/^(node:test|tap)$/), passed: 1, failed: 1, failures: [expect.objectContaining({ name: 'subtracts' })] });
      expect(callAt(out, 1)).toMatchObject({ decision: 'allowed' });
      expect(out.calls).toEqual([expect.objectContaining({ tool: 'test' })]);
    });

    it('is refused when the host would not run the command', async () => {
      lab = makeLab(project);
      server = await claudeServer(lab, settings);
      const out = await server.run(`try { await test({ command: 'node --test' }); return 'ran'; } catch (e) { return e.name; }`);
      expect(out.result).toBe('PermissionDenied');
    });

    it('reports a hung test command as timed out, never as a pass', async () => {
      lab = makeLab(project);
      server = await claudeServer(lab, settings);
      const out = await server.run(`return await test({ command: 'node hang.mjs', timeoutMs: 1000 });`);
      expect(out.result).toMatchObject({ ok: false, timedOut: true, runner: null });
    });
  });
});
