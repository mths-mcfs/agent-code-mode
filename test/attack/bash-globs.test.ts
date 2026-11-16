import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeServer, makeLab, posix, type Lab, type Server } from './harness.js';

/**
 * Globs of pure readers (`cat`, `head`, `tail`, `wc`, `ls`) are expanded at
 * prepare and the command names each file literally. Every case here tries to
 * make that expansion read something it must not; the content of the file
 * outside the workspace (`outside secret`) and of a Read-denied file must
 * never reach the result.
 */

/** Arm-B rules of the benchmark: the native tools and the run tool allowed. */
const ALLOW = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'mcp__agent-code-mode__run'];

let lab: Lab | undefined;
let server: Server | undefined;
afterEach(async () => {
  await server?.close();
  lab?.cleanup();
  server = undefined;
  lab = undefined;
});

/** Runs `command` and returns the result or the error as text, plus the raw response. */
async function bash(s: Server, command: string): Promise<{ text: string; value: unknown }> {
  const text = await s.runText(`try { return await bash({ command: ${JSON.stringify(command)} }); } catch (e) { return { error: e.name + ':' + e.code + ':' + e.message }; }`);
  const value: unknown = JSON.parse(text.split('\n')[0] ?? 'null');
  return { text, value };
}

function hookOn(lab: Lab, script: string): Record<string, unknown> {
  return { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `"${process.execPath}" "${script}"` }] }] };
}

describe.runIf(posix)('bash glob expansion (Claude)', () => {
  it('reproduces the benchmark T7 command: the wc part is expanded and runs, node --test passes its own rule', async () => {
    lab = makeLab({
      'src/pipeline/parse.js': 'export const a = 1;\n',
      'src/pipeline/render.js': 'export const b = 2;\nexport const c = 3;\n',
      'test/pipeline.test.js': "import test from 'node:test';\ntest('pipeline', () => {});\n",
    });
    server = await claudeServer(lab, { permissions: { allow: ALLOW } });
    const out = await server.run(`return await bash({ command: 'ls src/pipeline; wc -l src/pipeline/* test/pipeline.test.js; node --test 2>&1 | head -80' })`);
    expect(out.ok).toBe(true);
    const result = out.result as { exitCode: number; stdout: string; command: string };
    expect(result.command).toBe("ls src/pipeline; wc -l -- 'src/pipeline/parse.js' 'src/pipeline/render.js' test/pipeline.test.js; node --test 2>&1 | head -80");
    expect(result.stdout).toMatch(/^parse\.js\nrender\.js\n +1 src\/pipeline\/parse\.js\n +2 src\/pipeline\/render\.js\n +2 test\/pipeline\.test\.js\n +5 total\n/);
    expect(result.stdout).toMatch(/pass 1/);
    expect(result.exitCode).toBe(0);
  });

  it('shows hooks the expanded command, exactly what runs', async () => {
    lab = makeLab({ 'a.js': 'A\n', 'b.js': 'B\n' });
    const seen = path.join(lab.base, 'seen.txt');
    const hook = lab.hook('record', `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(seen)}, input.tool_input.command + '\\n');`);
    server = await claudeServer(lab, { permissions: { allow: ALLOW }, hooks: hookOn(lab, hook) });
    const { value } = await bash(server, 'cat *.js');
    expect(value).toMatchObject({ ok: true, result: { stdout: 'A\nB\n', command: "cat -- 'a.js' 'b.js'" } });
    expect(readFileSync(seen, 'utf8')).toBe("cat -- 'a.js' 'b.js'\n");
  });

  it('refuses a glob that matches a symlink leading outside the workspace', async () => {
    lab = makeLab({ 'data/a.txt': 'inside\n' });
    symlinkSync(path.join(lab.outside, 'secret.txt'), path.join(lab.ws, 'data', 'b.txt'));
    symlinkSync(lab.outside, path.join(lab.ws, 'data', 'dir'));
    server = await claudeServer(lab, { permissions: { allow: ALLOW } });
    for (const command of ['cat data/*.txt', 'head -n 5 data/*', 'cat data/d*/*', 'ls data/*']) {
      const { text, value } = await bash(server, command);
      expect(value, command).toMatchObject({ ok: true, result: { error: expect.stringMatching(/^ToolError:outside-workspace:/) } });
      expect(text, command).not.toContain('outside secret');
    }
    // bypassPermissions does not open it either: the jail refuses, not a rule.
    await server.close();
    server = await claudeServer(lab, { permissions: { defaultMode: 'bypassPermissions' } });
    const { text } = await bash(server, 'cat data/*.txt');
    expect(text).toMatch(/outside-workspace/);
    expect(text).not.toContain('outside secret');
  });

  it('refuses to run when a file is swapped for a symlink after authorization and before commit', async () => {
    lab = makeLab({ 'data/a.txt': 'inside a\n', 'data/b.txt': 'inside b\n', 'data/real.txt': 'real\n' });
    symlinkSync('real.txt', path.join(lab.ws, 'data', 'l.txt'));
    const secret = path.join(lab.outside, 'secret.txt');
    // The hook runs after prepare validated and recorded the files: it swaps them, then allows.
    const swap = lab.hook(
      'swap',
      `import { renameSync, rmSync, symlinkSync } from 'node:fs';
const dir = ${JSON.stringify(path.join(lab.ws, 'data'))};
const target = input.tool_input.command.includes('l.txt') ? 'real.txt' : 'b.txt';
rmSync(dir + '/' + target);
symlinkSync(${JSON.stringify(secret)}, dir + '/' + target);`,
    );
    server = await claudeServer(lab, { permissions: { allow: ALLOW }, hooks: hookOn(lab, swap) });
    const direct = await bash(server, 'cat data/[ab].txt');
    expect(direct.value).toMatchObject({ ok: true, result: { error: expect.stringMatching(/^ToolError:stale:.*b\.txt changed after the command was authorized/) } });
    expect(direct.text).not.toContain('outside secret');
    expect(direct.text).not.toContain('inside a'); // nothing ran, not even the unchanged file
    // A link inside the workspace whose target is swapped: the link is the same inode, its target is not.
    const viaLink = await bash(server, 'cat data/l*');
    expect(viaLink.value).toMatchObject({ ok: true, result: { error: expect.stringMatching(/^ToolError:stale:.*l\.txt changed/) } });
    expect(viaLink.text).not.toContain('outside secret');
  });

  it('denies a glob that matches a file the Read rules deny, and no longer denies one that cannot', async () => {
    lab = makeLab({ '.env': 'API_KEY=hunter2\n', 'a.js': 'A\n', 'b.js': 'B\n' });
    server = await claudeServer(lab, { permissions: { allow: ALLOW, deny: ['Read(./.env)'] } });
    for (const command of ['cat .e*', 'head -n1 .[e]nv', 'wc -c .env*', 'cat .??v']) {
      const { text, value } = await bash(server, command);
      expect(value, command).toMatchObject({ ok: true, result: { error: expect.stringMatching(/^PermissionDenied:denied:denied by deny rule "Read\(\.\/\.env\)"/) } });
      expect(text, command).not.toContain('hunter2');
    }
    // `*.js` cannot match `.env`: before the expansion this was refused as "may match".
    const { value } = await bash(server, 'cat *.js');
    expect(value).toMatchObject({ ok: true, result: { stdout: 'A\nB\n', command: "cat -- 'a.js' 'b.js'" } });
    // ask rules refuse too (no interactive channel).
    await server.close();
    server = await claudeServer(lab, { permissions: { allow: ALLOW, ask: ['Read(./.env)'] } });
    const asked = await bash(server, 'cat .e*');
    expect(asked.value).toMatchObject({ ok: true, result: { error: expect.stringMatching(/^PermissionDenied:denied:/) } });
    expect(asked.text).not.toContain('hunter2');
  });

  it('passes names with spaces, quotes, a leading dash or a newline as single operands', async () => {
    const names = ['-n', 'a b', "it's", 'q"x', 'new\nline', '--lines=1'];
    lab = makeLab();
    mkdirSync(path.join(lab.ws, 'w'));
    for (const name of names) writeFileSync(path.join(lab.ws, 'w', name), `<${name}>\n`);
    server = await claudeServer(lab, { permissions: { allow: ALLOW } });
    // C-locale order: `--lines=1` < `-n` < `a b` < `it's` < `new\nline` < `q"x`.
    const order = ['--lines=1', '-n', 'a b', "it's", 'new\nline', 'q"x'];
    const out = await server.run(`return await bash({ command: 'cat w/*' })`);
    expect(out.ok).toBe(true);
    const result = out.result as { stdout: string; command: string };
    expect(result.stdout).toBe(order.map((n) => `<${n}>\n`).join('')); // no `-n` numbering: it was a file
    expect(result.command.startsWith("cat -- 'w/--lines=1' 'w/-n' 'w/a b' 'w/it'\\''s' 'w/new\nline' 'w/q\"x'")).toBe(true);
    const counted = await server.run(`return (await bash({ command: 'wc -l w/*' })).stdout`);
    expect(counted.result).toMatch(/ 7 total\n$/); // the file named with a newline holds its name, so two lines
  });

  it('refuses an ls glob that matches a directory with a Read-denied child, without listing it', async () => {
    lab = makeLab({ 'secret/.env': 'API_KEY=hunter2\n', 'secret/notes.txt': 'n\n', 'src/a.js': 'A\n' });
    server = await claudeServer(lab, { permissions: { allow: ALLOW, deny: ['Read(./secret/.env)'] } });
    for (const command of ['ls s*', 'ls -la se*', 'ls -1 -- */']) {
      const { text } = await bash(server, command);
      if (command.endsWith('*/')) {
        expect(text, command).not.toContain('"command"'); // trailing slash: not expanded
        continue;
      }
      expect(text, command).toMatch(/ToolError:invalid-args:.*would list .*secret\/\.env.*Read rules refuse/);
      expect(text, command).not.toContain('notes.txt');
      expect(text, command).not.toContain('hunter2');
    }
    // A directory with nothing denied lists normally; directories are never descended into.
    mkdirSync(path.join(lab.ws, 'src', 'deep'));
    writeFileSync(path.join(lab.ws, 'src', 'deep', 'x.js'), 'x\n');
    const { value } = await bash(server, 'ls sr*');
    expect(value).toMatchObject({ ok: true, result: { stdout: 'a.js\ndeep\n', command: "ls -- 'src'" } });
  });

  it('refuses a glob that matches a directory for a file reader, and a FIFO', async () => {
    lab = makeLab({ 'src/a.js': 'A\n', 'src/sub/b.js': 'B\n' });
    server = await claudeServer(lab, { permissions: { allow: ALLOW } });
    const { value } = await bash(server, 'cat src/*');
    expect(value).toMatchObject({ ok: true, result: { error: expect.stringMatching(/^ToolError:invalid-args:"src\/sub" \(matched by src\/\*\) is a directory/) } });
    // A FIFO would block the reader (or feed it from another process): refused, never opened.
    expect(spawnSync('mkfifo', [path.join(lab.ws, 'src', 'pipe.js')]).status).toBe(0);
    const fifo = await bash(server, 'cat src/p*');
    expect(fifo.value).toMatchObject({ ok: true, result: { error: expect.stringMatching(/^ToolError:invalid-args:"src\/pipe\.js" .*not a regular file/) } });
  });
});
