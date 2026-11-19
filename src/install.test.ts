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
    expect(planDiff(plan)).toContain('+++ b/');
    await applyPlan(plan);
    const settings: unknown = JSON.parse(readFileSync(path.join(project, '.claude', 'settings.json'), 'utf8'));
    expect(settings).toEqual({
      permissions: { deny: ['Bash(rm:*)'] },
      hooks: { PreToolUse: [{ matcher: 'mcp__agent-code-mode__run', hooks: [{ type: 'command', command: 'npx -y agent-code-mode hook' }] }] },
    });
    const mcp: unknown = JSON.parse(readFileSync(path.join(project, '.mcp.json'), 'utf8'));
    expect(mcp).toEqual({ mcpServers: { 'agent-code-mode': { type: 'stdio', command: 'npx', args: ['-y', 'agent-code-mode', 'serve', '--host', 'claude'] } } });
    // Idempotent: a second run changes nothing.
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
    // Already configured: --write leaves it alone.
    expect((await planInstall(opts({ host: 'codex', scope: 'user', env: { CODEX_HOME: codexHome } }))).changes).toEqual([]);
  });

  it('--local runs this checkout with the current node', async () => {
    const plan = await planInstall(opts({ host: 'codex', local: true }));
    expect(plan.text).toContain(JSON.stringify(process.execPath));
    expect(plan.text).toMatch(/cli\.js", "serve", "--host", "codex"/);
  });
});
