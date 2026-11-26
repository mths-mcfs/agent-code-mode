import { mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callAt, claudeServer, codexServer, makeLab, posix, snapshot, type Lab, type Server } from './harness.js';

const ESCAPES: readonly { readonly name: string; readonly code: string; readonly posixOnly?: boolean }[] = [
  { name: 'read ../', code: `await read({ path: '../outside/secret.txt' })` },
  { name: 'read absolute outside', code: `await read({ path: OUTSIDE + '/secret.txt' })` },
  { name: 'read via ~', code: `await read({ path: '~/.ssh/id_rsa' })` },
  { name: 'write ../', code: `await write({ path: '../outside/new.txt', content: 'x' })` },
  { name: 'write absolute outside', code: `await write({ path: OUTSIDE + '/new.txt', content: 'x' })` },
  { name: 'write with .. after a missing dir', code: `await write({ path: 'nope/../../outside/new.txt', content: 'x' })` },
  { name: 'edit outside', code: `await edit({ path: '../outside/secret.txt', oldString: 'outside', newString: 'pwned' })` },
  { name: 'grep path ..', code: `await grep({ pattern: 'secret', path: '..' })` },
  { name: 'glob path outside', code: `await glob({ pattern: '*', path: OUTSIDE })` },
  { name: 'read through a symlink to outside', code: `await read({ path: 'link-out/secret.txt' })`, posixOnly: true },
  { name: 'write through a symlinked dir to outside', code: `await write({ path: 'link-out/new.txt', content: 'x' })`, posixOnly: true },
  { name: 'write to a symlinked file', code: `await write({ path: 'file-link', content: 'x' })`, posixOnly: true },
  { name: 'edit through a symlink to outside', code: `await edit({ path: 'link-out/secret.txt', oldString: 'outside', newString: 'pwned' })`, posixOnly: true },
  { name: 'grep through a symlinked dir', code: `await grep({ pattern: 'secret', path: 'link-out' })`, posixOnly: true },
  { name: 'glob through a symlinked dir', code: `await glob({ pattern: '**/*', path: 'link-out' })`, posixOnly: true },
];

const PROTECTED: readonly { readonly name: string; readonly code: string }[] = [
  { name: '.claude/settings.json', code: `await write({ path: '.claude/settings.json', content: '{"permissions":{"allow":["Bash"]}}' })` },
  { name: '.claude/settings.local.json', code: `await write({ path: '.claude/settings.local.json', content: '{}' })` },
  { name: '.claude/hooks/x.sh', code: `await write({ path: '.claude/hooks/x.sh', content: 'exit 0' })` },
  { name: '.mcp.json', code: `await write({ path: '.mcp.json', content: '{}' })` },
  { name: 'edit settings', code: `await edit({ path: '.claude/settings.json', oldString: 'bypassPermissions', newString: 'default' })` },
];

function script(lab: Lab, body: string): string {
  return `const OUTSIDE = ${JSON.stringify(lab.outside)}; const HOME = ${JSON.stringify(lab.home)};\ntry { ${body}; return 'NOT REFUSED'; } catch (e) { return e.name + ':' + e.code; }`;
}

describe('path traversal, symlink escapes and protected files (Claude adapter)', () => {
  let lab: Lab;
  let server: Server;

  beforeAll(async () => {
    lab = makeLab({ 'a.txt': 'hello\n' });
    if (posix) {
      symlinkSync(lab.outside, path.join(lab.ws, 'link-out'));
      symlinkSync(path.join(lab.ws, 'a.txt'), path.join(lab.ws, 'file-link'));
    }
    server = await claudeServer(lab, {});
  });
  afterAll(async () => {
    await server.close();
    lab.cleanup();
  });

  for (const c of ESCAPES) {
    it.runIf(posix || !c.posixOnly)(`refuses ${c.name}`, async () => {
      const before = snapshot(lab.base);
      const out = await server.run(script(lab, c.code));
      expect(out.ok).toBe(true);
      expect(out.result).not.toBe('NOT REFUSED');
      expect(String(out.result)).toMatch(/^(ToolError|PermissionDenied):/);
      expect(callAt(out, 1)?.decision).not.toBe('allowed');
      expect(snapshot(lab.base)).toEqual(before);
    });
  }

  for (const c of PROTECTED) {
    it(`refuses to write ${c.name}`, async () => {
      const before = snapshot(lab.base);
      const out = await server.run(script(lab, c.code));
      expect(out.result).toBe('ToolError:protected-path');
      expect(snapshot(lab.base)).toEqual(before);
    });
  }

  it('refuses to write the home Claude config (outside the workspace and protected)', async () => {
    const before = snapshot(lab.base);
    const out = await server.run(script(lab, `await write({ path: HOME + '/.claude/settings.json', content: '{}' })`));
    expect(out.result).toMatch(/^ToolError:(outside-workspace|protected-path)$/);
    expect(snapshot(lab.base)).toEqual(before);
  });

  it('still allows a plain write inside the workspace (control)', async () => {
    const out = await server.run(`return (await write({ path: 'ok.txt', content: 'fine' })).created`);
    expect(out.result).toBe(true);
  });
});

describe('protected Codex config files (Codex adapter)', () => {
  let lab: Lab;
  let server: Server;
  beforeAll(async () => {
    lab = makeLab({ '.codex/config.toml': 'model = "x"\n' });
    server = await codexServer(lab);
  });
  afterAll(async () => {
    await server.close();
    lab.cleanup();
  });

  it.each([
    ['.codex/config.toml', `await write({ path: '.codex/config.toml', content: 'approval_policy = "never"' })`],
    ['.codex/rules', `await write({ path: '.codex/rules/allow.rules', content: 'prefix_rule(pattern=["rm"], decision="allow")' })`],
    ['.mcp.json', `await write({ path: '.mcp.json', content: '{}' })`],
  ])('refuses %s', async (_name, code) => {
    const before = snapshot(lab.base);
    const out = await server.run(script(lab, code));
    expect(out.result).toBe('ToolError:protected-path');
    expect(snapshot(lab.base)).toEqual(before);
  });
});

describe('grep and glob never return a file the Read rules deny', () => {
  let lab: Lab;
  let server: Server;
  beforeAll(async () => {
    lab = makeLab({ '.env': 'API_KEY=supersecret\n', 'config/prod.key': 'API_KEY=prodsecret\n', 'src/app.ts': 'const API_KEY = process.env.API_KEY;\n' });
    server = await claudeServer(lab, { permissions: { deny: ['Read(./.env)', 'Read(./config/**)'] } });
  });
  afterAll(async () => {
    await server.close();
    lab.cleanup();
  });

  it('grep over the root skips the denied files and counts them', async () => {
    const out = await server.run(`return await grep({ pattern: 'API_KEY' })`);
    expect(out.ok).toBe(true);
    const text = JSON.stringify(out.result);
    expect(text).not.toContain('secret');
    expect(out.result).toMatchObject({ matches: [{ file: path.join(lab.ws, 'src', 'app.ts') }], filtered: 2 });
  });

  it('glob over the root drops the denied entries', async () => {
    const out = await server.run(`return await glob({ pattern: '**/*' })`);
    expect(out.result).toMatchObject({ filtered: 2 });
    expect(JSON.stringify(out.result)).not.toMatch(/\.env|prod\.key/);
  });

  it('a direct read of the denied file is denied by the rule', async () => {
    const out = await server.run(script(lab, `await read({ path: '.env' })`));
    expect(out.result).toBe('PermissionDenied:denied');
    expect(callAt(out, 1)?.reason).toMatch(/^rule:/);
  });
});

describe('Codex writable roots reach the tools jail', () => {
  let lab: Lab;
  let server: Server;
  let extra: string;
  beforeAll(async () => {
    lab = makeLab();
    extra = path.join(lab.base, 'extra');
    mkdirSync(extra);
    server = await codexServer(lab, {
      sandboxMode: 'workspace-write',
      extraToml: `[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(extra)}]\n`,
    });
  });
  afterAll(async () => {
    await server.close();
    lab.cleanup();
  });

  it('writes into a configured writable root, and still refuses a directory outside every root', async () => {
    const ok = await server.run(`return (await write({ path: ${JSON.stringify(path.join(extra, 'x.txt'))}, content: 'allowed\\n' })).created`);
    expect(ok.result).toBe(true);
    expect(readFileSync(path.join(extra, 'x.txt'), 'utf8')).toBe('allowed\n');
    const before = snapshot(lab.outside);
    const out = await server.run(script(lab, `await write({ path: OUTSIDE + '/new.txt', content: 'x\\n' })`));
    expect(out.result).toBe('ToolError:outside-workspace');
    expect(snapshot(lab.outside)).toEqual(before);
  });
});
