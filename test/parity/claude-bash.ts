import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { createCodexHome, removeCodexHome } from '../../bench/lib/codex-home.ts';
import { runProcess } from '../../bench/lib/proc.ts';
import { defaultSanitizeContext, sanitize } from '../../bench/lib/sanitize.ts';
import type { PreparedCall } from '../../src/core/types.js';
import { ClaudeHostAdapter } from '../../src/hosts/claude/adapter.js';
import { makeContext } from '../../src/testing/index.js';

/** Strictest last: a row where the adapter's verdict ranks below the host's is looser than the host. */
export const VERDICTS = ['allow', 'ask', 'deny'] as const;
export type Verdict = (typeof VERDICTS)[number];

/** Plan mode is left out: under it the model refuses to issue the writes, so no host decision can be observed. */
export type Mode = 'default' | 'acceptEdits' | 'dontAsk' | 'bypassPermissions';

/** A settings configuration. Strings may hold `{project}` and `{outside}`, filled in per world. */
export interface Setup {
  readonly id: string;
  readonly mode: Mode;
  readonly settings: Readonly<Record<string, unknown>>;
}

function rules(allow: string[] = [], ask: string[] = [], deny: string[] = []): Record<string, unknown> {
  return { permissions: { allow, ask, deny } };
}

const SANDBOX = { enabled: true };
/** Measured on 2.1.332: the host auto-allows sandboxed commands only when the key is set to true, not when it is absent. */
const AUTO = { enabled: true, autoAllowBashIfSandboxed: true };
const EXACT_RULES = rules(['Bash(touch new.txt)', 'Bash(mkdir -p {outside}/m)', 'Bash(echo x > .mcp.json)', 'Bash(echo a && touch g.txt)', 'Bash(cat /etc/hostname)']);
const PREFIX_RULES = rules(['Bash(echo:*)', 'Bash(ls:*)', 'Bash(cat:*)', 'Bash(touch:*)', 'Bash(mkdir:*)'], ['Bash(cp:*)'], ['Bash(rm:*)']);

export const SETUPS: readonly Setup[] = [
  { id: 'none', mode: 'default', settings: rules() },
  { id: 'allow-all', mode: 'default', settings: rules(['Bash']) },
  { id: 'prefix', mode: 'default', settings: PREFIX_RULES },
  { id: 'exact', mode: 'default', settings: EXACT_RULES },
  { id: 'accept-edits', mode: 'acceptEdits', settings: rules() },
  { id: 'dont-ask', mode: 'dontAsk', settings: rules(['Bash(echo:*)']) },
  { id: 'bypass', mode: 'bypassPermissions', settings: rules() },
  { id: 'sbx', mode: 'default', settings: { ...rules(), sandbox: SANDBOX } },
  { id: 'sbx-allow-all', mode: 'default', settings: { ...rules(['Bash']), sandbox: SANDBOX } },
  { id: 'sbx-auto', mode: 'default', settings: { ...rules(), sandbox: AUTO } },
  { id: 'sbx-auto-exact', mode: 'default', settings: { ...EXACT_RULES, sandbox: AUTO } },
  { id: 'sbx-auto-prefix', mode: 'default', settings: { ...PREFIX_RULES, sandbox: AUTO } },
  { id: 'sbx-auto-excluded', mode: 'default', settings: { ...rules(), sandbox: { ...AUTO, excludedCommands: ['touch'] } } },
  { id: 'sbx-auto-accept-edits', mode: 'acceptEdits', settings: { ...rules(), sandbox: AUTO } },
  { id: 'sbx-auto-dont-ask', mode: 'dontAsk', settings: { ...rules(), sandbox: AUTO } },
  { id: 'sbx-auto-bypass', mode: 'bypassPermissions', settings: { ...rules(), sandbox: AUTO } },
  { id: 'sbx-noauto', mode: 'default', settings: { ...rules(), sandbox: { ...SANDBOX, autoAllowBashIfSandboxed: false } } },
  { id: 'sbx-noauto-allow-all', mode: 'default', settings: { ...rules(['Bash']), sandbox: { ...SANDBOX, autoAllowBashIfSandboxed: false } } },
];

/**
 * Every setup runs every command, in a fresh world: a git project holding
 * the files below and `link-out`, a symlink to a directory outside it. Each
 * command touches its own files and is harmless when it runs: it writes only
 * inside the world's temporary directories.
 */
export const COMMANDS: readonly string[] = [
  'echo hi',
  'ls',
  'cat a.txt',
  'cat {outside}/secret.txt',
  'git status',
  'cat link-out/secret.txt',
  'cat /etc/hostname',
  'pwd',
  'wc -l a.txt',
  'grep a a.txt',
  'sort a.txt',
  'find . -name a.txt',
  'git log -1',
  'ls {outside}',
  'head -n1 {outside}/secret.txt',
  'echo $HOME',
  'echo $(pwd)',
  'cat a.txt > /dev/null',
  'ls | grep a',
  'node -e 0',
  'python3 -c 0',
  'git add a.txt',
  'chmod +x j.txt',
  'ln -s a.txt ln.txt',
  'touch new.txt',
  'mkdir -p d/e',
  'echo x > out.txt',
  'cp a.txt b.txt',
  'mv c.txt moved.txt',
  'rm -f f.txt',
  'sed -i s/a/b/ e.txt',
  'printf %s hi > {project}/abs.txt',
  'mkdir -p {outside}/m',
  'touch {outside}/t.txt',
  'echo x > {outside}/w.txt',
  'rm -f {outside}/r.txt',
  'echo x > .git/info/note',
  'echo x >> .bashrc',
  'echo x > .claude/note.txt',
  'echo x > .mcp.json',
  'touch .gitconfig',
  'echo x > {outside}/.npmrc',
  'echo x > link-out/via-link.txt',
  'X={outside}/v.txt; echo x > "$X"',
  'echo x > "$(echo {outside})/sub.txt"',
  'cd {outside} && echo x > rel.txt',
  'cd sub && touch made.txt',
  'echo a && touch g.txt',
  'echo a | tee h.txt',
  'ls; rm -f i.txt',
];

export interface World {
  readonly base: string;
  readonly project: string;
  readonly outside: string;
  /** For the adapter: a home whose `.claude.json` trusts the project, as `claude -p` does. */
  readonly home: string;
}

export function fill(template: string, world: World): string {
  return template.replaceAll('{project}', world.project).replaceAll('{outside}', world.outside);
}

function fillDeep(value: unknown, world: World): unknown {
  if (typeof value === 'string') return fill(value, world);
  if (Array.isArray(value)) return value.map((v) => fillDeep(v, world));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillDeep(v, world)]));
  return value;
}

/** Replaces the world's paths with their placeholders: what gets recorded never names a real directory. */
export function unfill(text: string, world: World): string {
  return text.replaceAll(world.project, '{project}').replaceAll(world.outside, '{outside}').replaceAll(world.base, '{base}');
}

export async function makeWorld(setup: Setup): Promise<World> {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'acm-parity-')));
  const world: World = { base, project: path.join(base, 'project'), outside: path.join(base, 'outside'), home: path.join(base, 'home') };
  await mkdir(path.join(world.project, '.claude'), { recursive: true });
  await mkdir(path.join(world.project, 'sub'), { recursive: true });
  await mkdir(world.outside, { recursive: true });
  await mkdir(path.join(world.home, '.claude'), { recursive: true });
  for (const name of ['a.txt', 'c.txt', 'e.txt', 'f.txt', 'i.txt', 'j.txt']) await writeFile(path.join(world.project, name), 'a\n');
  await writeFile(path.join(world.outside, 'secret.txt'), 'outside\n');
  await writeFile(path.join(world.outside, 'r.txt'), 'r\n');
  await symlink(world.outside, path.join(world.project, 'link-out'));
  execFileSync('git', ['init', '-q', world.project]);
  await writeFile(path.join(world.project, '.claude', 'settings.json'), `${JSON.stringify(fillDeep(setup.settings, world), null, 2)}\n`);
  await writeFile(path.join(world.home, '.claude.json'), JSON.stringify({ projects: { [world.project]: { hasTrustDialogAccepted: true } } }));
  return world;
}

export async function removeWorld(world: World): Promise<void> {
  await rm(world.base, { recursive: true, force: true });
}

/** The adapter's verdict on each command, as `run` would reach it: the static check, then the (empty) hooks. */
export async function adapterVerdicts(setup: Setup): Promise<Verdict[]> {
  const world = await makeWorld(setup);
  try {
    const adapter = new ClaudeHostAdapter({
      env: {},
      home: world.home,
      managedDir: null,
      stateDir: path.join(world.base, 'state'),
      readParent: async () => ({ argv: ['claude', '-p', '--permission-mode', setup.mode, '--setting-sources', 'project', '--tools', 'Bash'], cwd: world.project }),
    });
    const ctx = makeContext(world.project, { host: 'claude', sources: { cwd: 'roots' } });
    const policy = await adapter.loadPolicy(ctx);
    if ('error' in policy) throw new Error(`${setup.id}: ${policy.error}`);
    const out: Verdict[] = [];
    for (const template of COMMANDS) {
      const command = fill(template, world);
      const prepared: PreparedCall = {
        id: 'c1',
        tool: 'bash',
        args: { command, cwd: world.project, timeoutMs: 120_000 },
        effect: { command, shell: { path: '/bin/bash', args: ['-c'] }, cwd: world.project, timeoutMs: 120_000, containment: policy.bashContainment },
      };
      const decision = adapter.checkStatic(prepared, ctx, policy);
      out.push(decision.kind === 'allow' ? (await adapter.authorize(prepared, ctx, policy, new AbortController().signal)).kind : decision.kind);
    }
    return out;
  } finally {
    await removeWorld(world);
  }
}


export const HOST_MODEL = 'claude-haiku-5-5';

const SYSTEM_PROMPT = [
  'You run shell commands for a permission test.',
  'The user lists numbered commands. For each one, in order, call the Bash tool once with that exact command string, byte for byte.',
  'Never change, combine, quote or split a command, never set dangerouslyDisableSandbox, and never run anything else.',
  'If a call is denied, fails or errors, do not retry it and do not work around it: go on with the next command.',
  'After the last command, reply with the single word DONE.',
].join(' ');

export const HostRowSchema = z.object({
  setup: z.string(),
  command: z.string(),
  host: z.enum(VERDICTS),
  message: z.string().optional(),
});
export type HostRow = z.infer<typeof HostRowSchema>;

export const HostHeaderSchema = z.object({
  claudeCode: z.string(),
  model: z.string(),
  platform: z.string(),
  recorded: z.string(),
  costUsd: z.number(),
});
export type HostHeader = z.infer<typeof HostHeaderSchema>;

const ToolUse = z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.record(z.string(), z.unknown()) });
const ToolResult = z.object({ type: z.literal('tool_result'), tool_use_id: z.string(), content: z.unknown(), is_error: z.boolean().optional() });
const Message = z.object({ type: z.enum(['assistant', 'user']), message: z.object({ content: z.union([z.string(), z.array(z.unknown())]) }) });
const Result = z.object({
  type: z.literal('result'),
  total_cost_usd: z.number(),
  permission_denials: z.array(z.object({ tool_use_id: z.string() })).default([]),
});

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (typeof c === 'object' && c !== null && 'text' in c && typeof c.text === 'string' ? c.text : '')).join('');
}

/** How Claude Code words a deny-rule refusal; any other refusal of a `-p` call is a question nobody could answer. */
const DENIED = /has been denied/;

export interface ParsedHostRun {
  readonly costUsd: number;
  /** Per command: the verdict, or undefined when the model never issued it as written. */
  readonly rows: readonly ({ verdict: Verdict; message: string | undefined } | undefined)[];
}

export function parseHostTranscript(text: string, commands: readonly string[]): ParsedHostRun {
  const uses = new Map<string, string>();
  const results = new Map<string, string>();
  let result: z.infer<typeof Result> | undefined;
  for (const line of text.split('\n')) {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }
    const r = Result.safeParse(json);
    if (r.success) result = r.data;
    const m = Message.safeParse(json);
    if (!m.success || typeof m.data.message.content === 'string') continue;
    for (const block of m.data.message.content) {
      const use = ToolUse.safeParse(block);
      if (use.success && use.data.name === 'Bash' && typeof use.data.input['command'] === 'string' && use.data.input['dangerouslyDisableSandbox'] !== true) {
        const command = use.data.input['command'];
        if (![...uses.values()].includes(command)) uses.set(use.data.id, command);
      }
      const res = ToolResult.safeParse(block);
      if (res.success) results.set(res.data.tool_use_id, resultText(res.data.content));
    }
  }
  if (result === undefined) throw new Error('the transcript has no result event');
  const denied = new Set(result.permission_denials.map((d) => d.tool_use_id));
  const rows = commands.map((command) => {
    const id = [...uses].find(([, c]) => c === command)?.[0];
    if (id === undefined || !results.has(id)) return undefined;
    if (!denied.has(id)) return { verdict: 'allow' as const, message: undefined };
    const message = results.get(id) ?? '';
    return { verdict: DENIED.test(message) ? ('deny' as const) : ('ask' as const), message };
  });
  return { costUsd: result.total_cost_usd, rows };
}

function sourceClaudeConfig(): string {
  const env = process.env['CLAUDE_CONFIG_DIR'];
  return env !== undefined && env !== '' && path.isAbsolute(env) ? env : path.join(os.homedir(), '.claude');
}

function hostEnv(configDir?: string): Record<string, string | undefined> {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN'];
  const env: Record<string, string | undefined> = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return {
    ...env,
    TERM: 'dumb',
    NO_COLOR: '1',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    ...(configDir === undefined ? {} : { CLAUDE_CONFIG_DIR: configDir }),
  };
}

export function claudeVersion(): string {
  return execFileSync('claude', ['--version'], { encoding: 'utf8', env: hostEnv() }).trim();
}

/**
 * Runs the given commands of one setup through `claude -p` in a fresh world:
 * project settings only, the Bash tool only, the user's config replaced by a
 * temporary directory holding a copy of the credentials file (written back if
 * refreshed, as the benchmark does).
 */
export async function hostRun(setup: Setup, commands: readonly string[], maxTurns: number): Promise<{ parsed: ParsedHostRun; world: World; transcript: string }> {
  const world = await makeWorld(setup);
  const configDir = path.join(world.base, 'claude-config');
  const isolated = await readFile(path.join(sourceClaudeConfig(), '.credentials.json')).then(() => true, () => false);
  // A trusted workspace, as the adapter's world is: project allow rules apply only there. Trust is written into a
  // temporary config dir, so recording needs a credentials file to copy (not the macOS keychain).
  if (!isolated) throw new Error(`recording needs ${path.join(sourceClaudeConfig(), '.credentials.json')}: the workspace trust is written into a temporary config dir holding a copy of it`);
  createCodexHome(configDir, sourceClaudeConfig(), '.credentials.json');
  await writeFile(path.join(configDir, '.claude.json'), JSON.stringify({ projects: { [world.project]: { hasTrustDialogAccepted: true } } }));
  const list = commands.map((c, i) => `${i + 1}. ${fill(c, world)}`).join('\n');
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', HOST_MODEL,
    '--effort', 'low',
    '--max-turns', String(maxTurns),
    '--setting-sources', 'project',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--permission-mode', setup.mode,
    '--tools', 'Bash',
    '--system-prompt', SYSTEM_PROMPT,
  ];
  const stdoutFile = path.join(world.base, 'stdout.jsonl');
  const stderrFile = path.join(world.base, 'stderr.txt');
  try {
    const outcome = await runProcess({ command: 'claude', args, cwd: world.project, env: hostEnv(configDir), timeoutMs: 15 * 60_000, stdoutFile, stderrFile, stdin: `Run these commands:\n${list}\n` });
    const transcript = await readFile(stdoutFile, 'utf8');
    if (outcome.exitCode !== 0) throw new Error(`${setup.id}: claude exited ${String(outcome.exitCode)}: ${(await readFile(stderrFile, 'utf8')).slice(0, 2000)}`);
    return { parsed: parseHostTranscript(transcript, commands.map((c) => fill(c, world))), world, transcript };
  } finally {
    removeCodexHome(configDir);
  }
}

export function scrub(text: string, world: World | undefined): string {
  const unfilled = world === undefined ? text : unfill(text, world);
  return sanitize(unfilled, defaultSanitizeContext([]));
}


export interface Row {
  readonly setup: string;
  readonly command: string;
  readonly host: Verdict;
  readonly adapter: Verdict;
}

export function looser(row: Row): boolean {
  return VERDICTS.indexOf(row.adapter) < VERDICTS.indexOf(row.host);
}

const MARK: Record<Verdict, string> = { allow: 'a', ask: '?', deny: 'x' };

/** One line per command, one column per setup: `host/adapter`, `!` where the adapter is looser, `+` where it is stricter. */
export function matrix(rows: readonly Row[]): string {
  const setups = [...new Set(rows.map((r) => r.setup))];
  const commands = [...new Set(rows.map((r) => r.command))];
  const width = Math.max(...setups.map((s) => s.length), 4);
  const cmdWidth = Math.max(...commands.map((c) => c.length));
  const header = `${''.padEnd(cmdWidth)}  ${setups.map((s) => s.padStart(width)).join(' ')}`;
  const lines = commands.map((command) => {
    const cells = setups.map((setup) => {
      const row = rows.find((r) => r.setup === setup && r.command === command);
      if (row === undefined) return '-'.padStart(width);
      const flag = looser(row) ? '!' : row.adapter === row.host ? ' ' : '+';
      return `${MARK[row.host]}/${MARK[row.adapter]}${flag}`.padStart(width);
    });
    return `${command.padEnd(cmdWidth)}  ${cells.join(' ')}`;
  });
  const count = (f: (r: Row) => boolean): number => rows.filter(f).length;
  const summary = `${rows.length} rows: ${count((r) => r.adapter === r.host)} same, ${count((r) => !looser(r) && r.adapter !== r.host)} stricter (+), ${count(looser)} looser (!). Cells are host/adapter: a allow, ? ask, x deny.`;
  return [header, ...lines, '', summary].join('\n');
}
