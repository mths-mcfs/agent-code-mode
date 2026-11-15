import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeArgs, claudeMcpConfig } from '../lib/claude.ts';
import { catalogForArm, codexConfigToml } from '../lib/codex.ts';
import { main, parseOptions, planRuns } from '../run.ts';

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
    expect(b.slice(b.indexOf('--allowedTools'))).toEqual(['--allowedTools', 'mcp__agent-code-mode__run', '--disallowedTools', 'Bash,Read,Write,Edit,Glob,Grep,NotebookEdit']);
    expect(claudeMcpConfig('A', 'x')).toEqual({ mcpServers: {} });
  });

  it('writes the Codex config each arm needs', () => {
    const base = { model: 'gpt-6.1-terra', effort: 'medium', codexHome: '/h', catalogFile: '/h/c.json', serverEntry: '/r/dist/cli.js', nodePath: '/usr/bin/node' };
    const c = codexConfigToml({ ...base, arm: 'C' });
    expect(c).toContain('shell_tool = false');
    expect(c).toContain('[mcp_servers.agent-code-mode]');
    expect(c).toContain('default_tools_approval_mode = "approve"');
    expect(codexConfigToml({ ...base, arm: 'B', catalogFile: null })).not.toContain('model_catalog_json');
    const raw = JSON.stringify({ models: [{ slug: 'gpt-6.1-terra', tool_mode: 'code_mode_only', apply_patch_tool_type: 'freeform' }] });
    expect(catalogForArm('B', raw)).toBeNull();
    expect(JSON.parse(catalogForArm('A', raw) ?? '').models[0]).toMatchObject({ tool_mode: 'direct', apply_patch_tool_type: 'freeform' });
    expect(JSON.parse(catalogForArm('C', raw) ?? '').models[0]).toMatchObject({ tool_mode: 'direct', apply_patch_tool_type: null });
  });
});

describe('dry run', () => {
  it('runs end to end, writes a summary and resumes without redoing runs', async () => {
    const work = await mkdtemp(path.join(os.tmpdir(), 'acm-dry-'));
    const out = path.join(work, 'results');
    const args = ['--dry-run', '--tasks', 'T1,T8', '--runs', '1', '--seed', '3', '--work-dir', work, '--out', out, '--date', '2026-01-02'];
    const writes: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(await main(args)).toBe(0);
      expect(await main(args)).toBe(0);
    } finally {
      process.stdout.write = orig;
    }
    const text = writes.join('');
    expect(text.match(/: pass, valid/g)).toHaveLength(10);
    expect(text.match(/^skip /gm)).toHaveLength(10);
    const summary = JSON.parse(await readFile(path.join(out, '2026-01-02', 'summary.json'), 'utf8'));
    expect(summary.dryRun).toBe(true);
    expect(summary.groups).toHaveLength(10);
    // No copy of an auth file may survive a run.
    const left = (await readdir(path.join(work, 'runs'), { recursive: true })).filter((f) => f.endsWith('auth.json'));
    expect(left).toEqual([]);
    await rm(work, { recursive: true, force: true });
  }, 120_000);
});
