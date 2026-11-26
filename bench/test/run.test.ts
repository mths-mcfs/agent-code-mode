import { describe, expect, it } from 'vitest';
import { claudeArgs, claudeMcpConfig } from '../lib/claude.ts';
import { catalogForArm, codexConfigToml } from '../lib/codex.ts';
import { parseOptions, planRuns } from '../run.ts';

describe('options', () => {
  it('has the documented defaults', () => {
    const o = parseOptions([]);
    expect(o).toMatchObject({ host: 'all', runs: 3, claudeModel: 'claude-sonnet-5-5', codexModel: 'gpt-6.1-terra', timeoutMin: 15, dryRun: false });
  });

  it('parses lists and rejects unknown values', () => {
    expect(parseOptions(['--arms', 'A,B', '--tasks', 'T1,T5']).tasks).toEqual(['T1', 'T5']);
    expect(() => parseOptions(['--tasks', 'T9'])).toThrow();
    expect(() => parseOptions(['--host', 'cursor'])).toThrow();
    expect(() => parseOptions(['--bogus'])).toThrow();
  });
});

describe('plan', () => {
  it('runs every host x task x arm once per round, in a seeded order', () => {
    const plan = planRuns(['claude', 'codex'], ['T1', 'T2'], undefined, 3, 42);
    expect(plan).toHaveLength(3 * (2 * 2 + 2 * 3));
    for (const round of [1, 2, 3]) expect(new Set(plan.filter((p) => p.round === round).map((p) => `${p.host}${p.task}${p.arm}`)).size).toBe(10);
    expect(planRuns(['claude', 'codex'], ['T1', 'T2'], undefined, 3, 42)).toEqual(plan);
    const order = (r: number) => plan.filter((p) => p.round === r).map((p) => `${p.host}${p.task}${p.arm}`).join();
    expect(new Set([order(1), order(2), order(3)]).size).toBeGreaterThan(1);
    expect(planRuns(['claude'], ['T1'], ['C'], 1, 1)).toEqual([]);
  });
});

describe('host commands', () => {
  it('isolates Claude and restricts the agent-code-mode arm to run', () => {
    const a = claudeArgs({ arm: 'A', model: 'm', effort: 'low', maxTurns: 5, settingsFile: 's.json', mcpConfigFile: 'm.json' });
    expect(a).toEqual(expect.arrayContaining(['--setting-sources', 'project', '--strict-mcp-config', '--no-session-persistence']));
    const b = claudeArgs({ arm: 'B', model: 'm', effort: 'low', maxTurns: 5, settingsFile: 's.json', mcpConfigFile: 'm.json' });
    expect(b).not.toContain('--disallowedTools');
    expect(b.slice(b.indexOf('--tools'))).toEqual(['--tools', '', '--allowedTools', 'mcp__agent-code-mode__run,Bash,Read,Write,Edit,Glob,Grep']);
    expect(a.slice(a.indexOf('--tools'))).toEqual(['--tools', 'Bash,Read,Write,Edit,Glob,Grep', '--allowedTools', 'Bash,Read,Write,Edit,Glob,Grep']);
    expect(claudeMcpConfig('A', 'x')).toEqual({ mcpServers: {} });
  });

  it('writes the Codex config each arm needs', () => {
    const base = { model: 'gpt-6.1-terra', effort: 'medium', codexHome: '/h', catalogFile: '/h/c.json', serverEntry: '/r/dist/cli.js', nodePath: '/usr/bin/node', emptyServerEntry: '/r/bench/lib/empty-mcp-server.mjs' };
    const c = codexConfigToml({ ...base, arm: 'C' });
    expect(c).toContain('shell_tool = false');
    for (const arm of ['A', 'B', 'C'] as const) {
      const toml = codexConfigToml({ ...base, arm });
      for (const f of ['apps', 'view_image', 'image_generation', 'goals', 'multi_agent', 'sleep_tool']) expect(toml).toContain(`\n${f} = false`);
      expect(toml).toContain('[agents]\nenabled = false');
      expect(toml).toContain('web_search = "disabled"');
      const features = toml.slice(toml.indexOf('[features]'), toml.indexOf('\n[', toml.indexOf('[features]') + 1));
      if (arm === 'C') expect(features).toContain('shell_tool = false');
      if (arm === 'B') expect(features).toContain('code_mode = true');
      expect(toml.includes('[mcp_servers.bench-empty]')).toBe(arm !== 'C');
    }
    expect(c).toContain('[mcp_servers.agent-code-mode]');
    expect(c).toContain('[mcp_servers.agent-code-mode.tools.run]\napproval_mode = "approve"');
    expect(codexConfigToml({ ...base, arm: 'B', catalogFile: null })).not.toContain('model_catalog_json');
    const raw = JSON.stringify({ models: [{ slug: 'gpt-6.1-terra', tool_mode: 'code_mode_only', apply_patch_tool_type: 'freeform' }] });
    expect(JSON.parse(catalogForArm('B', raw)).models[0]).toMatchObject({ tool_mode: 'code_mode_only', experimental_supported_tools: [], supports_search_tool: false });
    expect(JSON.parse(catalogForArm('A', raw) ?? '').models[0]).toMatchObject({ tool_mode: 'direct', apply_patch_tool_type: 'freeform' });
    expect(JSON.parse(catalogForArm('C', raw) ?? '').models[0]).toMatchObject({ tool_mode: 'direct', apply_patch_tool_type: null, supports_search_tool: false });
    expect(JSON.parse(catalogForArm('A', raw)).models[0]).toMatchObject({ supports_search_tool: false, experimental_supported_tools: [] });
  });
});
