import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callAt, claudeServer, makeLab, posix, snapshot, type Lab, type Server } from './harness.js';

/**
 * An allow-all `Bash` rule approves commands that name files outside the
 * working directories, as Claude Code does. Everything that refuses such a
 * command natively must still refuse it through `run`: deny rules, PreToolUse
 * hooks, sensitive files, the paths agent-code-mode protects, a symlink from
 * the workspace to outside, and targets only known at run time.
 */
describe.runIf(posix)('allow-all Bash rule and files outside the working directories (Claude)', () => {
  let lab: Lab;
  let server: Server;

  beforeAll(async () => {
    lab = makeLab();
    mkdirSync(path.join(lab.outside, 'locked'));
    symlinkSync(lab.outside, path.join(lab.ws, 'link-out'));
    symlinkSync(path.join(lab.outside, 'a', 'b', 'c'), path.join(lab.ws, 'deep-link'));
    mkdirSync(path.join(lab.ws, '.git'));
    writeFileSync(path.join(lab.ws, 'a.txt'), 'a\n');
    writeFileSync(path.join(lab.ws, '.git', 'config'), 'a\n');
    writeFileSync(path.join(lab.ws, '1'), 's/a/b/\n');
    symlinkSync(path.join('..', 'state'), path.join(lab.ws, 'back\\slash'));
    symlinkSync('back\\slash', path.join(lab.ws, 'alias'));
    const hook = lab.hook('deny-hooked', `if (String(input.tool_input?.command ?? '').includes('hooked')) { process.stderr.write('hooked commands are blocked'); process.exit(2); }`);
    server = await claudeServer(lab, {
      permissions: { allow: ['Bash'], deny: ['Bash(rm:*)', `Edit(/${lab.outside}/locked/**)`] },
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `"${process.execPath}" "${hook}"` }] }] },
    });
  });
  afterAll(async () => {
    await server.close();
    lab.cleanup();
  });

  const attempt = (command: string): string =>
    `try { await bash({ command: ${JSON.stringify(command)} }); return 'RAN'; } catch (e) { return e.name + ':' + e.code; }`;

  it('runs a command that writes a literal file outside (control: the host allows it)', async () => {
    const out = await server.run(attempt(`touch ${lab.outside}/new.txt`));
    expect(out.result).toBe('RAN');
    expect(existsSync(path.join(lab.outside, 'new.txt'))).toBe(true);
  });

  const refused: readonly [string, (l: Lab) => string][] = [
    ['a deny rule (rm outside)', (l) => `rm ${l.outside}/secret.txt`],
    ['a deny rule (rm -rf outside)', (l) => `rm -rf ${l.outside}`],
    ['an Edit deny rule on the redirect target', (l) => `echo x > ${l.outside}/locked/f.txt`],
    ['a PreToolUse hook', (l) => `touch ${l.outside}/hooked.txt`],
    ['a sensitive file outside', (l) => `echo x > ${l.outside}/.bashrc`],
    ['a sensitive directory outside', (l) => `mkdir -p ${l.outside}/.git && echo x > ${l.outside}/.git/config`],
    ['the home Claude settings', (l) => `echo '{}' > ${l.home}/.claude/settings.json`],
    ['the project Claude settings', () => `echo '{"permissions":{"allow":["Bash"]}}' > .claude/settings.json`],
    ['the server state directory', (l) => `touch ${l.stateDir}/planted`],
    ['a symlink from the workspace to outside', () => 'echo x > link-out/via-link.txt'],
    ['a symlink to an outside dir whose parents are missing', () => 'echo x > deep-link/f.txt'],
    ['`..` after a symlink to outside', () => 'echo x > link-out/../escaped.txt'],
    ['sed -i with a numeric script file name on .git', () => 'sed -i -f 1 .git/config'],
    ['an abbreviated --target-directory', () => 'cp --target-dir=.git a.txt'],
    ['a -t into the state directory hidden by a later -t that --suffix consumes', (l) => `cp -t ${l.stateDir} --suffix -tplain a.txt`],
    ['a hard link to an Edit-denied file disguised by --suffix -s', (l) => `ln --suffix -s ${l.outside}/locked/f copy`],
    ['the sed -i backup written into the state directory', () => "sed -i'../state/*' 's/a/b/' a.txt"],
    ['a symlink whose target has a backslash, leading into the state directory', () => 'echo x > alias/f'],
    ['a link generated into .claude by a destination directory', () => 'ln -s settings.json .claude'],
    ['a copy generated into .claude by a trailing slash', () => 'cp a.txt settings.json .claude/'],
    ['a backup named by --suffix onto the project settings', () => 'cp --backup=simple --suffix=.json a.txt .claude/settings'],
    ['a symlink to an outside dir whose parents are missing (mkdir -p)', () => 'mkdir -p deep-link/x/y'],
    ['an attached -t destination (cp)', () => 'cp -t.git a.txt'],
    ['a --target-directory= destination (mv)', () => 'mv --target-directory=.git a.txt'],
    ['a target named by a variable', (l) => `d=${l.outside}; touch $d/var.txt`],
    ['a relative target after cd', (l) => `cd ${l.outside} && touch after-cd.txt`],
  ];
  for (const [name, command] of refused) {
    it(`still refuses a command outside caught by ${name}`, async () => {
      const before = snapshot(lab.base);
      const out = await server.run(attempt(command(lab)));
      expect(out.result).toMatch(/^PermissionDenied:/);
      expect(callAt(out, 1)?.decision).not.toBe('allowed');
      expect(snapshot(lab.base)).toEqual(before);
    });
  }
});

describe.runIf(posix)('paths agent-code-mode protects, through bash, in modes that skip the host checks (Claude)', () => {
  for (const mode of ['bypassPermissions', 'auto']) {
    it(`refuses a bash write into the server state directory in ${mode} mode`, async () => {
      const lab = makeLab();
      const server = await claudeServer(lab, { permissions: { allow: ['Bash'], defaultMode: mode } });
      try {
        symlinkSync(lab.stateDir, path.join(lab.ws, 'st'));
        writeFileSync(path.join(lab.ws, 'a.txt'), 'a\n');
        symlinkSync(path.join('..', 'state'), path.join(lab.ws, 'back\\slash'));
        symlinkSync('back\\slash', path.join(lab.ws, 'alias'));
        for (const command of [`touch ${lab.stateDir}/planted`, `echo x > ${lab.home}/.claude/settings.json`, 'touch st/planted', "sed -i'../state/*' 's/a/b/' a.txt", 'echo x > alias/planted',
          'ln -s settings.json .claude', 'cp a.txt settings.json .claude/', 'cp --backup=simple --suffix=.json a.txt .claude/settings', "echo x > '.claude/settings\\extra.json'"]) {
          const out = await server.run(`try { await bash({ command: ${JSON.stringify(command)} }); return 'RAN'; } catch (e) { return e.name + ':' + e.code; }`);
          expect([command, out.result]).toEqual([command, 'PermissionDenied:denied']);
        }
        expect(existsSync(path.join(lab.stateDir, 'planted'))).toBe(false);
        expect(existsSync(path.join(lab.stateDir, 'a.txt'))).toBe(false);
        expect(existsSync(path.join(lab.ws, '.claude', 'settings.json.json'))).toBe(false);
        expect(existsSync(path.join(lab.ws, '.claude', 'settings\\extra.json'))).toBe(false);
        expect(existsSync(path.join(lab.home, '.claude', 'settings.json'))).toBe(false);
      } finally {
        await server.close();
        lab.cleanup();
      }
    });
  }
});

describe.runIf(posix)('a protected write is denied before an ask rule (Claude)', () => {
  for (const mode of ['default', 'bypassPermissions', 'auto']) {
    it(`denies, not asks, in ${mode} mode`, async () => {
      const lab = makeLab();
      const server = await claudeServer(lab, { permissions: { allow: ['Bash'], ask: ['Bash'], defaultMode: mode } });
      try {
        symlinkSync(lab.stateDir, path.join(lab.ws, 'st'));
        for (const command of ['echo x > ../state/f', 'echo x > st/f']) {
          const out = await server.run(`try { await bash({ command: ${JSON.stringify(command)} }); return 'RAN'; } catch (e) { return e.name + ':' + e.code + ':' + e.source; }`);
          expect([command, out.result]).toEqual([command, 'PermissionDenied:denied:rule']);
        }
        expect(existsSync(path.join(lab.stateDir, 'f'))).toBe(false);
      } finally {
        await server.close();
        lab.cleanup();
      }
    });
  }
});
