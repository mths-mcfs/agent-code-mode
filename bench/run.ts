import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { generateFixture, treeHash, DEFAULT_FIXTURE_SEED } from './fixture/generate.ts';
import { claudeArgs, CLAUDE_INNER_ALLOWED, claudeIsolationIssues, claudeMcpConfig, parseClaudeTranscript, upstreamMcpConfig, type ArmMcp } from './lib/claude.ts';
import { claudeInteractiveArgs, claudeSemver, interactiveEnv, parseClaudeInteractiveTranscript, seededClaudeJson, trimInteractiveTranscript, type InteractiveFacts } from './lib/claude-interactive.ts';
import { driveInteractive, findSessionTranscript, INTERACTIVE_DRIVER, serverAlive, sweepStaleTmuxServers, tmuxVersion } from './lib/tmux.ts';
import { catalogForArm, CODEX_FEATURES_OFF, EMPTY_MCP_SERVER, catalogHasModel, codexArgs, codexConfigToml, codexHooksJson, codexToolSurface, extractCodexRequests, parseCodexTranscript } from './lib/codex.ts';
import { createCodexHome, installCleanupHandlers, removeCodexHome, sweepStaleHomes } from './lib/codex-home.ts';
import { costFromUsage, loadPricing, type Pricing } from './lib/pricing.ts';
import { runProcess } from './lib/proc.ts';
import { ARM_LABELS, BASELINE_ARMS, BENCH_ARMS, checkArm, checkMcpCalls, checkSurface, CLAUDE_ARM_SURFACE, CODEX_COMMON_NON_FILE, hostArms, isAcmArm, mcpCallCounts, RunRecordSchema, surfaceArm, type ArmId, type BenchArm, type ParsedRun, type RunRecord } from './lib/record.ts';
import { Rng } from './lib/rng.ts';
import { defaultSanitizeContext, sanitize, sanitizeTree, writeSanitized, type SanitizeContext } from './lib/sanitize.ts';
import { claudeProjectSettings, CODEX_HOOK_MATCHER, createWorkspace, hookCommand, initialTree, workspaceDiff, type HostId } from './lib/workspace.ts';
import { writeReport } from './report.ts';
import { TASKS } from './tasks/index.ts';
import { DEFAULT_TASK_IDS, TASK_IDS, type TaskDef, type TaskId } from './tasks/types.ts';
import type { FixtureFacts } from './fixture/generate.ts';

/**
 * Benchmark runner: `npm run bench -- --host claude --arms A,B,C --tasks T1,T5 --runs 3`.
 * Resumable (a run whose record.json exists is skipped), `--dry-run` uses reference solutions and
 * canned transcripts instead of model calls. `--acm-ref <commit>` or `--acm-dist <dir>` adds a baseline
 * arm (Claude B0, Codex C0) that runs another agent-code-mode build in the same matrix.
 * Workspaces live outside the checkout (default `<os tmpdir>/acm-bench`): an agent that walks up from its
 * workspace must not reach bench/tasks, where the hidden tests and reference solutions are.
 */

export const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const BENCH_DIR = import.meta.dirname;
const PARSER_FIXTURES = path.join(BENCH_DIR, 'parser-fixtures');

const csv = <T extends string>(allowed: readonly T[]) =>
  z
    .string()
    .transform((s) => s.split(',').map((x) => x.trim()).filter((x) => x !== ''))
    .pipe(z.array(z.enum(allowed as [T, ...T[]])).min(1));

const OptionsSchema = z.object({
  host: z.enum(['claude', 'codex', 'all']).default('all'),
  arms: csv(BENCH_ARMS).optional(),
  tasks: csv(TASK_IDS).optional(),
  runs: z.coerce.number().int().min(1).max(50).default(3),
  seed: z.coerce.number().int().nonnegative().optional(),
  fixtureSeed: z.coerce.number().int().nonnegative().default(DEFAULT_FIXTURE_SEED),
  claudeModel: z.string().min(1).default('claude-sonnet-5-5'),
  claudeEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  codexModel: z.string().min(1).default('gpt-6.1-terra'),
  codexEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  timeoutMin: z.coerce.number().positive().max(240).default(15),
  maxTurns: z.coerce.number().int().positive().default(60),
  workDir: z.string().default(() => defaultWorkDir()),
  out: z.string().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dryRun: z.boolean().default(false),
  force: z.boolean().default(false),
  /** Baseline agent-code-mode build: a git ref of this repo, built in a temporary directory... */
  acmRef: z.string().min(1).optional(),
  /** ...or the `dist` directory of a build made elsewhere (must contain cli.js). */
  acmDist: z.string().min(1).optional(),
  /**
   * Diagnostic, not a matrix arm: runs Claude arm A in an interactive session (no Code Mode) through the
   * same tmux driver as arm D, to compare the interactive system prompt with the `-p` one. Its runs carry
   * `interactivePilot: true` in their config, so they never pool with `-p` arm A runs.
   */
  interactivePilot: z.boolean().default(false),
}).refine((o) => o.acmRef === undefined || o.acmDist === undefined, { message: '--acm-ref and --acm-dist are mutually exclusive' });
export type Options = z.infer<typeof OptionsSchema>;

/** Default work dir: outside the checkout, so no run workspace has the repo (and bench/tasks) above it. */
export function defaultWorkDir(): string {
  return path.join(os.tmpdir(), 'acm-bench');
}

/** `p` with symlinks resolved as far as it exists (the rest appended), so a link into the repo is caught. */
function realish(p: string): string {
  const abs = path.resolve(p);
  let head = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync(head), ...tail.reverse());
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return abs;
      tail.push(path.basename(head));
      head = parent;
    }
  }
}

/** True when `p` is the checkout or inside it. */
export function insideRepo(p: string, repo: string = REPO_ROOT): boolean {
  const rel = path.relative(realish(repo), realish(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Throws unless the run workspace is outside the checkout and no directory above it holds `bench/tasks`
 * (hidden tests, reference solutions): the agent's file tools and shell can climb out of the workspace.
 */
export function assertWorkspaceIsolated(ws: string, repo: string = REPO_ROOT): void {
  if (insideRepo(ws, repo)) throw new Error(`run workspace ${ws} is inside the repository checkout: hidden tests and solutions under bench/tasks would be readable`);
  for (let dir = realish(ws); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, 'bench', 'tasks'))) throw new Error(`run workspace ${ws} has ${dir}/bench/tasks above it: hidden tests and solutions would be readable`);
    if (path.dirname(dir) === dir) return;
  }
}

export function parseOptions(argv: readonly string[]): Options {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      host: { type: 'string' },
      arms: { type: 'string' },
      tasks: { type: 'string' },
      runs: { type: 'string' },
      seed: { type: 'string' },
      'fixture-seed': { type: 'string' },
      'claude-model': { type: 'string' },
      'claude-effort': { type: 'string' },
      'codex-model': { type: 'string' },
      'codex-effort': { type: 'string' },
      'timeout-min': { type: 'string' },
      'max-turns': { type: 'string' },
      'work-dir': { type: 'string' },
      out: { type: 'string' },
      date: { type: 'string' },
      'dry-run': { type: 'boolean' },
      force: { type: 'boolean' },
      'acm-ref': { type: 'string' },
      'acm-dist': { type: 'string' },
      'interactive-pilot': { type: 'boolean' },
    },
    strict: true,
  });
  return OptionsSchema.parse({
    host: values.host,
    arms: values.arms,
    tasks: values.tasks,
    runs: values.runs,
    seed: values.seed,
    fixtureSeed: values['fixture-seed'],
    claudeModel: values['claude-model'],
    claudeEffort: values['claude-effort'],
    codexModel: values['codex-model'],
    codexEffort: values['codex-effort'],
    timeoutMin: values['timeout-min'],
    maxTurns: values['max-turns'],
    workDir: values['work-dir'],
    out: values.out,
    date: values.date,
    dryRun: values['dry-run'],
    force: values.force,
    acmRef: values['acm-ref'],
    acmDist: values['acm-dist'],
    interactivePilot: values['interactive-pilot'],
  });
}

export interface PlannedRun {
  readonly host: HostId;
  readonly task: TaskId;
  readonly arm: BenchArm;
  readonly run: number;
  readonly round: number;
  readonly orderIndex: number;
  /** Position of the arm inside its (round, host, task) block, 0-based. */
  readonly position: number;
  /** A warmup run (kept apart from the matrix and its statistics). */
  readonly warmup?: boolean;
}

/** The arms of each host that run, given `--arms` and whether there is a baseline build. */
export function armsFor(host: HostId, arms: readonly BenchArm[] | undefined, withBaseline: boolean): BenchArm[] {
  return hostArms(host, withBaseline).filter((a) => arms === undefined || arms.includes(a));
}

/**
 * Paired schedule. Each round has one block per host x task, in a seeded order, and a block holds the
 * runs of every arm of that host on that task back to back, so the arms of a task are always measured
 * at the same time. Inside a block the arm order is a seeded base order rotated by one place per round
 * (a Latin square): over any `arms` consecutive rounds each arm takes each position once.
 */
export function planRuns(hosts: readonly HostId[], tasks: readonly TaskId[], arms: readonly BenchArm[] | undefined, runs: number, seed: number, withBaseline = false): PlannedRun[] {
  const rng = new Rng(seed);
  const blocks: { host: HostId; task: TaskId; arms: BenchArm[] }[] = [];
  for (const host of hosts) {
    const list = armsFor(host, arms, withBaseline);
    if (list.length === 0) continue;
    for (const task of tasks) blocks.push({ host, task, arms: rng.shuffle(list) });
  }
  const plan: PlannedRun[] = [];
  for (let round = 1; round <= runs; round++) {
    for (const b of new Rng(seed + round * 7919).shuffle(blocks)) {
      const k = b.arms.length;
      for (let position = 0; position < k; position++) {
        const arm = b.arms[(position + round - 1) % k] as BenchArm;
        plan.push({ host: b.host, task: b.task, arm, run: round, round, orderIndex: plan.length, position });
      }
    }
  }
  return plan;
}

/** Task every warmup run uses: the cheapest one (the cache prefix it warms is the arm's system prompt and tools). */
export const WARMUP_TASK: TaskId = 'T1';

/** One warmup run per host and arm of the plan, in a seeded order, all arms alike. */
export function planWarmup(plan: readonly PlannedRun[], seed: number): PlannedRun[] {
  const pairs = [...new Map(plan.map((p) => [`${p.host}|${p.arm}`, { host: p.host, arm: p.arm }])).values()];
  return new Rng(seed ^ 0x5eed).shuffle(pairs).map((p, i) => ({ host: p.host, arm: p.arm, task: WARMUP_TASK, run: 1, round: 1, orderIndex: i, position: i, warmup: true }));
}

export function runId(p: Pick<PlannedRun, 'host' | 'task' | 'arm' | 'run' | 'warmup'>): string {
  return `${p.warmup === true ? 'warmup-' : ''}${p.host}-${p.task}-${p.arm}-r${p.run}`;
}

/** Results of a run live under its config hash, so a run made with other settings is never taken for this one. */
export function runResultDir(resultsDir: string, p: Pick<PlannedRun, 'host' | 'task' | 'arm' | 'run'>, configHash: string): string {
  return path.join(resultsDir, p.host, p.task, p.arm, configHash, String(p.run));
}

/** Warmup records of one invocation, under `warmup/` (the report keeps them out of every statistic). */
export function warmupResultDir(resultsDir: string, invocation: string, p: Pick<PlannedRun, 'host' | 'task' | 'arm'>, configHash: string): string {
  return path.join(resultsDir, 'warmup', invocation, p.host, p.task, p.arm, configHash);
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function tryExec(cmd: string, args: readonly string[], cwd?: string): string | null {
  try {
    return execFileSync(cmd, [...args], { encoding: 'utf8', cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000 }).trim();
  } catch {
    return null;
  }
}

/** Environment passed to a host: enough to run and authenticate, nothing from the calling agent session. */
function hostEnv(extra: Record<string, string>): Record<string, string | undefined> {
  const keep = ['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY'];
  const env: Record<string, string | undefined> = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, TERM: 'dumb', NO_COLOR: '1', DISABLE_AUTOUPDATER: '1', ...extra };
}

async function findFiles(dir: string, suffix: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await findFiles(p, suffix)));
    else if (e.name.endsWith(suffix)) out.push(p);
  }
  return out.sort();
}

/** The user's Claude config dir (`$CLAUDE_CONFIG_DIR` when absolute, else `~/.claude`). */
function sourceClaudeConfig(): string {
  const env = process.env['CLAUDE_CONFIG_DIR'];
  return env !== undefined && env !== '' && path.isAbsolute(env) ? env : path.join(os.homedir(), '.claude');
}

/**
 * How Claude runs are isolated from the user's config. `--setting-sources project` keeps user settings
 * out but not the user's CLAUDE.md: Claude walks up from the workspace and also loads
 * `<ancestor>/.claude/CLAUDE.md`, which is the user memory whenever the workspace is under the home
 * directory (checked with Claude Code 2.1.325). So: CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 (no CLAUDE.md of any
 * level; the fixture has none), auto memory off, and a temporary CLAUDE_CONFIG_DIR holding only a copy of
 * the credentials file (same copy + hash + write-back rule as Codex). Without a credentials file (macOS
 * keychain) the config dir is not replaced and the method says so.
 */
export function claudeIsolationMethod(hasCredentialsFile: boolean): string {
  return [
    '--setting-sources project',
    '--strict-mcp-config',
    'CLAUDE_CODE_DISABLE_CLAUDE_MDS=1',
    'CLAUDE_CODE_DISABLE_AUTO_MEMORY=1',
    hasCredentialsFile ? 'temporary CLAUDE_CONFIG_DIR with a copy of .credentials.json (written back if refreshed)' : 'user CLAUDE_CONFIG_DIR (no credentials file to copy)',
  ].join('; ');
}

function sourceCodexHome(): string {
  const env = process.env['CODEX_HOME'];
  return env !== undefined && env !== '' ? env : path.join(os.homedir(), '.codex');
}

export interface Context {
  readonly opts: Options;
  readonly date: string;
  readonly resultsDir: string;
  readonly pricing: Pricing;
  readonly serverEntry: string;
  readonly rawCatalog: string | null;
  /** Order seed of this invocation. */
  readonly seed: number;
  readonly versions: Readonly<Record<string, string | null>>;
  readonly git: { readonly commit: string | null; readonly dirty: boolean | null };
  /** Baseline agent-code-mode build of the B0/C0 arms, or null without `--acm-ref`/`--acm-dist`. */
  readonly baseline: AcmBuild | null;
  /** Timestamp of this invocation, naming its warmup directory. */
  readonly invocation: string;
}

export interface AcmBuild {
  /** `ref:<commit 12>` or `dist:<content sha 12>`: what the config hash records. */
  readonly id: string;
  /** Server entry (`cli.js`) of the build. */
  readonly entry: string;
}

/** The agent-code-mode server an arm runs: the baseline build for B0/C0, this checkout's dist otherwise. */
function serverEntryFor(ctx: Context, arm: BenchArm): string {
  if (arm === 'B0' || arm === 'C0') {
    if (ctx.baseline === null) throw new Error(`arm ${arm} needs --acm-ref or --acm-dist`);
    return ctx.baseline.entry;
  }
  return ctx.serverEntry;
}

/**
 * A task's MCP server in an arm: the stdio entry (this Node and the server file) and the file that hands it
 * to agent-code-mode as an upstream. Undefined for tasks without one. `upstreamConfigFile` is `<upstream-mcp>`
 * in the arm definition, so the config hash does not depend on the run directory.
 */
function armMcp(task: TaskDef, facts: FixtureFacts, upstreamConfigFile: string): ArmMcp | undefined {
  const m = task.mcpServer;
  if (m === undefined) return undefined;
  return { server: { name: m.name, command: process.execPath, args: [m.entry, ...m.args(facts)] }, upstreamConfigFile };
}

/**
 * Direct tool names of a task's MCP server that an arm's host lists. None in B (the server is agent-code-mode's
 * upstream) and none in D: an interactive Code Mode session defers MCP tools behind `DeferredToolPlaceholder`
 * and a REPL script finds them with `searchTools` (seen in the T16 pilot, Claude Code 2.1.327).
 */
export function taskDirectTools(task: Pick<TaskDef, 'mcpServer'>, arm: ArmId): string[] {
  const m = task.mcpServer;
  return m === undefined || arm === 'B' || arm === 'D' ? [] : m.tools.map((t) => `mcp__${m.name}__${t}`);
}

/** REPL helpers a Code Mode script uses to find deferred tools: allowed inside scripts on MCP tasks, where they reach the task's tools. */
export const REPL_DISCOVERY_TOOLS = ['searchTools', 'describeTool'];

/** Tools a REPL script may call on a task besides the arm A tools: the task's MCP tools and the discovery helpers. */
export function taskScriptTools(task: Pick<TaskDef, 'mcpServer'>): string[] {
  const m = task.mcpServer;
  return m === undefined ? [] : [...m.tools.map((t) => `mcp__${m.name}__${t}`), ...REPL_DISCOVERY_TOOLS];
}

/** Content hash of a build directory (sorted relative paths and bytes), for `--acm-dist`. */
async function dirHash(dir: string): Promise<string> {
  const hash = createHash('sha256');
  const files = (await readdir(dir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name)).sort();
  for (const f of files) {
    hash.update(path.relative(dir, f).split(path.sep).join('/'));
    hash.update('\0');
    hash.update(await readFile(f));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/**
 * Resolves the baseline build. `--acm-dist <dir>`: an existing build (its cli.js runs with the
 * node_modules it can resolve from there). `--acm-ref <ref>`: the commit, without bench/ and test/, is
 * exported with `git archive` into `<work-dir>/acm-builds/<commit>`, linked to this checkout's node_modules and built with its own
 * `npm run build` (reused on later invocations). Refused when the ref's package-lock.json differs from
 * this checkout's: the shared node_modules would not be the dependencies that version declares.
 */
export async function resolveBaseline(opts: Pick<Options, 'acmRef' | 'acmDist' | 'dryRun'>, workDir: string): Promise<AcmBuild | null> {
  if (opts.acmDist !== undefined) {
    const dir = path.resolve(opts.acmDist);
    const entry = path.join(dir, 'cli.js');
    if (!(await exists(entry))) throw new Error(`--acm-dist ${dir} has no cli.js (pass the dist directory of a build)`);
    return { id: `dist:${(await dirHash(dir)).slice(0, 12)}`, entry };
  }
  if (opts.acmRef === undefined) return null;
  const commit = tryExec('git', ['rev-parse', '--verify', '--quiet', `${opts.acmRef}^{commit}`], REPO_ROOT);
  if (commit === null || commit === '') throw new Error(`--acm-ref ${opts.acmRef} is not a commit of this repository`);
  const dir = path.join(workDir, 'acm-builds', commit);
  const entry = path.join(dir, 'dist', 'cli.js');
  const build = { id: `ref:${commit.slice(0, 12)}`, entry };
  // A build made before bench/ was left out of the archive would hold hidden tests next to the runs.
  if ((await exists(path.join(dir, 'bench'))) || (await exists(path.join(dir, 'test')))) await rm(dir, { recursive: true, force: true });
  if (opts.dryRun || (await exists(path.join(dir, '.built')))) return build;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  // Only what the build needs: no bench/ (hidden tests, solutions) next to the run workspaces. The archive
  // is written into the build dir and unpacked there by a relative name: a GNU tar on Windows reads a
  // drive letter (`D:\\...`) as a remote host, the system bsdtar does not care.
  const tar = path.join(dir, 'source.tar');
  execFileSync('git', ['archive', '--format=tar', '-o', tar, commit, '--', '.', ':(exclude)bench', ':(exclude)test'], { cwd: REPO_ROOT, stdio: 'ignore' });
  execFileSync('tar', ['-xf', 'source.tar'], { cwd: dir, stdio: 'ignore' });
  await rm(tar, { force: true });
  const lock = async (d: string): Promise<string | null> => readFile(path.join(d, 'package-lock.json'), 'utf8').catch(() => null);
  if ((await lock(dir)) !== (await lock(REPO_ROOT))) {
    await rm(dir, { recursive: true, force: true });
    throw new Error(`--acm-ref ${opts.acmRef}: its package-lock.json differs from this checkout's; build it in its own checkout and pass --acm-dist <that dist>`);
  }
  // A junction on Windows: a directory symlink there needs a privilege the user may not have.
  await symlink(path.join(REPO_ROOT, 'node_modules'), path.join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const npm = npmCommand();
  execFileSync(npm.command, [...npm.args, 'run', 'build'], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'], timeout: 600_000 });
  if (!(await exists(entry))) throw new Error(`--acm-ref ${opts.acmRef}: the build produced no dist/cli.js`);
  await writeFile(path.join(dir, '.built'), `${commit}\n`);
  return build;
}

/**
 * How to run npm without a shell: this Node with npm's own `npm-cli.js` (`npm` is a `.cmd` shim on
 * Windows, which `execFile` cannot start). Found from `npm_execpath` when run under npm, else next to the
 * Node binary (Windows: `<node dir>/node_modules/npm`, POSIX: `<prefix>/lib/node_modules/npm`); plain
 * `npm` as the last resort.
 */
export function npmCommand(env: NodeJS.ProcessEnv = process.env, execPath: string = process.execPath): { command: string; args: string[] } {
  const nodeDir = path.dirname(execPath);
  const candidates = [
    env['npm_execpath'],
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const c of candidates) if (c !== undefined && c !== '' && /npm-cli\.js$/.test(c) && existsSync(c)) return { command: execPath, args: [c] };
  return { command: 'npm', args: [] };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** What the host is actually given for an arm (args, settings, config), with machine paths replaced by placeholders. */
function armDefinition(ctx: Context, p: Pick<PlannedRun, 'host' | 'task' | 'arm'>): string {
  const task = TASKS[p.task];
  const arm = surfaceArm(p.arm);
  const fixture = generateFixture(ctx.opts.fixtureSeed);
  let def: unknown;
  if (p.host === 'claude' && isInteractive(ctx.opts, p)) {
    const codeMode = arm === 'D';
    const mcp = armMcp(task, fixture.facts, '<upstream-mcp>');
    def = {
      driver: INTERACTIVE_DRIVER,
      args: claudeInteractiveArgs({ codeMode, model: ctx.opts.claudeModel, effort: ctx.opts.claudeEffort, settingsFile: '<settings>', mcpConfigFile: '<mcp>', sessionId: '<session>' }),
      env: interactiveEnv({}, { configDir: '<config>', codeMode }),
      claudeJson: seededClaudeJson('<workspace>', claudeSemver(ctx.versions['claude'])),
      maxTurns: ctx.opts.maxTurns,
      settings: claudeProjectSettings(task, fixture),
      mcp: claudeMcpConfig(arm, '<server>', mcp),
      ...(mcp === undefined ? {} : { upstream: upstreamMcpConfig(mcp.server) }),
      isolation: claudeIsolationMethod(true),
    };
  } else if (p.host === 'claude') {
    const mcp = armMcp(task, fixture.facts, '<upstream-mcp>');
    def = {
      args: claudeArgs({ arm, model: ctx.opts.claudeModel, effort: ctx.opts.claudeEffort, maxTurns: ctx.opts.maxTurns, settingsFile: '<settings>', mcpConfigFile: '<mcp>' }),
      settings: claudeProjectSettings(task, fixture),
      mcp: claudeMcpConfig(arm, '<server>', mcp),
      ...(mcp === undefined ? {} : { upstream: upstreamMcpConfig(mcp.server) }),
      isolation: claudeIsolationMethod(existsSync(path.join(sourceClaudeConfig(), '.credentials.json'))),
    };
  } else {
    const catalog = ctx.rawCatalog === null ? null : catalogForArm(arm, ctx.rawCatalog);
    def = {
      args: codexArgs('<ws>', task.protectedHook),
      config: codexConfigToml({ arm, model: ctx.opts.codexModel, effort: ctx.opts.codexEffort, codexHome: '<home>', catalogFile: catalog === null ? null : '<catalog>', serverEntry: '<server>', nodePath: 'node', emptyServerEntry: '<empty-server>' }),
      hooks: task.protectedHook ? codexHooksJson(CODEX_HOOK_MATCHER, hookCommand(fixture.facts.protectedFile)) : null,
      catalogSha256: catalog === null ? null : sha256(catalog),
    };
  }
  return stableJson(def).split(REPO_ROOT).join('<repo>').split(JSON.stringify(process.execPath).slice(1, -1)).join('node');
}

/** Everything a run's numbers depend on. Two runs are comparable only when this is equal. */
export function runConfig(ctx: Context, p: Pick<PlannedRun, 'host' | 'task' | 'arm'>): Record<string, unknown> {
  const fixture = generateFixture(ctx.opts.fixtureSeed);
  return {
    host: p.host,
    task: p.task,
    arm: p.arm,
    hostVersion: ctx.versions[p.host] ?? null,
    model: p.host === 'claude' ? ctx.opts.claudeModel : ctx.opts.codexModel,
    effort: p.host === 'claude' ? ctx.opts.claudeEffort : ctx.opts.codexEffort,
    maxTurns: p.host === 'claude' ? ctx.opts.maxTurns : null,
    timeoutMin: ctx.opts.timeoutMin,
    seed: ctx.seed,
    fixtureSeed: ctx.opts.fixtureSeed,
    fixtureSha256: treeHash(fixture.files),
    /** The task's own tree (fixture plus task setup): tasks that add files are covered too. */
    taskTreeSha256: treeHash(initialTree(TASKS[p.task], p.host, fixture)),
    promptSha256: sha256(TASKS[p.task].prompt(fixture.facts)),
    armDefinitionSha256: sha256(armDefinition(ctx, p)),
    agentCodeModeCommit: ctx.git.commit,
    agentCodeModeDirty: ctx.git.dirty,
    /** Which agent-code-mode build the arm runs: this checkout's dist, a baseline build, or none (other arms). */
    acmBuild: !isAcmArm(p.host, p.arm) ? null : p.arm === 'B0' || p.arm === 'C0' ? (ctx.baseline?.id ?? null) : 'checkout',
    dryRun: ctx.opts.dryRun,
    // Only on pilot runs (undefined keys are left out of the hash, so other configs keep their hash).
    interactivePilot: ctx.opts.interactivePilot && p.host === 'claude' && p.arm === 'A' ? true : undefined,
  };
}

/** Claude runs driven as an interactive session: arm D (Code Mode) always, arm A under `--interactive-pilot`. */
export function isInteractive(opts: Pick<Options, 'interactivePilot'>, p: Pick<PlannedRun, 'host' | 'arm'>): boolean {
  return p.host === 'claude' && (p.arm === 'D' || (opts.interactivePilot && p.arm === 'A'));
}

export function configHash(config: Record<string, unknown>): string {
  return sha256(stableJson(config)).slice(0, 12);
}

interface HostOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly requests: string | null;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly wallMs: number;
  /** Config files to keep with the transcript (sanitized). */
  readonly configs: Record<string, string>;
  /** Codex: model-visible tools from `codex debug prompt-input` with the run's config. */
  readonly availableTools?: string[] | null;
  /** Interactive Claude sessions: what the driver observed on screen. */
  readonly interactive?: InteractiveObserved;
}

interface InteractiveObserved {
  readonly codeMode: boolean;
  readonly stop: string;
  readonly problem: string | null;
  readonly codeModeLine: string | null;
  readonly permissionPrompts: number;
  /** Plugin keys of the session's .claude.json (`pluginUsage`), the isolation proof `-p` reads from its init event. */
  readonly plugins: readonly string[] | null;
  /** The private tmux server was gone after the run. */
  readonly serverGone: boolean;
}

async function cannedTranscript(host: HostId, arm: ArmId): Promise<{ stdout: string; requests: string | null }> {
  const base = path.join(PARSER_FIXTURES, `${host}-${arm}`);
  const stdout = await readFile(`${base}.jsonl`, 'utf8');
  const requests = host === 'codex' ? await readFile(`${base}.requests.jsonl`, 'utf8') : null;
  return { stdout, requests };
}

const ClaudeJsonPlugins = z.object({ pluginUsage: z.record(z.string(), z.unknown()).optional() }).passthrough();

/**
 * Runs one Claude run as an interactive session (arm D, or arm A under `--interactive-pilot`): a temporary
 * CLAUDE_CONFIG_DIR with a copy of the credentials file and a seeded .claude.json, the tmux driver, the
 * session transcript copied (trimmed) before the config dir is synced back and deleted.
 */
async function runClaudeInteractive(ctx: Context, p: PlannedRun, runWork: string, ws: string): Promise<HostOutput> {
  const task = TASKS[p.task];
  const fixture = generateFixture(ctx.opts.fixtureSeed);
  const arm = surfaceArm(p.arm);
  const codeMode = arm === 'D';
  const settingsFile = path.join(runWork, 'claude-settings.json');
  const mcpConfigFile = path.join(runWork, 'mcp-config.json');
  const settings = `${JSON.stringify(claudeProjectSettings(task, fixture), null, 2)}\n`;
  const mcp = `${JSON.stringify(claudeMcpConfig(arm, '', armMcp(task, fixture.facts, '')), null, 2)}\n`;
  await writeFile(settingsFile, settings);
  await writeFile(mcpConfigFile, mcp);
  const sessionId = randomUUID();
  const args = claudeInteractiveArgs({ codeMode, model: ctx.opts.claudeModel, effort: ctx.opts.claudeEffort, settingsFile, mcpConfigFile, sessionId });
  const configDir = path.join(runWork, 'claude-config');
  const env = interactiveEnv(process.env, { configDir, codeMode });
  const configs: Record<string, string> = {
    'claude-settings.json': settings,
    'mcp-config.json': mcp,
    'command.txt': `env -i ${Object.keys(env).sort().join(' ')} claude ${args.join(' ')}\n# driven in tmux: ${INTERACTIVE_DRIVER}\n`,
  };
  if (ctx.opts.dryRun) {
    const canned = await readFile(path.join(PARSER_FIXTURES, `claude-${arm}.jsonl`), 'utf8');
    return { stdout: canned, stderr: '', requests: null, exitCode: 0, timedOut: false, wallMs: 0, configs };
  }
  if (!(await exists(path.join(sourceClaudeConfig(), '.credentials.json')))) throw new Error('interactive Claude runs need a credentials file to copy into a temporary config dir');
  const realWs = realpathSync(ws);
  const claudeJson = `${JSON.stringify(seededClaudeJson(realWs, claudeSemver(ctx.versions['claude'])), null, 2)}\n`;
  configs['claude-json-seed.json'] = claudeJson;
  try {
    createCodexHome(configDir, sourceClaudeConfig(), '.credentials.json');
    await writeFile(path.join(configDir, '.claude.json'), claudeJson, { mode: 0o600 });
    const outcome = await driveInteractive({
      cwd: realWs,
      command: ['claude', ...args],
      env,
      prompt: task.prompt(fixture.facts),
      transcriptFile: () => findSessionTranscript(configDir, sessionId),
      codeMode,
      timeoutMs: ctx.opts.timeoutMin * 60_000,
      maxTurns: ctx.opts.maxTurns,
      scratchDir: runWork,
    });
    // Copy what the record needs out of the config dir before it is deleted.
    const file = findSessionTranscript(configDir, sessionId);
    const stdout = file === null ? '' : trimInteractiveTranscript(await readFile(file, 'utf8'));
    let plugins: string[] | null = null;
    try {
      const parsed = ClaudeJsonPlugins.safeParse(JSON.parse(await readFile(path.join(configDir, '.claude.json'), 'utf8')));
      if (parsed.success) plugins = Object.keys(parsed.data.pluginUsage ?? {});
    } catch {
      plugins = null;
    }
    configs['screen.txt'] = outcome.screens;
    configs['auth.txt'] = `.credentials.json: ${removeCodexHome(configDir)}\n`;
    configs['isolation.txt'] = `${claudeIsolationMethod(true)}; interactive: env -i allowlist (${Object.keys(env).sort().join(', ')}), seeded .claude.json\n`;
    const interactive: InteractiveObserved = {
      codeMode,
      stop: outcome.stop,
      problem: outcome.problem,
      codeModeLine: outcome.codeModeLine,
      permissionPrompts: outcome.permissionPrompts,
      plugins,
      serverGone: !serverAlive(outcome.server),
    };
    const stderr = `stop: ${outcome.stop}\nready after: ${outcome.readyMs ?? '-'} ms\npermission prompts denied: ${outcome.permissionPrompts}\n${outcome.problem === null ? '' : `problem: ${outcome.problem}\n`}`;
    return { stdout, stderr, requests: null, exitCode: outcome.exitCode, timedOut: outcome.timedOut, wallMs: outcome.wallMs, configs, interactive };
  } finally {
    removeCodexHome(configDir);
  }
}

async function runClaude(ctx: Context, p: PlannedRun, runWork: string, ws: string): Promise<HostOutput> {
  if (isInteractive(ctx.opts, p)) return runClaudeInteractive(ctx, p, runWork, ws);
  const task = TASKS[p.task];
  const fixture = generateFixture(ctx.opts.fixtureSeed);
  const settingsFile = path.join(runWork, 'claude-settings.json');
  const mcpConfigFile = path.join(runWork, 'mcp-config.json');
  const settings = `${JSON.stringify(claudeProjectSettings(task, fixture), null, 2)}\n`;
  const arm = surfaceArm(p.arm);
  const taskMcp = armMcp(task, fixture.facts, path.join(runWork, 'upstream-mcp.json'));
  const mcp = `${JSON.stringify(claudeMcpConfig(arm, serverEntryFor(ctx, p.arm), taskMcp), null, 2)}\n`;
  await writeFile(settingsFile, settings);
  await writeFile(mcpConfigFile, mcp);
  const upstream = taskMcp === undefined ? undefined : `${JSON.stringify(upstreamMcpConfig(taskMcp.server), null, 2)}\n`;
  if (taskMcp !== undefined && upstream !== undefined) await writeFile(taskMcp.upstreamConfigFile, upstream);
  const args = claudeArgs({ arm, model: ctx.opts.claudeModel, effort: ctx.opts.claudeEffort, maxTurns: ctx.opts.maxTurns, settingsFile, mcpConfigFile });
  const configs: Record<string, string> = { 'claude-settings.json': settings, 'mcp-config.json': mcp, 'command.txt': `claude ${args.map((a) => (a === '' ? '""' : a)).join(' ')}\n`, ...(upstream === undefined ? {} : { 'upstream-mcp.json': upstream }) };
  if (ctx.opts.dryRun) return { ...(await cannedTranscript('claude', arm)), stderr: '', exitCode: 0, timedOut: false, wallMs: 0, configs };
  const stdoutFile = path.join(runWork, 'stdout.jsonl');
  const stderrFile = path.join(runWork, 'stderr.txt');
  const configDir = path.join(runWork, 'claude-config');
  const isolated = await exists(path.join(sourceClaudeConfig(), '.credentials.json'));
  const env: Record<string, string> = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' };
  try {
    if (isolated) {
      createCodexHome(configDir, sourceClaudeConfig(), '.credentials.json');
      env['CLAUDE_CONFIG_DIR'] = configDir;
    }
    const outcome = await runProcess({ command: 'claude', args, cwd: ws, env: hostEnv(env), timeoutMs: ctx.opts.timeoutMin * 60_000, stdoutFile, stderrFile, stdin: task.prompt(fixture.facts) });
    configs['auth.txt'] = isolated ? `.credentials.json: ${removeCodexHome(configDir)}\n` : 'no credentials file: user config dir used\n';
    configs['isolation.txt'] = `${claudeIsolationMethod(isolated)}\n`;
    return { stdout: await readFile(stdoutFile, 'utf8'), stderr: await readFile(stderrFile, 'utf8'), requests: null, ...outcome, configs };
  } finally {
    removeCodexHome(configDir);
  }
}

async function runCodex(ctx: Context, p: PlannedRun, runWork: string, ws: string): Promise<HostOutput> {
  const task = TASKS[p.task];
  const fixture = generateFixture(ctx.opts.fixtureSeed);
  const codexHome = path.join(runWork, 'codex-home');
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  try {
    // The auth link is placed last, right before the host runs, and the home is registered for cleanup.
    const arm = surfaceArm(p.arm);
    const catalog = ctx.rawCatalog === null ? null : catalogForArm(arm, ctx.rawCatalog);
    const catalogFile = catalog === null ? null : path.join(codexHome, 'catalog.json');
    if (catalogFile !== null && catalog !== null) await writeFile(catalogFile, catalog);
    const config = codexConfigToml({ arm, model: ctx.opts.codexModel, effort: ctx.opts.codexEffort, codexHome, catalogFile, serverEntry: serverEntryFor(ctx, p.arm), nodePath: process.execPath, emptyServerEntry: EMPTY_MCP_SERVER });
    await writeFile(path.join(codexHome, 'config.toml'), config);
    const hooks = task.protectedHook ? codexHooksJson(CODEX_HOOK_MATCHER, hookCommand(fixture.facts.protectedFile)) : null;
    if (hooks !== null) await writeFile(path.join(codexHome, 'hooks.json'), hooks);
    const args = codexArgs(ws, hooks !== null);
    const configs: Record<string, string> = { 'codex-config.toml': config, 'command.txt': `codex ${args.join(' ')}\n` };
    if (hooks !== null) configs['codex-hooks.json'] = hooks;
    if (ctx.opts.dryRun) return { ...(await cannedTranscript('codex', arm)), stderr: '', exitCode: 0, timedOut: false, wallMs: 0, configs };
    createCodexHome(codexHome, sourceCodexHome());
    let availableTools: string[] | null = null;
    try {
      const promptInput = execFileSync('codex', ['debug', 'prompt-input'], { cwd: ws, encoding: 'utf8', env: hostEnv({ CODEX_HOME: codexHome }), timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
      availableTools = codexToolSurface(promptInput);
      configs['tool-surface.json'] = `${JSON.stringify(availableTools, null, 2)}\n`;
    } catch (err) {
      configs['tool-surface.json'] = `${JSON.stringify({ error: err instanceof Error ? err.message : String(err) })}\n`;
    }
    const stdoutFile = path.join(runWork, 'stdout.jsonl');
    const stderrFile = path.join(runWork, 'stderr.txt');
    const outcome = await runProcess({ command: 'codex', args, cwd: ws, env: hostEnv({ CODEX_HOME: codexHome }), timeoutMs: ctx.opts.timeoutMin * 60_000, stdoutFile, stderrFile, stdin: task.prompt(fixture.facts) });
    const rollouts = await findFiles(path.join(codexHome, 'sessions'), '.jsonl');
    let requests = '';
    for (const r of rollouts) requests += extractCodexRequests(await readFile(r, 'utf8'));
    // Sync a refreshed token back to the real auth file (if it is still the copied version) and delete the home now.
    configs['auth.txt'] = `auth.json: ${removeCodexHome(codexHome)}\n`;
    return { stdout: await readFile(stdoutFile, 'utf8'), stderr: await readFile(stderrFile, 'utf8'), requests: rollouts.length > 0 ? requests : null, ...outcome, configs, availableTools };
  } finally {
    // Signal handlers and the startup sweep cover the cases where this never runs.
    removeCodexHome(codexHome);
  }
}

/**
 * Validity of an interactive run from what was observed, not from the configuration: the Code Mode line on
 * screen (arm D) or its absence (pilot), Code Mode in the transcript, the effort and permission mode of the
 * requests, the end of the turn, the inner calls staying on the arm A tools, and the tmux server gone.
 */
export function interactiveReasons(opts: Pick<Options, 'dryRun' | 'claudeEffort'>, p: Pick<PlannedRun, 'arm'>, seen: InteractiveObserved | null, facts: InteractiveFacts | null, taskTools: readonly string[] = []): string[] {
  const reasons: string[] = [];
  const codeMode = surfaceArm(p.arm) === 'D';
  if (!opts.dryRun) {
    if (seen === null) return ['interactive session not observed'];
    if (seen.problem !== null) reasons.push(seen.problem);
    if (seen.stop === 'max-turns') reasons.push('host error: error_max_turns');
    if (codeMode && seen.codeModeLine === null) reasons.push('Code Mode on was not seen on screen');
    if (!codeMode && seen.codeModeLine !== null) reasons.push(`Code Mode was on in a native interactive run: ${seen.codeModeLine}`);
    if (!seen.serverGone) reasons.push('the tmux server was still running after the run');
  }
  if (facts !== null) {
    if (codeMode !== facts.replMode) reasons.push(codeMode ? 'the transcript does not record Code Mode (repl-mode)' : 'the transcript records Code Mode (repl-mode) in a native run');
    if (!opts.dryRun && (facts.efforts.length !== 1 || facts.efforts[0] !== opts.claudeEffort)) reasons.push(`requests ran with effort [${facts.efforts.join(', ')}], expected ${opts.claudeEffort}`);
    const modes = facts.permissionModes.filter((m) => m !== 'default');
    if (modes.length > 0) reasons.push(`permission mode ${modes.join(', ')} recorded, expected default`);
    // A task's MCP tools are part of the task: scripts may call them (and in arm D must, see checkMcpCalls).
    const outside = Object.keys(facts.innerByTool).filter((t) => !CLAUDE_INNER_ALLOWED.includes(t) && !taskTools.includes(t));
    if (outside.length > 0) reasons.push(`REPL scripts called tools outside the arm A tools${taskTools.length > 0 ? ' and the task MCP tools' : ''}: ${outside.join(', ')}`);
  }
  return reasons;
}

/** Runs (or dry-runs) one planned run and writes its sanitized artifacts and record. */
export async function executeRun(ctx: Context, p: PlannedRun): Promise<RunRecord> {
  const task = TASKS[p.task];
  const id = runId(p);
  const startedAt = new Date().toISOString();
  const runWork = path.join(ctx.opts.workDir, 'runs', ctx.date, `${id}-${Date.now()}`);
  const ws = path.join(runWork, 'ws');
  // Claude runs with cwd = ws (its MCP roots, so arm B's server, are ws); Codex with cwd = ws and `-C ws`
  // (arm C's MCP server inherits that cwd). Nothing the host is pointed at may be in the checkout.
  assertWorkspaceIsolated(ws);
  const workspace = await createWorkspace(ws, task, p.host, ctx.opts.fixtureSeed);
  let solutionAnswer: string | undefined;
  if (ctx.opts.dryRun) solutionAnswer = await task.solution(ws, workspace.fixture.facts);

  const output = p.host === 'claude' ? await runClaude(ctx, p, runWork, ws) : await runCodex(ctx, p, runWork, ws);

  const interactive = isInteractive(ctx.opts, p);
  let parsed: ParsedRun | null = null;
  let facts: InteractiveFacts | null = null;
  let parseError: string | null = null;
  try {
    if (interactive) {
      const r = parseClaudeInteractiveTranscript(output.stdout);
      facts = r.facts;
      const plugins = output.interactive?.plugins;
      parsed = plugins != null && r.parsed.hostContext !== null ? { ...r.parsed, hostContext: { ...r.parsed.hostContext, plugins: [...plugins] } } : r.parsed;
      if (!ctx.opts.dryRun && plugins == null) parsed = { ...parsed, hostContext: null };
    } else parsed = p.host === 'claude' ? parseClaudeTranscript(output.stdout) : parseCodexTranscript(output.stdout, output.requests);
    if (parsed.availableTools === null && output.availableTools) parsed = { ...parsed, availableTools: output.availableTools };
  } catch (err) {
    parseError = err instanceof Error ? err.message : String(err);
  }
  const taskTools = taskDirectTools(task, surfaceArm(p.arm));
  const mcpServer = task.mcpServer;
  if (parsed !== null && mcpServer !== undefined) parsed = { ...parsed, mcpCalls: mcpCallCounts(parsed, mcpServer.name) };
  const answer = solutionAnswer ?? parsed?.finalAnswer ?? '';
  const verify = await task.verify({ workspace: ws, answer, facts: workspace.fixture.facts, initial: workspace.initial, denials: ctx.opts.dryRun ? null : (parsed?.denials ?? null) });

  const model = p.host === 'claude' ? ctx.opts.claudeModel : ctx.opts.codexModel;
  let costUsd: number | null = null;
  let costSource: RunRecord['costSource'] = 'none';
  if (parsed?.hostCostUsd != null) {
    costUsd = parsed.hostCostUsd;
    costSource = 'host';
  } else if (parsed?.usage) {
    costUsd = costFromUsage(ctx.pricing, model, parsed.usage);
    costSource = costUsd === null ? 'none' : 'pricing.json';
  }

  const invalidReasons: string[] = [];
  let fallback = false;
  if (output.timedOut) invalidReasons.push(`timed out after ${ctx.opts.timeoutMin} min`);
  if (output.exitCode !== 0 && !output.timedOut) invalidReasons.push(`host exited with ${output.exitCode}`);
  if (parseError !== null) invalidReasons.push(`transcript not parsed: ${parseError}`);
  if (parsed !== null) {
    if (parsed.hostError !== null) invalidReasons.push(`host error: ${parsed.hostError}`);
    if (!ctx.opts.dryRun && parsed.model !== null && parsed.model !== model) invalidReasons.push(`model mismatch: ran ${parsed.model}, expected ${model}`);
    if (parsed.availableTools !== null) invalidReasons.push(...checkSurface(p.host, surfaceArm(p.arm), parsed.availableTools, taskTools));
    else if (!ctx.opts.dryRun) invalidReasons.push('tool surface not observed');
    if (p.host === 'claude' && !ctx.opts.dryRun) {
      if (parsed.hostContext === null) invalidReasons.push('Claude init event missing: isolation not observed');
      else invalidReasons.push(...claudeIsolationIssues(parsed.hostContext));
    }
    const arm = checkArm(p.host, surfaceArm(p.arm), parsed.toolCalls, taskTools);
    fallback = arm.fallback;
    invalidReasons.push(...arm.reasons);
    if (!ctx.opts.dryRun && parsed.mcpCalls !== null) invalidReasons.push(...checkMcpCalls(surfaceArm(p.arm), parsed.mcpCalls));
  }
  if (interactive) invalidReasons.push(...interactiveReasons(ctx.opts, p, output.interactive ?? null, facts, taskScriptTools(task)));
  // The agent must not reach the checkout's bench/tasks (hidden tests, solutions, the T16 server's generator).
  if (!ctx.opts.dryRun && output.stdout.includes(path.join(REPO_ROOT, 'bench', 'tasks'))) invalidReasons.push('the transcript names a path under bench/tasks: the agent reached the task sources');
  const notes: string[] = [];
  const sessionCost = facts?.sessionCost ?? null;
  if (interactive) {
    notes.push(
      'cost computed from the transcript usage (one entry per distinct model response) with pricing.json, cache writes priced by TTL; not the host-reported cost',
      sessionCost === null
        ? 'no session cost record (cost-state) in the transcript'
        : `host session cost (cost-state) $${sessionCost.totalUsd.toFixed(6)}, by model ${Object.entries(sessionCost.byModel).map(([m, u]) => `${m} $${u.costUSD.toFixed(6)}`).join(', ')}: it also counts requests outside the transcript (session title and other side calls), which are not in usage or cost`,
      'turns counted like -p num_turns: model tool calls plus one',
    );
    if (ctx.opts.interactivePilot && p.arm === 'A') notes.push('interactive pilot: arm A in an interactive session without Code Mode (diagnostic, not a matrix arm)');
  }

  const config = runConfig(ctx, p);
  const hash = configHash(config);
  const outDir = p.warmup === true ? warmupResultDir(ctx.resultsDir, ctx.invocation, p, hash) : runResultDir(ctx.resultsDir, p, hash);
  await mkdir(outDir, { recursive: true });
  const sctx: SanitizeContext = defaultSanitizeContext([
    { path: ws, label: '<workspace>' },
    { path: path.join(runWork, 'codex-home'), label: '<codex-home>' },
    { path: runWork, label: '<run>' },
    { path: REPO_ROOT, label: '<repo>' },
    { path: process.execPath, label: 'node' },
  ]);
  const files: Record<string, string> = {};
  const save = async (name: string, text: string): Promise<void> => {
    await writeFile(path.join(outDir, name), sanitize(text, sctx));
    files[name] = name;
  };
  await save('transcript.jsonl', output.stdout);
  await save('stderr.txt', output.stderr);
  if (output.requests !== null) await save('requests.jsonl', output.requests);
  for (const [name, text] of Object.entries(output.configs)) await save(name, text);
  const diff = workspaceDiff(ws);
  await save('diff.patch', `${diff.status}\n${diff.diff}`);

  const record: RunRecord = RunRecordSchema.parse({
    schema: 1,
    id,
    configHash: hash,
    config,
    host: p.host,
    arm: p.arm,
    armLabel: interactive && p.arm === 'A' ? `${ARM_LABELS.claude['A'] ?? 'A'} (interactive pilot)` : (ARM_LABELS[p.host][p.arm] ?? p.arm),
    warmup: p.warmup === true,
    task: p.task,
    run: p.run,
    round: p.round,
    orderIndex: p.orderIndex,
    dryRun: ctx.opts.dryRun,
    model,
    effort: p.host === 'claude' ? ctx.opts.claudeEffort : ctx.opts.codexEffort,
    startedAt,
    exitCode: output.exitCode,
    timedOut: output.timedOut,
    wallMs: output.wallMs,
    parsed: parsed === null ? null : { ...parsed, finalAnswer: sanitize(parsed.finalAnswer, sctx) },
    parseError,
    costUsd,
    costSource,
    verify: { pass: verify.pass, details: verify.details.map((d) => sanitize(d, sctx)) },
    fallback,
    valid: invalidReasons.length === 0,
    invalidReasons,
    files,
    hostSessionCostUsd: sessionCost?.totalUsd ?? null,
    notes,
  });
  // record.json last: its presence marks the run as done (resume skips it).
  await writeSanitized(path.join(outDir, 'record.json'), JSON.stringify(record), sctx);
  return record;
}

function gitInfo(): { commit: string | null; dirty: boolean | null } {
  const commit = tryExec('git', ['rev-parse', 'HEAD'], REPO_ROOT);
  const status = tryExec('git', ['status', '--porcelain', '--', 'src', 'package.json'], REPO_ROOT);
  return { commit, dirty: status === null ? null : status !== '' };
}

/** Platform, arch and kernel major.minor only: the full release string can name the distro or build. */
export function osLabel(platform: string = os.platform(), release: string = os.release(), arch: string = os.arch()): string {
  const m = /^(\d+)\.(\d+)/.exec(release);
  return `${platform} ${m ? `${m[1]}.${m[2]}` : 'unknown'} ${arch}`;
}

async function lastSeed(resultsDir: string): Promise<number | undefined> {
  try {
    const env = z.object({ invocations: z.array(z.object({ seed: z.number().int().nonnegative() }).passthrough()) }).safeParse(JSON.parse(await readFile(path.join(resultsDir, 'env.json'), 'utf8')));
    return env.success ? env.data.invocations.at(-1)?.seed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Adds to this invocation's environment block the tool surface each host/arm was observed with (Claude
 * init event, Codex prompt-input) next to the surface the arm-integrity check requires.
 */
async function recordSurfaces(resultsDir: string, observed: Record<string, string[]>): Promise<void> {
  const file = path.join(resultsDir, 'env.json');
  const parsed = z.object({ invocations: z.array(z.record(z.string(), z.unknown())).min(1) }).passthrough().safeParse(JSON.parse(await readFile(file, 'utf8')));
  if (!parsed.success) return;
  const invocations = [...parsed.data.invocations];
  const last = invocations.length - 1;
  invocations[last] = {
    ...invocations[last],
    surfaces: { observed, required: { claude: CLAUDE_ARM_SURFACE, codexNonFileTools: CODEX_COMMON_NON_FILE, codexFeaturesOff: CODEX_FEATURES_OFF } },
  };
  await writeSanitized(file, JSON.stringify({ ...parsed.data, invocations }), defaultSanitizeContext([{ path: REPO_ROOT, label: '<repo>' }]));
}

async function appendEnvironment(resultsDir: string, invocation: Record<string, unknown>): Promise<void> {
  const file = path.join(resultsDir, 'env.json');
  let invocations: unknown[] = [];
  try {
    const parsed = z.object({ invocations: z.array(z.unknown()) }).safeParse(JSON.parse(await readFile(file, 'utf8')));
    if (parsed.success) invocations = parsed.data.invocations;
  } catch {
    // first invocation for this date
  }
  const sctx = defaultSanitizeContext([{ path: REPO_ROOT, label: '<repo>' }]);
  await writeSanitized(file, JSON.stringify({ invocations: [...invocations, invocation] }), sctx);
}

function line(r: RunRecord): string {
  const u = r.parsed?.usage;
  const parts = [
    r.verify.pass ? 'pass' : 'FAIL',
    r.valid ? 'valid' : `INVALID (${r.invalidReasons.join('; ')})`,
    `${r.parsed?.requests ?? '?'} requests (${r.parsed?.turns ?? '?'} num_turns)`,
    u ? `in ${u.input} out ${u.output} cache w ${u.cacheCreation} r ${u.cacheRead}` : 'no usage',
    r.costUsd === null ? 'no cost' : `$${r.costUsd.toFixed(4)}`,
    `${(r.wallMs / 1000).toFixed(1)}s`,
    `calls native ${r.parsed?.toolCalls.native ?? 0} run ${r.parsed?.toolCalls.run ?? 0} exec ${r.parsed?.toolCalls.codeMode ?? 0}`,
    ...(r.parsed?.mcpCalls ? [`mcp direct ${r.parsed.mcpCalls.direct} script ${r.parsed.mcpCalls.script}`] : []),
    ...(r.parsed?.context ? [`context peak ${r.parsed.context.peak} last ${r.parsed.context.last}`] : []),
  ];
  if (r.fallback) parts.push('FALLBACK');
  return `${r.warmup ? 'warmup ' : ''}${r.host} ${r.task} ${r.arm} r${r.run}: ${parts.join(', ')}`;
}

export async function main(argv: readonly string[]): Promise<number> {
  const opts = parseOptions(argv);
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const workDir = path.resolve(opts.workDir);
  if (insideRepo(workDir)) {
    process.stderr.write(`--work-dir ${workDir} is inside the repository checkout; run workspaces there could read the hidden tests and solutions in bench/tasks. Use a directory outside it (default: ${defaultWorkDir()}).\n`);
    return 2;
  }
  installCleanupHandlers();
  for (const stale of sweepStaleHomes(workDir)) process.stderr.write(`removed a temp CODEX_HOME left by an interrupted run: ${path.relative(workDir, stale)}\n`);
  const resultsRoot = opts.out !== undefined ? path.resolve(opts.out) : opts.dryRun ? path.join(workDir, 'dry-run', 'results') : path.join(BENCH_DIR, 'results');
  const resultsDir = path.join(resultsRoot, date);
  // A dry run always starts clean (its results are throwaway, under the work dir).
  if (opts.dryRun && opts.out === undefined) await rm(resultsDir, { recursive: true, force: true });
  // Without --seed, a resume reuses the seed of the last invocation for this date (it is part of the config hash).
  const seed = opts.seed ?? (await lastSeed(resultsDir)) ?? Math.floor(Math.random() * 2 ** 31);
  const hosts: HostId[] = opts.host === 'all' ? ['claude', 'codex'] : [opts.host];
  const tasks: TaskId[] = opts.tasks ?? [...DEFAULT_TASK_IDS];
  const withBaseline = opts.acmRef !== undefined || opts.acmDist !== undefined;
  const baselineArms: BenchArm[] = [BASELINE_ARMS.claude, BASELINE_ARMS.codex];
  if (!withBaseline && opts.arms?.some((a) => baselineArms.includes(a))) {
    process.stderr.write('arms B0/C0 run a baseline build: pass --acm-ref <commit> or --acm-dist <dir>\n');
    return 2;
  }
  if (opts.interactivePilot && (opts.host !== 'claude' || opts.arms === undefined || opts.arms.some((a) => a !== 'A') || opts.dryRun)) {
    process.stderr.write('--interactive-pilot runs Claude arm A only, for real: pass --host claude --arms A without --dry-run\n');
    return 2;
  }
  // A task's MCP server is wired for Claude only (agent-code-mode's mcpCall needs the Claude host).
  const plan = planRuns(hosts, tasks, opts.arms, opts.runs, seed, withBaseline).filter((p) => p.host === 'claude' || TASKS[p.task].mcpServer === undefined);
  const skippedMcp = tasks.filter((t) => TASKS[t].mcpServer !== undefined);
  if (hosts.includes('codex') && skippedMcp.length > 0) process.stderr.write(`${skippedMcp.join(', ')}: Claude host only (MCP task); no Codex runs for it\n`);
  if (plan.length === 0) {
    process.stderr.write('nothing to run: no arm of the chosen hosts matches --arms\n');
    return 2;
  }
  let baseline: AcmBuild | null = null;
  if (withBaseline && plan.some((p) => baselineArms.includes(p.arm))) {
    try {
      baseline = await resolveBaseline(opts, workDir);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      return 2;
    }
  }

  const serverEntry = path.join(REPO_ROOT, 'dist', 'cli.js');
  const needsServer = plan.some((p) => p.arm !== 'B0' && p.arm !== 'C0' && isAcmArm(p.host, p.arm));
  if (!opts.dryRun && needsServer && !(await exists(serverEntry))) {
    process.stderr.write('agent-code-mode arms need the built server: run `npm run build` first\n');
    return 2;
  }

  let rawCatalog: string | null = null;
  const versions: Record<string, string | null> = {};
  if (hosts.includes('claude')) versions['claude'] = opts.dryRun ? null : tryExec('claude', ['--version']);
  if (hosts.includes('codex')) {
    versions['codex'] = opts.dryRun ? null : tryExec('codex', ['--version']);
    if (opts.dryRun) {
      rawCatalog = await readFile(path.join(PARSER_FIXTURES, 'codex-catalog.json'), 'utf8');
    } else {
      const home = path.join(workDir, `codex-catalog-home-${process.pid}`);
      createCodexHome(home, sourceCodexHome());
      try {
        rawCatalog = execFileSync('codex', ['debug', 'models'], { encoding: 'utf8', env: hostEnv({ CODEX_HOME: home }), timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
      } finally {
        removeCodexHome(home);
      }
    }
    if (!catalogHasModel(rawCatalog, opts.codexModel)) {
      process.stderr.write(`codex model ${opts.codexModel} is not in the Codex model catalog\n`);
      return 2;
    }
  }
  const needsTmux = plan.some((p) => isInteractive(opts, p));
  let tmux: string | null = null;
  if (needsTmux && !opts.dryRun) {
    tmux = tmuxVersion();
    if (tmux === null) {
      process.stderr.write('interactive Claude runs (arm D, --interactive-pilot) need tmux on PATH\n');
      return 2;
    }
    for (const stale of sweepStaleTmuxServers()) process.stderr.write(`killed a tmux server left by an interrupted run: ${stale}\n`);
  }
  for (const h of hosts) {
    if (!opts.dryRun && versions[h] === null) {
      process.stderr.write(`${h} CLI not found on PATH\n`);
      return 2;
    }
  }

  await mkdir(resultsDir, { recursive: true });
  const claudeCredentials = await exists(path.join(sourceClaudeConfig(), '.credentials.json'));
  const git = gitInfo();
  await appendEnvironment(resultsDir, {
    startedAt: new Date().toISOString(),
    dryRun: opts.dryRun,
    seed,
    fixtureSeed: opts.fixtureSeed,
    fixtureSha256: treeHash(generateFixture(opts.fixtureSeed).files),
    runsPerArm: opts.runs,
    tasks,
    arms: opts.arms ?? 'all',
    schedule: 'paired blocks (every arm of a host x task back to back), arm order rotated per round from a seeded base order',
    warmup: `one ${WARMUP_TASK} run per host x arm before the matrix, kept under warmup/ and out of the statistics`,
    baseline: baseline === null ? null : { id: baseline.id, arms: Object.values(BASELINE_ARMS) },
    timeoutMin: opts.timeoutMin,
    hosts: Object.fromEntries(
      hosts.map((h) => [
        h,
        h === 'claude'
          ? { version: versions['claude'], model: opts.claudeModel, effort: opts.claudeEffort, maxTurns: opts.maxTurns, isolation: claudeIsolationMethod(claudeCredentials), ...(needsTmux ? { interactiveDriver: INTERACTIVE_DRIVER, tmux, interactivePilot: opts.interactivePilot } : {}) }
          : { version: versions['codex'], model: opts.codexModel, effort: opts.codexEffort, maxTurns: null, catalogSha256: rawCatalog === null ? null : sha256(rawCatalog) },
      ]),
    ),
    os: osLabel(),
    node: process.version,
    agentCodeModeCommit: git.commit,
    agentCodeModeDirty: git.dirty,
  });

  const invocation = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const ctx: Context = { opts: { ...opts, workDir }, date, resultsDir, pricing: loadPricing(), serverEntry, rawCatalog, seed, versions, git, baseline, invocation };
  const pending: PlannedRun[] = [];
  for (const p of plan) {
    const hash = configHash(runConfig(ctx, p));
    if (!opts.force && (await exists(path.join(runResultDir(resultsDir, p, hash), 'record.json')))) process.stdout.write(`skip ${runId(p)} (already recorded with config ${hash})\n`);
    else pending.push(p);
  }
  // Warm every arm of every host that still has runs, the same way, so no arm starts on a cold cache.
  const warmHosts = new Set(pending.map((p) => p.host));
  const warmup = pending.length === 0 ? [] : planWarmup(plan.filter((p) => warmHosts.has(p.host)), seed);
  process.stdout.write(`${opts.dryRun ? 'DRY RUN ' : ''}${pending.length} runs (+${warmup.length} warmup), seed ${seed}, results in ${path.relative(process.cwd(), resultsDir) || resultsDir}\n`);
  let failures = 0;
  const surfaces = new Map<string, string[]>();
  for (const p of [...warmup, ...pending]) {
    try {
      const record = await executeRun(ctx, p);
      const tools = record.parsed?.availableTools;
      if (tools && !surfaces.has(`${p.host}/${p.arm}`)) surfaces.set(`${p.host}/${p.arm}`, [...tools].sort());
      process.stdout.write(`${line(record)}\n`);
    } catch (err) {
      failures += 1;
      process.stderr.write(`${runId(p)}: harness error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    }
  }
  if (surfaces.size > 0) await recordSurfaces(resultsDir, Object.fromEntries(surfaces));
  const { markdown } = await writeReport(resultsDir);
  // Final pass over everything written for commit, whatever wrote it.
  await sanitizeTree(resultsDir, defaultSanitizeContext([{ path: ctx.opts.workDir, label: '<work>' }, { path: REPO_ROOT, label: '<repo>' }, { path: process.execPath, label: 'node' }]));
  process.stdout.write(`\n${markdown}`);
  return failures === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`bench: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 2;
    },
  );
}
