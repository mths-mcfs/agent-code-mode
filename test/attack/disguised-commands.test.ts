import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BASH_SANDBOX_AVAILABLE, callAt, claudeServer, codexServer, makeLab, posix, type Lab, type Server } from './harness.js';

const DISGUISES: readonly string[] = [
  `rm -f victim.txt`,
  `env -S 'rm -f victim.txt'`,
  `env FOO=1 rm -f victim.txt`,
  `bash -O extglob -c 'rm -f victim.txt'`,
  `sh -c "rm -f victim.txt"`,
  `echo $(rm -f victim.txt)`,
  'echo `rm -f victim.txt`',
  `command command command rm -f victim.txt`,
  `trap 'rm -f victim.txt' EXIT`,
  `true # just a comment\nrm -f victim.txt`,
  `/bin/rm -f victim.txt`,
  `true && rm -f victim.txt`,
  `echo hi; rm -f victim.txt`,
  `(rm -f victim.txt)`,
  `exec rm -f victim.txt`,
  `xargs rm -f <<< victim.txt`,
  `find . -name victim.txt -exec rm -f {} \\;`,
];

function attempt(command: string): string {
  return `try { await bash({ command: ${JSON.stringify(command)} }); return 'RAN'; } catch (e) { return e.name + ':' + e.code; }`;
}

function suite(name: string, start: (lab: Lab) => Promise<Server>): void {
  describe.runIf(posix)(`disguised denied commands (${name})`, () => {
    let lab: Lab;
    let server: Server;
    const victim = (): string => path.join(lab.ws, 'victim.txt');

    beforeAll(async () => {
      lab = makeLab();
      server = await start(lab);
    });
    beforeEach(() => writeFileSync(victim(), 'keep me\n'));
    afterAll(async () => {
      await server.close();
      lab.cleanup();
    });

    it.runIf(BASH_SANDBOX_AVAILABLE)('runs a harmless command (control)', async () => {
      const out = await server.run(`return (await bash({ command: 'echo ok' })).stdout`);
      expect(out.result).toBe('ok\n');
    });

    for (const command of DISGUISES) {
      it(`denies ${JSON.stringify(command)}`, async () => {
        const out = await server.run(attempt(command));
        expect(out.result).toBe('PermissionDenied:denied');
        expect(callAt(out, 1)?.decision).toBe('denied');
        expect(existsSync(victim())).toBe(true);
      });
    }
  });
}

suite('Claude deny rule Bash(rm:*)', (lab) => claudeServer(lab, { permissions: { deny: ['Bash(rm:*)'] } }));
suite('Codex forbidden prefix rule', (lab) => codexServer(lab, { rules: 'prefix_rule(pattern=["rm"], decision="forbidden")\n' }));
