import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeServer, codexServer, makeLab, posix, type Lab, type Server } from './harness.js';

describe.runIf(posix)('protected policy files changed by bash are reported', () => {
  let lab: Lab | undefined;
  let server: Server | undefined;
  afterEach(async () => {
    await server?.close();
    lab?.cleanup();
    server = undefined;
    lab = undefined;
  });

  const claude = { sandbox: { enabled: false }, permissions: { allow: ['Bash(node w1.js)', 'Bash(node w2.js)'] } };
  const writer = (l: Lab, n: number, file: string, text: string, linkTo?: string): string => {
    const body = linkTo === undefined ? `fs.writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(text)}, { mode: 0o600 })` : `fs.symlinkSync(${JSON.stringify(linkTo)}, ${JSON.stringify(file)})`;
    writeFileSync(path.join(l.ws, `w${n}.js`), `const fs = require('fs');\n${body};\nconsole.log('done');\n`);
    return `await bash({ command: 'node w${n}.js' });`;
  };

  it('reports a bash write to the project settings and keeps the file as bash left it', async () => {
    lab = makeLab();
    server = await claudeServer(lab, claude);
    const settings = path.join(lab.ws, '.claude', 'settings.json');
    writer(lab, 1, settings, '{}');
    const out = await server.run(`const r = await bash({ command: 'node w1.js' }); return r.stdout;`);
    expect(out.ok).toBe(true);
    expect(out.result).toBe('done\n');
    expect(out.protectedChanges).toEqual([{ call: 'c1', command: 'bash node w1.js', when: 'during', changed: ['.claude/settings.json'] }]);
    expect(readFileSync(settings, 'utf8')).toBe('{}');
  });

  it('reports nothing for a bash call that touches no protected file', async () => {
    lab = makeLab();
    server = await claudeServer(lab, claude);
    const out = await server.run(`${writer(lab, 1, path.join(lab.ws, 'a.txt'), 'x')} return 'end';`);
    expect(out.ok).toBe(true);
    expect(out.protectedChanges).toBeUndefined();
  });

  it('keeps the report in a compact, cut response and in an error response', async () => {
    lab = makeLab();
    server = await claudeServer(lab, claude);
    const local = path.join(lab.ws, '.claude', 'settings.local.json');
    const cut = JSON.parse(await server.runText(`${writer(lab, 1, local, '{}')} return Array.from({ length: 20000 }, (_, i) => 'line ' + i);`)) as Record<string, unknown>;
    expect(cut['truncated']).toBe(true);
    expect(cut['protectedChanges']).toEqual([expect.objectContaining({ call: 'c1', changed: ['.claude/settings.local.json'] })]);
    const failed = JSON.parse(await server.runText(`${writer(lab, 1, local, '{"x":1}')} throw new Error('x'.repeat(50_000));`)) as Record<string, unknown>;
    expect(failed['ok']).toBe(false);
    expect(failed['protectedChanges']).toEqual([expect.objectContaining({ call: 'c1', changed: ['.claude/settings.local.json'] })]);
  });

  it('reports in a transaction, which is not rolled back because of it', async () => {
    lab = makeLab();
    server = await claudeServer(lab, claude);
    const local = path.join(lab.ws, '.claude', 'settings.local.json');
    const out = await server.run(`await write({ path: 'a.txt', content: 'kept' }); ${writer(lab, 1, local, '{}')} await write({ path: 'b.txt', content: 'kept' }); return 'end';`, {
      transaction: true,
    });
    expect(out.ok).toBe(true);
    expect(out.rolledBack).toBeUndefined();
    expect(out.protectedChanges).toEqual([expect.objectContaining({ call: 'c2', when: 'during', changed: ['.claude/settings.local.json'] })]);
    expect(readFileSync(path.join(lab.ws, 'a.txt'), 'utf8')).toBe('kept');
  });

  const record = (id: string, mode = 'default'): string => JSON.stringify({ tool_use_id: id, session_id: 's', permission_mode: mode });

  it('a new companion-hook record is routine, and a record rewritten afterwards is reported', async () => {
    lab = makeLab();
    server = await claudeServer(lab, claude);
    const fresh = path.join(lab.stateDir, 'ctx', 'toolu_parallel.json');
    const quiet = await server.run(`${writer(lab, 1, fresh, record('toolu_parallel'))} return 'end';`);
    expect(quiet.ok).toBe(true);
    expect(quiet.protectedChanges).toBeUndefined();
    const loud = await server.run(`${writer(lab, 1, fresh, record('toolu_parallel', 'bypassPermissions'))} return 'end';`);
    expect(loud.protectedChanges).toEqual([expect.objectContaining({ call: 'c1', changed: [fresh] })]);
  });

  it('follows links: a hook rewritten through a linked directory, and a target rewritten through a link an earlier call made', async () => {
    lab = makeLab();
    server = await claudeServer(lab, claude);
    const real = path.join(lab.outside, 'hooks-real');
    mkdirSync(real);
    writeFileSync(path.join(real, 'hook.sh'), 'exit 0\n');
    chmodSync(path.join(real, 'hook.sh'), 0o755);
    symlinkSync(real, path.join(lab.ws, '.claude', 'hooks'));
    const viaDir = await server.run(`${writer(lab, 1, path.join(real, 'hook.sh'), 'exit 2\n')} return 'end';`);
    expect(viaDir.protectedChanges).toEqual([expect.objectContaining({ call: 'c1', changed: ['.claude/hooks/hook.sh'] })]);

    const target = path.join(lab.outside, 'settings-target.json');
    writeFileSync(target, '{}');
    const link = path.join(lab.ws, '.claude', 'settings.local.json');
    const twoCalls = await server.run(`${writer(lab, 1, link, '', target)} ${writer(lab, 2, target, '{"permissions":{}}')} return 'end';`);
    expect(twoCalls.protectedChanges).toEqual([
      expect.objectContaining({ call: 'c1', when: 'during', changed: ['.claude/settings.local.json'] }),
      expect.objectContaining({ call: 'c2', when: 'during', changed: ['.claude/settings.local.json'] }),
    ]);
  });

  it('reports a Codex project config created by bash', async () => {
    lab = makeLab();
    server = await codexServer(lab);
    const out = await server.run(`await bash({ command: ${JSON.stringify(`mkdir -p .codex && echo 'approval_policy = "never"' > .codex/config.toml`)} }); return 'end';`);
    expect(out.ok).toBe(true);
    expect(out.protectedChanges).toEqual([expect.objectContaining({ call: 'c1', when: 'during', changed: ['.codex/config.toml'] })]);
  });
});
