import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { generateFixture, treeHash, DEFAULT_FIXTURE_SEED } from './fixture/generate.ts';
import { claudeArgs, claudeIsolationIssues, claudeMcpConfig, parseClaudeTranscript } from './lib/claude.ts';
import { catalogForArm, CODEX_FEATURES_OFF, EMPTY_MCP_SERVER, catalogHasModel, codexArgs, codexConfigToml, codexHooksJson, codexToolSurface, extractCodexRequests, parseCodexTranscript } from './lib/codex.ts';
import { createCodexHome, installCleanupHandlers, removeCodexHome, sweepStaleHomes } from './lib/codex-home.ts';
import { costFromUsage, loadPricing, type Pricing } from './lib/pricing.ts';
import { runProcess } from './lib/proc.ts';
import { ARM_LABELS, BASELINE_ARMS, BENCH_ARMS, checkArm, checkSurface, CLAUDE_ARM_SURFACE, CODEX_COMMON_NON_FILE, hostArms, isAcmArm, RunRecordSchema, surfaceArm, type ArmId, type BenchArm, type ParsedRun, type RunRecord } from './lib/record.ts';
import { Rng } from './lib/rng.ts';
import { defaultSanitizeContext, sanitize, type SanitizeContext } from './lib/sanitize.ts';
import { claudeProjectSettings, CODEX_HOOK_MATCHER, companionHookCommand, createWorkspace, hookCommand, initialTree, workspaceDiff, type HostId } from './lib/workspace.ts';
import { writeReport } from './report.ts';
import { TASKS } from './tasks/index.ts';
import { TASK_IDS, type TaskId } from './tasks/types.ts';

/**
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
 * Paired schedule: each round has one block per host x task in a seeded order, and a block runs every arm
 * of that host on that task back to back. Inside a block the arm order is a seeded base order rotated by
 * one place per round, so over any `arms` consecutive rounds each arm takes each position once.
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
  /** The build has the Claude companion hook (`cli.js hook`), so its arm gets the hook its installer adds. */
  readonly companionHook: boolean;
}

/** The agent-code-mode server an arm runs: the baseline build for B0/C0, this checkout's dist otherwise. */
function serverEntryFor(ctx: Context, arm: BenchArm): string {
  if (arm === 'B0' || arm === 'C0') {
    if (ctx.baseline === null) throw new Error(`arm ${arm} needs --acm-ref or --acm-dist`);
    return ctx.baseline.entry;
  }
  return ctx.serverEntry;
}

/** The companion hook of a Claude arm that runs `run`, from the same build as its server. */
function companionHookFor(ctx: Context, host: HostId, arm: BenchArm, serverEntry: string): string | undefined {
  if (host !== 'claude' || !isAcmArm(host, arm)) return undefined;
  if (arm === 'B0' && ctx.baseline?.companionHook !== true) return undefined;
  return companionHookCommand(serverEntry);
}

/** True when `cli.js hook` exits 0 on an input it ignores; a build without the command exits non-zero. */
function hasCompanionHook(entry: string): boolean {
  if (!existsSync(entry)) return false;
  try {
    execFileSync(process.execPath, [entry, 'hook'], { input: '{}', stdio: ['pipe', 'ignore', 'ignore'], timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
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
    return { id: `dist:${(await dirHash(dir)).slice(0, 12)}`, entry, companionHook: hasCompanionHook(entry) };
  }
  if (opts.acmRef === undefined) return null;
  const commit = tryExec('git', ['rev-parse', '--verify', '--quiet', `${opts.acmRef}^{commit}`], REPO_ROOT);
  if (commit === null || commit === '') throw new Error(`--acm-ref ${opts.acmRef} is not a commit of this repository`);
  const dir = path.join(workDir, 'acm-builds', commit);
  const entry = path.join(dir, 'dist', 'cli.js');
  const build = (): AcmBuild => ({ id: `ref:${commit.slice(0, 12)}`, entry, companionHook: hasCompanionHook(entry) });
  // A build made before bench/ was left out of the archive would hold hidden tests next to the runs.
  if ((await exists(path.join(dir, 'bench'))) || (await exists(path.join(dir, 'test')))) await rm(dir, { recursive: true, force: true });
  if (opts.dryRun || (await exists(path.join(dir, '.built')))) return build();
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
  return build();
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

function armDefinition(ctx: Context, p: Pick<PlannedRun, 'host' | 'task' | 'arm'>): string {
  const task = TASKS[p.task];
  const arm = surfaceArm(p.arm);
  const fixture = generateFixture(ctx.opts.fixtureSeed);
  let def: unknown;
  if (p.host === 'claude') {
    def = {
      args: claudeArgs({ arm, model: ctx.opts.claudeModel, effort: ctx.opts.claudeEffort, maxTurns: ctx.opts.maxTurns, settingsFile: '<settings>', mcpConfigFile: '<mcp>' }),
      settings: claudeProjectSettings(task, fixture, companionHookFor(ctx, p.host, p.arm, '<server>')),
      mcp: claudeMcpConfig(arm, '<server>'),
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
  };
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
  readonly configs: Record<string, string>;
  readonly availableTools?: string[] | null;
}

async function cannedTranscript(host: HostId, arm: ArmId): Promise<{ stdout: string; requests: string | null }> {
  const base = path.join(PARSER_FIXTURES, `${host}-${arm}`);
  const stdout = await readFile(`${base}.jsonl`, 'utf8');
  const requests = host === 'codex' ? await readFile(`${base}.requests.jsonl`, 'utf8') : null;
  return { stdout, requests };
}

async function runClaude(ctx: Context, p: PlannedRun, runWork: string, ws: string): Promise<HostOutput> {
  const task = TASKS[p.task];
  const fixture = generateFixture(ctx.opts.fixtureSeed);
  const settingsFile = path.join(runWork, 'claude-settings.json');
  const mcpConfigFile = path.join(runWork, 'mcp-config.json');
  const settings = `${JSON.stringify(claudeProjectSettings(task, fixture, companionHookFor(ctx, p.host, p.arm, serverEntryFor(ctx, p.arm))), null, 2)}\n`;
  const arm = surfaceArm(p.arm);
  const mcp = `${JSON.stringify(claudeMcpConfig(arm, serverEntryFor(ctx, p.arm)), null, 2)}\n`;
  await writeFile(settingsFile, settings);
  await writeFile(mcpConfigFile, mcp);
  const args = claudeArgs({ arm, model: ctx.opts.claudeModel, effort: ctx.opts.claudeEffort, maxTurns: ctx.opts.maxTurns, settingsFile, mcpConfigFile });
  const configs: Record<string, string> = { 'claude-settings.json': settings, 'mcp-config.json': mcp, 'command.txt': `claude ${args.map((a) => (a === '' ? '""' : a)).join(' ')}\n` };
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
    configs['auth.txt'] = `auth.json: ${removeCodexHome(codexHome)}\n`;
    return { stdout: await readFile(stdoutFile, 'utf8'), stderr: await readFile(stderrFile, 'utf8'), requests: rollouts.length > 0 ? requests : null, ...outcome, configs, availableTools };
  } finally {
    removeCodexHome(codexHome);
  }
}

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

  let parsed: ParsedRun | null = null;
  let parseError: string | null = null;
  try {
    parsed = p.host === 'claude' ? parseClaudeTranscript(output.stdout) : parseCodexTranscript(output.stdout, output.requests);
    if (parsed.availableTools === null && output.availableTools) parsed = { ...parsed, availableTools: output.availableTools };
  } catch (err) {
    parseError = err instanceof Error ? err.message : String(err);
  }
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
    if (parsed.availableTools !== null) invalidReasons.push(...checkSurface(p.host, surfaceArm(p.arm), parsed.availableTools));
    else if (!ctx.opts.dryRun) invalidReasons.push('tool surface not observed');
    if (p.host === 'claude' && !ctx.opts.dryRun) {
      if (parsed.hostContext === null) invalidReasons.push('Claude init event missing: isolation not observed');
      else invalidReasons.push(...claudeIsolationIssues(parsed.hostContext));
    }
    const arm = checkArm(p.host, surfaceArm(p.arm), parsed.toolCalls);
    fallback = arm.fallback;
    invalidReasons.push(...arm.reasons);
  }

  const config = runConfig(ctx, p);
  const hash = configHash(config);
  const outDir = p.warmup === true ? warmupResultDir(ctx.resultsDir, ctx.invocation, p, hash) : runResultDir(ctx.resultsDir, p, hash);
  await mkdir(outDir, { recursive: true });
  const sctx: SanitizeContext = defaultSanitizeContext([
    { path: ws, label: '<workspace>' },
    { path: path.join(runWork, 'codex-home'), label: '<codex-home>' },
    { path: runWork, label: '<run>' },
    ...(ctx.baseline === null ? [] : [{ path: path.dirname(ctx.baseline.entry), label: '<baseline>' }]),
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
    armLabel: ARM_LABELS[p.host][p.arm] ?? p.arm,
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
    parsed: parsed === null ? null : JSON.parse(sanitize(JSON.stringify(parsed), sctx)),
    parseError: parseError === null ? null : sanitize(parseError, sctx),
    costUsd,
    costSource,
    verify: { pass: verify.pass, details: verify.details.map((d) => sanitize(d, sctx)) },
    fallback,
    valid: invalidReasons.length === 0,
    invalidReasons: invalidReasons.map((r) => sanitize(r, sctx)),
    files,
  });
  await markRunDone(outDir, record);
  return record;
}

/** Writes the run's record after every other artifact: a run with a record is done, and resume skips it. */
async function markRunDone(outDir: string, record: RunRecord): Promise<void> {
  await writeFile(path.join(outDir, 'record.json'), `${JSON.stringify(record, null, 2)}\n`);
}

function gitInfo(): { commit: string | null; dirty: boolean | null } {
  const commit = tryExec('git', ['rev-parse', 'HEAD'], REPO_ROOT);
  const status = tryExec('git', ['status', '--porcelain', '--', 'src', 'package.json'], REPO_ROOT);
  return { commit, dirty: status === null ? null : status !== '' };
}

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
  await writeFile(file, `${JSON.stringify({ ...parsed.data, invocations }, null, 2)}\n`);
}

async function appendEnvironment(resultsDir: string, invocation: Record<string, unknown>): Promise<void> {
  const file = path.join(resultsDir, 'env.json');
  let invocations: unknown[] = [];
  try {
    const parsed = z.object({ invocations: z.array(z.unknown()) }).safeParse(JSON.parse(await readFile(file, 'utf8')));
    if (parsed.success) invocations = parsed.data.invocations;
  } catch {
  }
  const sctx = defaultSanitizeContext([{ path: REPO_ROOT, label: '<repo>' }]);
  await writeFile(file, sanitize(`${JSON.stringify({ invocations: [...invocations, invocation] }, null, 2)}\n`, sctx));
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
  if (opts.dryRun && opts.out === undefined) await rm(resultsDir, { recursive: true, force: true });
  const seed = opts.seed ?? (await lastSeed(resultsDir)) ?? Math.floor(Math.random() * 2 ** 31);
  const hosts: HostId[] = opts.host === 'all' ? ['claude', 'codex'] : [opts.host];
  const tasks: TaskId[] = opts.tasks ?? [...TASK_IDS];
  const withBaseline = opts.acmRef !== undefined || opts.acmDist !== undefined;
  const baselineArms: BenchArm[] = [BASELINE_ARMS.claude, BASELINE_ARMS.codex];
  if (!withBaseline && opts.arms?.some((a) => baselineArms.includes(a))) {
    process.stderr.write('arms B0/C0 run a baseline build: pass --acm-ref <commit> or --acm-dist <dir>\n');
    return 2;
  }
  const plan = planRuns(hosts, tasks, opts.arms, opts.runs, seed, withBaseline);
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
  if (!opts.dryRun && process.platform === 'win32' && plan.some((p) => isAcmArm(p.host, p.arm))) {
    process.stderr.write('agent-code-mode arms do not run on Windows, where run refuses file operations (#28): pick native arms with --arms\n');
    return 2;
  }
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
    baseline: baseline === null ? null : { id: baseline.id, companionHook: baseline.companionHook, arms: Object.values(BASELINE_ARMS) },
    timeoutMin: opts.timeoutMin,
    hosts: Object.fromEntries(
      hosts.map((h) => [
        h,
        h === 'claude'
          ? { version: versions['claude'], model: opts.claudeModel, effort: opts.claudeEffort, maxTurns: opts.maxTurns, isolation: claudeIsolationMethod(claudeCredentials) }
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
    const recordFile = path.join(runResultDir(resultsDir, p, hash), 'record.json');
    if (!opts.force && (await exists(recordFile))) {
      process.stdout.write(`skip ${runId(p)} (already recorded with config ${hash})\n`);
      continue;
    }
    // A forced rerun drops the old record first, so a run that fails now cannot pass on the old one.
    await rm(recordFile, { force: true });
    pending.push(p);
  }
  // Every arm of a host that still has runs gets the same warmup, so no arm starts on a cold cache.
  const warmHosts = new Set(pending.map((p) => p.host));
  const warmup = pending.length === 0 ? [] : planWarmup(plan.filter((p) => warmHosts.has(p.host)), seed);
  process.stdout.write(`${opts.dryRun ? 'DRY RUN ' : ''}${pending.length} runs (+${warmup.length} warmup), seed ${seed}, results in ${path.relative(process.cwd(), resultsDir) || resultsDir}\n`);
  const surfaces = new Map<string, string[]>();
  for (const p of [...warmup, ...pending]) {
    try {
      const record = await executeRun(ctx, p);
      const tools = record.parsed?.availableTools;
      if (tools && !surfaces.has(`${p.host}/${p.arm}`)) surfaces.set(`${p.host}/${p.arm}`, [...tools].sort());
      process.stdout.write(`${line(record)}\n`);
    } catch (err) {
      process.stderr.write(`${runId(p)}: harness error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    }
  }
  if (surfaces.size > 0) await recordSurfaces(resultsDir, Object.fromEntries(surfaces));
  const { markdown } = await writeReport(resultsDir);
  process.stdout.write(`\n${markdown}`);
  const problems = await planProblems(ctx, [...warmup, ...plan]);
  for (const problem of problems) process.stderr.write(`${problem}\n`);
  return problems.length === 0 ? 0 : 1;
}

async function planProblems(ctx: Context, plan: readonly PlannedRun[]): Promise<string[]> {
  const problems: string[] = [];
  for (const p of plan) {
    const hash = configHash(runConfig(ctx, p));
    const recordFile = path.join(p.warmup === true ? warmupResultDir(ctx.resultsDir, ctx.invocation, p, hash) : runResultDir(ctx.resultsDir, p, hash), 'record.json');
    let record: RunRecord;
    try {
      record = RunRecordSchema.parse(JSON.parse(await readFile(recordFile, 'utf8')));
    } catch (err) {
      problems.push(`${runId(p)}: no usable record (${err instanceof Error ? err.message.split('\n')[0] : String(err)})`);
      continue;
    }
    if (!ctx.opts.dryRun) continue;
    if (!record.verify.pass) problems.push(`${runId(p)}: dry run failed verification: ${record.verify.details.join('; ')}`);
    if (!record.valid) problems.push(`${runId(p)}: dry run invalid: ${record.invalidReasons.join('; ')}`);
  }
  return problems;
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
