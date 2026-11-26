import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeArgs, claudeMcpConfig } from '../lib/claude.ts';
import { catalogForArm, codexConfigToml } from '../lib/codex.ts';
import { npmCommand, parseOptions, planRuns, planWarmup, WARMUP_TASK, type PlannedRun } from '../run.ts';
import { Rng } from '../lib/rng.ts';
import { TASK_IDS, type TaskId } from '../tasks/types.ts';

describe('options', () => {
  it('has the documented defaults', () => {
    const o = parseOptions([]);
    expect(o).toMatchObject({ host: 'all', runs: 3, claudeModel: 'claude-sonnet-5-5', codexModel: 'gpt-6.1-terra', timeoutMin: 15, dryRun: false });
  });

  it('parses lists and rejects unknown values', () => {
    expect(parseOptions(['--arms', 'A,B', '--tasks', 'T1,T5']).tasks).toEqual(['T1', 'T5']);
    expect(() => parseOptions(['--tasks', 'T99'])).toThrow();
    expect(parseOptions(['--arms', 'A,B0']).arms).toEqual(['A', 'B0']);
    expect(() => parseOptions(['--acm-ref', 'HEAD', '--acm-dist', 'x'])).toThrow();
    expect(() => parseOptions(['--host', 'cursor'])).toThrow();
    expect(() => parseOptions(['--bogus'])).toThrow();
  });
});

/** Splits a plan into its maximal runs of consecutive entries with the same round, host and task. */
function blocks(plan: readonly PlannedRun[]): PlannedRun[][] {
  const out: PlannedRun[][] = [];
  for (const p of plan) {
    const last = out.at(-1);
    const head = last?.[0];
    if (last !== undefined && head !== undefined && head.round === p.round && head.host === p.host && head.task === p.task) last.push(p);
    else out.push([p]);
  }
  return out;
}

describe('paired schedule', () => {
  const cases: { hosts: ('claude' | 'codex')[]; tasks: TaskId[]; runs: number; seed: number; baseline: boolean }[] = [];
  const rng = new Rng(99);
  for (let i = 0; i < 60; i++) {
    const hosts = rng.pick([['claude'], ['codex'], ['claude', 'codex']] as ('claude' | 'codex')[][]);
    const tasks = rng.shuffle(TASK_IDS).slice(0, rng.int(1, 6));
    cases.push({ hosts, tasks, runs: rng.int(1, 9), seed: rng.int(0, 2 ** 31), baseline: rng.next() < 0.5 });
  }

  it('keeps every arm of a host x task together in each round, each arm exactly once', () => {
    for (const c of cases) {
      const plan = planRuns(c.hosts, c.tasks, undefined, c.runs, c.seed, c.baseline);
      const bs = blocks(plan);
      // One block per round x host x task: the arms of a task never get split by another task's run.
      expect(bs).toHaveLength(c.runs * c.hosts.length * c.tasks.length);
      for (const b of bs) {
        const host = b[0]?.host ?? 'claude';
        const expected = host === 'claude' ? (c.baseline ? ['A', 'B', 'B0', 'C', 'D'] : ['A', 'B', 'C', 'D']) : c.baseline ? ['A', 'B', 'C', 'C0'] : ['A', 'B', 'C'];
        expect(b.map((p) => p.arm).sort()).toEqual(expected);
        expect(b.map((p) => p.position)).toEqual(expected.map((_a, i) => i));
      }
      expect(plan.map((p) => p.orderIndex)).toEqual(plan.map((_p, i) => i));
      expect(plan.every((p) => p.run === p.round)).toBe(true);
    }
  });

  it('balances the order: each arm takes each position equally often, within one, over the rounds', () => {
    for (const c of cases) {
      const plan = planRuns(c.hosts, c.tasks, undefined, c.runs, c.seed, c.baseline);
      const counts = new Map<string, number[]>();
      for (const p of plan) {
        const key = `${p.host}|${p.task}|${p.arm}`;
        const k = plan.filter((q) => q.host === p.host && q.task === p.task && q.round === p.round).length;
        const row = counts.get(key) ?? Array.from({ length: k }, () => 0);
        row[p.position] = (row[p.position] ?? 0) + 1;
        counts.set(key, row);
      }
      for (const row of counts.values()) {
        expect(Math.max(...row) - Math.min(...row)).toBeLessThanOrEqual(1);
        if (c.runs % row.length === 0) expect(new Set(row).size).toBe(1);
      }
      // Two arms: the order alternates between rounds.
      if (c.hosts.includes('claude') && !c.baseline && c.runs >= 2) {
        const first = (r: number) => plan.find((p) => p.host === 'claude' && p.task === c.tasks[0] && p.round === r && p.position === 0)?.arm;
        expect(first(1)).not.toBe(first(2));
      }
    }
  });

  it('is fixed by the seed, and the seed changes it', () => {
    const a = planRuns(['claude', 'codex'], ['T1', 'T2', 'T3'], undefined, 4, 42);
    expect(planRuns(['claude', 'codex'], ['T1', 'T2', 'T3'], undefined, 4, 42)).toEqual(a);
    const orders = new Set([1, 2, 3, 4, 5, 6].map((seed) => planRuns(['claude', 'codex'], ['T1', 'T2', 'T3'], undefined, 4, seed).map((p) => `${p.host}${p.task}${p.arm}`).join()));
    expect(orders.size).toBeGreaterThan(1);
    // Claude C is the hybrid arm; the baseline arm C0 is Codex only, B0 Claude only.
    expect(planRuns(['claude'], ['T1'], ['C'], 1, 1).map((p) => `${p.host}${p.arm}`)).toEqual(['claudeC']);
    expect(planRuns(['claude'], ['T1'], ['C0'], 1, 1, true)).toEqual([]);
    expect(planRuns(['codex'], ['T1'], ['B0'], 1, 1, true)).toEqual([]);
    expect(planRuns(['claude'], ['T1'], ['A', 'B0'], 2, 1, true).map((p) => p.arm).sort()).toEqual(['A', 'A', 'B0', 'B0']);
  });

  it('warms every host x arm of the plan once, on the warmup task', () => {
    const plan = planRuns(['claude', 'codex'], ['T5', 'T9'], undefined, 3, 7, true);
    const warm = planWarmup(plan, 7);
    expect(warm.map((p) => `${p.host}${p.arm}`).sort()).toEqual(['claudeA', 'claudeB', 'claudeB0', 'claudeC', 'claudeD', 'codexA', 'codexB', 'codexC', 'codexC0']);
    expect(warm.every((p) => p.task === WARMUP_TASK && p.warmup === true)).toBe(true);
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
    expect(claudeMcpConfig('B', 'x')).toMatchObject({ mcpServers: { 'agent-code-mode': { args: ['x', 'serve', '--host', 'claude'] } } });
    // Arm C (hybrid): the native tools of A plus run, and the server started with --hybrid.
    const c = claudeArgs({ arm: 'C', model: 'm', effort: 'low', maxTurns: 5, settingsFile: 's.json', mcpConfigFile: 'm.json' });
    expect(c.slice(c.indexOf('--tools'))).toEqual(['--tools', 'Bash,Read,Write,Edit,Glob,Grep', '--allowedTools', 'mcp__agent-code-mode__run,Bash,Read,Write,Edit,Glob,Grep']);
    expect(c.slice(0, c.indexOf('--tools'))).toEqual(a.slice(0, a.indexOf('--tools')));
    expect(claudeMcpConfig('C', 'x')).toMatchObject({ mcpServers: { 'agent-code-mode': { args: ['x', 'serve', '--host', 'claude', '--hybrid'] } } });
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

describe('npm without a shell', () => {
  it('runs npm-cli.js with this Node (npm is a .cmd shim on Windows), from npm_execpath or next to node', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'acm-npm-'));
    try {
      const win = path.join(tmp, 'win');
      const cli = path.join(win, 'node_modules', 'npm', 'bin', 'npm-cli.js');
      await mkdir(path.dirname(cli), { recursive: true });
      await writeFile(cli, '');
      const node = path.join(win, 'node.exe');
      expect(npmCommand({}, node)).toEqual({ command: node, args: [cli] });
      const posix = path.join(tmp, 'prefix');
      const cli2 = path.join(posix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
      await mkdir(path.dirname(cli2), { recursive: true });
      await writeFile(cli2, '');
      expect(npmCommand({}, path.join(posix, 'bin', 'node'))).toEqual({ command: path.join(posix, 'bin', 'node'), args: [path.join(posix, 'bin', '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')] });
      expect(npmCommand({ npm_execpath: cli2 }, node)).toEqual({ command: node, args: [cli2] });
      expect(npmCommand({ npm_execpath: path.join(tmp, 'pnpm.cjs') }, path.join(tmp, 'none', 'node'))).toEqual({ command: 'npm', args: [] });
      // On this machine it resolves to a real npm-cli.js.
      expect(npmCommand().args[0] ?? '').toMatch(/npm-cli\.js$/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
