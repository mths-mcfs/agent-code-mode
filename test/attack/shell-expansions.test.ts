import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeServer, codexServer, makeLab, posix, type Lab, type Server } from './harness.js';

/**
 * Words bash changes before the command sees them (brace and tilde expansion,
 * ANSI-C and locale quoting, arithmetic, process substitution, extglob,
 * backslashes) must not let a rule check see one path while bash hands the
 * command another. Each case either passes the exact word the rules checked
 * or is denied; the file outside the workspace is never read and the victim
 * is never removed.
 */

let lab: Lab | undefined;
let server: Server | undefined;
afterEach(async () => {
  await server?.close();
  lab?.cleanup();
  server = undefined;
  lab = undefined;
});

async function attempt(s: Server, command: string): Promise<string> {
  const out = await s.run(`try { const r = await bash({ command: ${JSON.stringify(command)} }); return 'RAN:' + r.stdout + r.stderr; } catch (e) { return e.name + ':' + e.code + ':' + e.message; }`);
  return String(out.result);
}

/** Reads of `outside/secret.txt` written so a naive analysis sees a path inside the workspace. */
function outsideReads(l: Lab): string[] {
  const rel = path.relative(l.ws, path.join(l.outside, 'secret.txt'));
  return [
    `cat {${l.outside}/secret.txt,x}`,
    `cat x{,} {${l.outside}/secret.txt,}`,
    `head -n 5 {${l.outside},x}/secret.txt`,
    `cat ~+/${rel}`,
    `cat ~nobody${l.outside}/secret.txt`,
    `cat $'${rel.replace(/\./g, '\\x2e')}'`,
    `cat $"${rel}"`,
    `cat <(cat ${rel})`,
    `shopt -s extglob\ncat @(${rel})`,
    `cat \\.\\./${rel.slice(3)}`,
    `cat x$((0))/../${rel}`,
  ];
}

describe.runIf(posix)('shell expansions do not reach outside the workspace (Claude)', () => {
  it('never reads the outside file with `Bash(cat:*)` and `Bash(head:*)` allowed', async () => {
    lab = makeLab({ x: 'inside x\n' });
    server = await claudeServer(lab, { permissions: { allow: ['Bash(cat:*)', 'Bash(head:*)', 'Bash(shopt:*)'] } });
    for (const command of outsideReads(lab)) {
      const text = await attempt(server, command);
      expect(text, command).not.toContain('outside secret');
      expect(text, command).toMatch(/PermissionDenied/);
    }
  });

  it('still runs words whose expansion it resolves exactly', async () => {
    lab = makeLab({ 'a b': 'AB\n', x: 'X\n' });
    server = await claudeServer(lab, { permissions: { allow: ['Bash(cat:*)', 'Bash(printf:*)'] } });
    expect(await attempt(server, `cat \\a\\ b 'x'`)).toContain('RAN:AB\nX\n');
    expect(await attempt(server, `printf '%s\\n' {} a{b}c '!x'`)).toContain('RAN:{}\na{b}c\n!x\n');
  });
});

/** `rm` of a directory whose deny rule only matches the command as written (quotes kept). */
const MULTIBYTE = ['é', '€', '😀', 'é€😀'];

describe.runIf(posix)('a deny rule still matches after multi-byte text (Claude)', () => {
  for (const ch of MULTIBYTE) {
    it(`denies \`echo ${ch}; rm -rf 'x y'\``, async () => {
      lab = makeLab();
      mkdirSync(path.join(lab.ws, 'x y'));
      writeFileSync(path.join(lab.ws, 'x y', 'keep.txt'), 'keep\n');
      server = await claudeServer(lab, { permissions: { allow: ['Bash'], deny: ["Bash(rm -rf 'x y')", 'Bash(rm -rf "$HOME")'] } });
      for (const command of [`echo ${ch}; rm -rf 'x y'`, `echo "${ch}${ch}" && rm -rf 'x y'`, `printf ${ch} | rm -rf 'x y'`, `echo ${ch}; rm -rf "$HOME"`]) {
        const text = await attempt(server, command);
        expect(text, command).toMatch(/^PermissionDenied:denied:denied by deny rule/);
      }
      expect(existsSync(path.join(lab.ws, 'x y', 'keep.txt'))).toBe(true);
    });
  }
});

describe.runIf(posix)('Codex rules see the words bash runs', () => {
  it('denies a forbidden program hidden behind an expansion, and after multi-byte text', async () => {
    lab = makeLab();
    const victim = path.join(lab.ws, 'victim.txt');
    server = await codexServer(lab, { rules: 'prefix_rule(pattern=["rm"], decision="forbidden")\nprefix_rule(pattern=["cat", "/etc/hostname"], decision="forbidden")\n' });
    const commands = [
      '{rm,-f,victim.txt}',
      'r{m,} -f victim.txt',
      '\\rm -f victim.txt',
      "$'rm' -f victim.txt",
      '$"rm" -f victim.txt',
      'cat {/etc/hostname,x}',
      'cat ~nobody/etc/hostname',
      ...MULTIBYTE.map((ch) => `echo ${ch}; rm -f victim.txt`),
    ];
    for (const command of commands) {
      writeFileSync(victim, 'keep me\n');
      const text = await attempt(server, command);
      expect(text, command).toMatch(/^PermissionDenied:denied:/);
      expect(existsSync(victim), command).toBe(true);
    }
  });
});
