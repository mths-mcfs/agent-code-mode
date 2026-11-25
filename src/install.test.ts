import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codexToolTimeoutSec } from './hosts/codex/adapter.js';
import { nodeConfigIo } from './hosts/codex/config.js';
import { applyPlan, parseInstallArgs, planDiff, planInstall, type InstallOptions } from './install.js';

let base: string;
let home: string;
let project: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'acm-install-')));
  home = path.join(base, 'home');
  project = path.join(base, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

function opts(over: Partial<InstallOptions>): InstallOptions {
  return { host: 'claude', scope: 'project', write: false, local: false, cwd: project, env: {}, home, ...over };
}

describe('install', () => {
  it('parses its flags and refuses unknown ones', () => {
    expect(parseInstallArgs(['--host', 'codex', '--scope=project', '--write'], { cwd: project, env: {}, home })).toMatchObject({ host: 'codex', scope: 'project', write: true, local: false });
    expect(parseInstallArgs([], { cwd: project, env: {}, home })).toBeInstanceOf(Error);
    expect(parseInstallArgs(['--host', 'cursor'], { cwd: project, env: {}, home })).toBeInstanceOf(Error);
    expect(parseInstallArgs(['--host', 'claude', '--force'], { cwd: project, env: {}, home })).toBeInstanceOf(Error);
  });

  it('Claude project scope: prints and writes .mcp.json and the companion hook, keeping existing settings', async () => {
    mkdirSync(path.join(project, '.claude'));
    writeFileSync(path.join(project, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash(rm:*)'] } }));
    const plan = await planInstall(opts({}));
    expect(plan.text).toContain('"command": "npx"');
    expect(plan.text).toContain('npx -y agent-code-mode hook');
    expect(planDiff(plan)).toContain('+++ ');
    await applyPlan(plan);
    const settings: unknown = JSON.parse(readFileSync(path.join(project, '.claude', 'settings.json'), 'utf8'));
    expect(settings).toEqual({
      permissions: { deny: ['Bash(rm:*)'] },
      hooks: { PreToolUse: [{ matcher: 'mcp__agent-code-mode__run', hooks: [{ type: 'command', command: 'npx -y agent-code-mode hook' }] }] },
    });
    const mcp: unknown = JSON.parse(readFileSync(path.join(project, '.mcp.json'), 'utf8'));
    expect(mcp).toEqual({ mcpServers: { 'agent-code-mode': { type: 'stdio', command: 'npx', args: ['-y', 'agent-code-mode', 'serve', '--host', 'claude'] } } });
    expect((await planInstall(opts({}))).changes).toEqual([]);
  });

  it('Claude user scope: prints the claude mcp add command and only touches the user settings', async () => {
    const plan = await planInstall(opts({ scope: 'user' }));
    expect(plan.commands).toEqual(['claude mcp add --scope user agent-code-mode -- npx -y agent-code-mode serve --host claude']);
    expect(plan.changes.map((c) => c.file)).toEqual([path.join(home, '.claude', 'settings.json')]);
  });

  it('refuses to rewrite a settings file it cannot parse', async () => {
    mkdirSync(path.join(project, '.claude'));
    writeFileSync(path.join(project, '.claude', 'settings.json'), '{ not json');
    await expect(planInstall(opts({}))).rejects.toThrow(/not valid JSON/);
  });

  it('Codex: the block parses as TOML, sets the timeout and the run approval, never readOnlyHint, and is read back', async () => {
    const codexHome = path.join(base, 'codex-home');
    mkdirSync(codexHome);
    writeFileSync(path.join(codexHome, 'config.toml'), 'model = "some-model"\n');
    const plan = await planInstall(opts({ host: 'codex', scope: 'user', env: { CODEX_HOME: codexHome } }));
    expect(plan.text).not.toContain('readOnlyHint');
    await applyPlan(plan);
    const text = readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    expect(parseToml(text)).toEqual({
      model: 'some-model',
      mcp_servers: { 'agent-code-mode': { command: 'npx', args: ['-y', 'agent-code-mode', 'serve', '--host', 'codex'], tool_timeout_sec: 300, tools: { run: { approval_mode: 'approve' } } } },
    });
    const io = { ...nodeConfigIo({ CODEX_HOME: codexHome }), home, systemDir: path.join(base, 'etc'), parentArgv: () => undefined };
    expect(codexToolTimeoutSec(project, 'agent-code-mode', io)).toBe(300);
    expect((await planInstall(opts({ host: 'codex', scope: 'user', env: { CODEX_HOME: codexHome } }))).changes).toEqual([]);
  });

  describe('Codex config edited through a TOML parser', () => {
    const plan = async (text: string | null) => {
      const codexHome = path.join(base, 'codex-home');
      mkdirSync(codexHome, { recursive: true });
      if (text !== null) writeFileSync(path.join(codexHome, 'config.toml'), text);
      return planInstall(opts({ host: 'codex', scope: 'user', env: { CODEX_HOME: codexHome } }));
    };

    it.each([
      ['single-quoted key', `[mcp_servers.'agent-code-mode']\ncommand = "custom"\n`],
      ['double-quoted key', `[mcp_servers."agent-code-mode"]\ncommand = "custom"\n`],
      ['spaced dotted key', `[ mcp_servers . "agent-code-mode" ]\ncommand = "custom"\n`],
      ['inline table', `mcp_servers = { "agent-code-mode" = { command = "custom" } }\n`],
      ['dotted key at the top', `mcp_servers.agent-code-mode.command = "custom"\n`],
    ])('finds an existing table spelled with a %s and refuses instead of duplicating it', async (_name, text) => {
      const p = await plan(text);
      expect(p.changes).toEqual([]);
      expect(p.refusals).toEqual([expect.stringMatching(/already defines mcp_servers\.agent-code-mode/)]);
      await expect(applyPlan(p)).rejects.toThrow(/refusing to write/);
    });

    it('refuses when appending would redefine a table (mcp_servers given inline)', async () => {
      const p = await plan(`mcp_servers = { other = { command = "x" } }\n`);
      expect(p.changes).toEqual([]);
      expect(p.refusals).toEqual([expect.stringMatching(/would not give a valid configuration/)]);
    });

    it('refuses a config that is not valid TOML', async () => {
      const p = await plan(`model = \n`);
      expect(p.refusals).toEqual([expect.stringMatching(/is not valid TOML/)]);
    });

    it('appends after unrelated content, keeping it byte-identical, and the result parses', async () => {
      const original = `# my settings\nmodel = "m" # inline comment\n\n[mcp_servers.other]\ncommand = "x"\n`;
      const p = await plan(original);
      expect(p.refusals).toEqual([]);
      const after = p.changes[0]?.after ?? '';
      expect(after.startsWith(original)).toBe(true);
      expect(parseToml(after)).toMatchObject({ model: 'm', mcp_servers: { other: { command: 'x' }, 'agent-code-mode': { tool_timeout_sec: 300 } } });
    });

    it('reports an identical existing entry as already configured', async () => {
      const first = await plan('');
      await applyPlan(first);
      const again = await plan(null);
      expect(again.changes).toEqual([]);
      expect(again.refusals).toEqual([]);
      expect(again.text).toMatch(/already has this configuration/);
    });
  });

  it('--local runs this checkout with the current node', async () => {
    const plan = await planInstall(opts({ host: 'codex', local: true }));
    expect(plan.text).toContain(JSON.stringify(process.execPath));
    expect(plan.text).toMatch(/cli\.js", "serve", "--host", "codex"/);
  });
});
