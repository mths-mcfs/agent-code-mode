import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { BASH_SANDBOX_AVAILABLE, claudeServer, codexServer, makeLab, posix, type Lab, type Server } from './harness.js';

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
  it('approves nothing through a wildcard rule outside the sandbox', async () => {
    lab = makeLab({ x: 'inside x\n' });
    server = await claudeServer(lab, { sandbox: { enabled: false }, permissions: { allow: ['Bash(cat:*)', 'Bash(head:*)', 'Bash(shopt:*)'] } });
    const passed: string[] = [];
    for (const command of outsideReads(lab)) {
      const text = await attempt(server, command);
      if (text.includes('outside secret') || !text.includes('PermissionDenied')) passed.push(command);
    }
    expect(passed).toEqual([]);
  });

  it.runIf(BASH_SANDBOX_AVAILABLE)('still runs words whose expansion it resolves exactly', async () => {
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
    const passed: string[] = [];
    for (const command of commands) {
      writeFileSync(victim, 'keep me\n');
      const text = await attempt(server, command);
      if (!/^PermissionDenied:denied:/.test(text) || !existsSync(victim)) passed.push(command);
    }
    expect(passed).toEqual([]);
  });
});

/**
 * Tilde words a naive analysis keeps literal where bash expands them (after
 * the `=` or a `:` of an assignment-like argument). Bash runs with the
 * server process's `HOME`, which these tests point at the lab home the
 * adapters expand `~` to (in production both are the user's home).
 */
function useLabHome(l: Lab): string {
  const saved = process.env['HOME'];
  process.env['HOME'] = l.home;
  onTestFinished(() => {
    if (saved === undefined) delete process.env['HOME'];
    else process.env['HOME'] = saved;
  });
  return l.home;
}

describe.runIf(posix)('tilde expansion follows bash, not the text (Claude)', () => {
  it('denies a Bash deny rule on the expanded `+=` word', async () => {
    lab = makeLab();
    const home = useLabHome(lab);
    server = await claudeServer(lab, { permissions: { allow: ['Bash'], deny: [`Bash(printf %s a+=${home})`, `Bash(printf %s b=/x:${home})`] } });
    for (const command of [`printf %s a+=${home}`, 'printf %s a+=~', 'printf %s b=/x:~']) {
      const text = await attempt(server, command);
      expect(text, command).not.toMatch(/^RAN:/);
      expect(text, command).toMatch(/^PermissionDenied:/);
    }
  });
});

describe.runIf(posix && BASH_SANDBOX_AVAILABLE)('an env assignment with a run-time tilde is still an assignment (Claude)', () => {
  it('runs `env FOO=a~b printf ok` in the sandbox and still matches rules on the inner command', async () => {
    lab = makeLab();
    server = await claudeServer(lab, {}, { mode: 'default' });
    expect(await attempt(server, 'env FOO=a~b printf ok')).toBe('RAN:ok');
    expect(await attempt(server, 'env FOO=$(id) printf ok')).toMatch(/^PermissionDenied:/);
    await server.close();
    server = await claudeServer(lab, { permissions: { deny: ['Bash(printf ok)'] } }, { mode: 'default' });
    expect(await attempt(server, 'env FOO=a~b printf ok')).toMatch(/^PermissionDenied:denied:denied by deny rule/);
  });
});

describe.runIf(posix)('tilde expansion follows bash, not the text (Codex)', () => {
  it('denies a forbidden argv written with `+=~`, `declare`/`export` assignments and subscripts', async () => {
    lab = makeLab();
    const home = useLabHome(lab);
    server = await codexServer(lab, {
      rules: [`printf %s a+=${home}`, `export a+=${home}`, `declare a+=${home}:x`, `declare a[1]=${home}`]
        .map((argv) => `prefix_rule(pattern = ${JSON.stringify(argv.split(' '))}, decision = "forbidden")\n`)
        .join(''),
    });
    for (const command of [`printf %s ${JSON.stringify(`a+=${home}`)}`, 'printf %s a+=~', 'export a+=~', 'declare a+=~:x', 'declare a[1]=~']) {
      const text = await attempt(server, command);
      expect(text, command).not.toMatch(/^RAN:/);
      expect(text, command).toMatch(/^PermissionDenied:denied:/);
    }
  });
});
