import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeArgs, claudeMcpConfig } from '../lib/claude.ts';
import { catalogForArm, codexConfigToml } from '../lib/codex.ts';
import { assertWorkspaceIsolated, defaultWorkDir, insideRepo, main, parseOptions, planRuns, planWarmup, REPO_ROOT, resolveBaseline, WARMUP_TASK, type PlannedRun } from '../run.ts';
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
        const expected = host === 'claude' ? (c.baseline ? ['A', 'B', 'B0'] : ['A', 'B']) : c.baseline ? ['A', 'B', 'C', 'C0'] : ['A', 'B', 'C'];
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
    expect(planRuns(['claude'], ['T1'], ['C'], 1, 1)).toEqual([]);
    expect(planRuns(['claude'], ['T1'], ['A', 'B0'], 2, 1, true).map((p) => p.arm).sort()).toEqual(['A', 'A', 'B0', 'B0']);
  });

  it('warms every host x arm of the plan once, on the warmup task', () => {
    const plan = planRuns(['claude', 'codex'], ['T5', 'T9'], undefined, 3, 7, true);
    const warm = planWarmup(plan, 7);
    expect(warm.map((p) => `${p.host}${p.arm}`).sort()).toEqual(['claudeA', 'claudeB', 'claudeB0', 'codexA', 'codexB', 'codexC', 'codexC0']);
    expect(warm.every((p) => p.task === WARMUP_TASK && p.warmup === true)).toBe(true);
  });
});

describe('host commands', () => {
  it('isolates Claude and restricts the agent-code-mode arm to run', () => {
    const a = claudeArgs({ arm: 'A', model: 'm', effort: 'low', maxTurns: 5, settingsFile: 's.json', mcpConfigFile: 'm.json' });
    expect(a).toEqual(expect.arrayContaining(['--setting-sources', 'project', '--strict-mcp-config', '--no-session-persistence']));
    const b = claudeArgs({ arm: 'B', model: 'm', effort: 'low', maxTurns: 5, settingsFile: 's.json', mcpConfigFile: 'm.json' });
    // Native tools removed with --tools "" (not denied: a CLI deny would also deny them inside run).
    expect(b).not.toContain('--disallowedTools');
    expect(b.slice(b.indexOf('--tools'))).toEqual(['--tools', '', '--allowedTools', 'mcp__agent-code-mode__run,Bash,Read,Write,Edit,Glob,Grep']);
    // Arm A: exactly the native file/shell tools, nothing else built in.
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
      // Feature keys sit in [features], not in a later table.
      const features = toml.slice(toml.indexOf('[features]'), toml.indexOf('\n[', toml.indexOf('[features]') + 1));
      if (arm === 'C') expect(features).toContain('shell_tool = false');
      if (arm === 'B') expect(features).toContain('code_mode = true');
      expect(toml.includes('[mcp_servers.bench-empty]')).toBe(arm !== 'C');
    }
    expect(c).toContain('[mcp_servers.agent-code-mode]');
    expect(c).toContain('default_tools_approval_mode = "approve"');
    expect(codexConfigToml({ ...base, arm: 'B', catalogFile: null })).not.toContain('model_catalog_json');
    const raw = JSON.stringify({ models: [{ slug: 'gpt-6.1-terra', tool_mode: 'code_mode_only', apply_patch_tool_type: 'freeform' }] });
    expect(JSON.parse(catalogForArm('B', raw)).models[0]).toMatchObject({ tool_mode: 'code_mode_only', experimental_supported_tools: [], supports_search_tool: false });
    expect(JSON.parse(catalogForArm('A', raw) ?? '').models[0]).toMatchObject({ tool_mode: 'direct', apply_patch_tool_type: 'freeform' });
    expect(JSON.parse(catalogForArm('C', raw) ?? '').models[0]).toMatchObject({ tool_mode: 'direct', apply_patch_tool_type: null, supports_search_tool: false });
    expect(JSON.parse(catalogForArm('A', raw)).models[0]).toMatchObject({ supports_search_tool: false, experimental_supported_tools: [] });
  });
});

async function quiet<T>(fn: () => Promise<T>): Promise<{ value: T; text: string }> {
  const writes: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    return { value: await fn(), text: writes.join('') };
  } finally {
    process.stdout.write = orig;
  }
}

describe('resume', () => {
  it('reruns instead of skipping when the config changed, and keeps both apart in the report', async () => {
    const work = await mkdtemp(path.join(os.tmpdir(), 'acm-resume-'));
    const out = path.join(work, 'results');
    const base = ['--dry-run', '--host', 'claude', '--arms', 'A', '--tasks', 'T1', '--runs', '1', '--work-dir', work, '--out', out, '--date', '2026-01-03'];
    try {
      const first = await quiet(() => main([...base, '--seed', '1']));
      expect(first.text).toMatch(/claude T1 A r1: pass, valid/);
      // Same config without --seed: the seed of the last invocation is reused, so the run is skipped.
      expect((await quiet(() => main(base))).text).toMatch(/^skip claude-T1-A-r1/m);
      for (const change of [['--claude-model', 'claude-haiku-5-5'], ['--seed', '2'], ['--claude-effort', 'high'], ['--fixture-seed', '999']]) {
        const args = change[0] === '--seed' ? [...base, ...change] : [...base, '--seed', '1', ...change];
        const r = await quiet(() => main(args));
        expect(r.text, change.join(' ')).not.toMatch(/^skip /m);
        expect(r.text).toMatch(/claude T1 A r1: pass, valid/);
      }
      const summary = JSON.parse(await readFile(path.join(out, '2026-01-03', 'summary.json'), 'utf8'));
      const hashes = summary.groups.map((g: { configHash: string }) => g.configHash);
      expect(new Set(hashes).size).toBe(5);
      expect(summary.groups.every((g: { runs: number }) => g.runs === 1)).toBe(true);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }, 120_000);
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
    expect(text.match(/^(claude|codex) T\d+ \w+ r1: pass, valid/gm)).toHaveLength(10);
    // One warmup per host x arm before the matrix; none on the resume, which has nothing left to run.
    expect(text.match(/^warmup (claude|codex) T1 \w+ r1: pass, valid/gm)).toHaveLength(5);
    expect(text.match(/^skip /gm)).toHaveLength(10);
    const summary = JSON.parse(await readFile(path.join(out, '2026-01-02', 'summary.json'), 'utf8'));
    expect(summary.dryRun).toBe(true);
    expect(summary.groups).toHaveLength(10);
    expect(summary.warmup.runs).toBe(5);
    expect(text).toMatch(/Warmup: 5 run\(s\)/);
    // No copy of an auth file may survive a run.
    const left = (await readdir(path.join(work, 'runs'), { recursive: true })).filter((f) => f.endsWith('auth.json'));
    expect(left).toEqual([]);
    await rm(work, { recursive: true, force: true });
  }, 120_000);
});

describe('baseline build arm', () => {
  it('runs B0 next to B in the same matrix and compares them', async () => {
    const work = await mkdtemp(path.join(os.tmpdir(), 'acm-base-'));
    const out = path.join(work, 'results');
    const dist = path.join(work, 'old-dist');
    await mkdir(dist, { recursive: true });
    await writeFile(path.join(dist, 'cli.js'), '// a stand-in build\n');
    const args = ['--dry-run', '--host', 'claude', '--tasks', 'T1,T2,T3', '--runs', '2', '--seed', '5', '--work-dir', work, '--out', out, '--date', '2026-01-04'];
    try {
      expect((await quiet(() => main([...args, '--arms', 'B0']))).value).toBe(2);
      const r = await quiet(() => main([...args, '--acm-dist', dist]));
      expect(r.value).toBe(0);
      expect(r.text.match(/^claude T\d B0 r\d: pass, valid/gm)).toHaveLength(6);
      const summary = JSON.parse(await readFile(path.join(out, '2026-01-04', 'summary.json'), 'utf8'));
      const builds = new Set(summary.groups.filter((g: { arm: string }) => g.arm !== 'A').map((g: { arm: string; config: { acmBuild: string } }) => `${g.arm}:${g.config.acmBuild}`));
      expect([...builds].sort()).toEqual(expect.arrayContaining(['B:checkout', expect.stringMatching(/^B0:dist:[0-9a-f]{12}$/)]));
      expect(summary.comparisons.map((c: { arm: string; reference: string }) => `${c.arm}-${c.reference}`).sort()).toEqual(['B-A', 'B-B0', 'B0-A']);
      // Canned transcripts: B and B0 are identical, so the cost difference is exactly 0 and the interval says so.
      const bb0 = summary.comparisons.find((c: { arm: string; reference: string }) => c.arm === 'B' && c.reference === 'B0');
      expect(bb0.costUsd).toMatchObject({ estimate: 0, lo: 0, hi: 0, crossesZero: true, tasks: 3 });
      expect(r.text).toMatch(/\| B vs B0 \| 3 \|.*CI crosses 0/);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }, 120_000);

  it('resolves --acm-ref to a commit of this repository', async () => {
    const work = await mkdtemp(path.join(os.tmpdir(), 'acm-ref-'));
    try {
      const r = await quiet(() => main(['--dry-run', '--host', 'claude', '--arms', 'B0', '--tasks', 'T1', '--runs', '1', '--seed', '1', '--work-dir', work, '--out', path.join(work, 'r'), '--date', '2026-01-05', '--acm-ref', 'HEAD']));
      expect(r.value).toBe(0);
      const env = JSON.parse(await readFile(path.join(work, 'r', '2026-01-05', 'env.json'), 'utf8'));
      expect(env.invocations[0].baseline.id).toMatch(/^ref:[0-9a-f]{12}$/);
      expect((await quiet(() => main(['--dry-run', '--host', 'claude', '--tasks', 'T1', '--runs', '1', '--work-dir', work, '--acm-ref', 'no-such-ref-xyz']))).value).toBe(2);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }, 120_000);
});

/** Every directory from `dir` up to the filesystem root. */
function ancestors(dir: string): string[] {
  const out = [dir];
  while (path.dirname(out.at(-1) as string) !== out.at(-1)) out.push(path.dirname(out.at(-1) as string));
  return out;
}

describe('workspace isolation from the checkout', () => {
  it('defaults the work dir to outside the repository', () => {
    expect(insideRepo(defaultWorkDir())).toBe(false);
    expect(parseOptions([]).workDir).toBe(defaultWorkDir());
    expect(insideRepo(path.join(REPO_ROOT, 'bench', '.work'))).toBe(true);
    expect(insideRepo(REPO_ROOT)).toBe(true);
  });

  it('refuses a --work-dir inside the checkout, also through a symlink', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'acm-link-'));
    try {
      await symlink(path.join(REPO_ROOT, 'bench'), path.join(tmp, 'bench-link'));
      for (const dir of [path.join(REPO_ROOT, 'bench', '.work'), REPO_ROOT, path.join(tmp, 'bench-link', 'work')]) {
        const errs: string[] = [];
        const orig = process.stderr.write.bind(process.stderr);
        process.stderr.write = ((c: string | Uint8Array) => (errs.push(String(c)), true)) as typeof process.stderr.write;
        try {
          expect(await main(['--dry-run', '--tasks', 'T1', '--runs', '1', '--work-dir', dir])).toBe(2);
        } finally {
          process.stderr.write = orig;
        }
        expect(errs.join('')).toMatch(/--work-dir .* is inside the repository checkout/);
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('rejects a workspace with bench/tasks in any directory above it', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'acm-anc-'));
    try {
      await mkdir(path.join(tmp, 'bench', 'tasks'), { recursive: true });
      expect(() => assertWorkspaceIsolated(path.join(tmp, 'a', 'b', 'ws'))).toThrow(/bench\/tasks above it/);
      expect(() => assertWorkspaceIsolated(path.join(REPO_ROOT, 'x', 'ws'))).toThrow(/inside the repository checkout/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('no run workspace has an ancestor holding bench/tasks, and both hosts are pointed only at it', async () => {
    const work = await mkdtemp(path.join(os.tmpdir(), 'acm-iso-ws-'));
    const out = path.join(work, 'results');
    try {
      expect((await quiet(() => main(['--dry-run', '--tasks', 'T9,T10', '--runs', '1', '--seed', '2', '--work-dir', work, '--out', out, '--date', '2026-01-06']))).value).toBe(0);
      const wss = (await readdir(path.join(work, 'runs'), { recursive: true })).filter((f) => path.basename(f) === 'ws').map((f) => path.join(work, 'runs', f));
      expect(wss.length).toBe(2 * 2 + 2 * 3 + 5); // matrix + warmups
      for (const ws of wss) {
        expect(insideRepo(ws)).toBe(false);
        for (const dir of ancestors(ws)) expect(existsSync(path.join(dir, 'bench', 'tasks')), dir).toBe(false);
      }
      // Codex is given the workspace and nothing else (`-C <workspace>`); arm C's MCP server inherits that cwd.
      const commands = (await readdir(out, { recursive: true })).filter((f) => path.basename(f) === 'command.txt');
      for (const f of commands.filter((c) => c.includes('codex'))) expect(await readFile(path.join(out, f), 'utf8')).toMatch(/ -C <workspace> /);
      // Claude is started in the workspace: its init cwd, which is also the MCP root of arm B, is the workspace.
      for (const f of commands.filter((c) => c.includes('claude'))) expect(await readFile(path.join(out, f), 'utf8')).not.toContain('--add-dir');
      const records = (await readdir(out, { recursive: true })).filter((f) => path.basename(f) === 'record.json');
      for (const f of records) expect(await readFile(path.join(out, f), 'utf8')).not.toContain('<repo>/bench/tasks');
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }, 120_000);

  it('the --acm-ref build has no bench/ or test/ next to the run workspaces', async () => {
    const work = await mkdtemp(path.join(os.tmpdir(), 'acm-build-'));
    try {
      const build = await resolveBaseline({ acmRef: 'HEAD', acmDist: undefined, dryRun: false }, work);
      const dir = path.dirname(path.dirname(build?.entry ?? ''));
      expect(existsSync(build?.entry ?? '')).toBe(true);
      expect(existsSync(path.join(dir, 'bench'))).toBe(false);
      expect(existsSync(path.join(dir, 'test'))).toBe(false);
      expect(existsSync(path.join(dir, 'src'))).toBe(true);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }, 600_000);
});
