import { execFileSync } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateFixture, writeTree, type Fixture, type Tree } from '../fixture/generate.ts';
import { HOOKS_DIR } from '../tasks/index.ts';
import type { TaskDef } from '../tasks/types.ts';
import { CLAUDE_RUN_TOOL } from './claude.ts';

export type HostId = 'claude' | 'codex';

export const CLAUDE_ALLOWED_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'mcp__agent-code-mode__run'];

export const CLAUDE_HOOK_MATCHER = 'Write|Edit|MultiEdit|NotebookEdit|Bash';
/** Codex PreToolUse matcher for the protect-file hook (`Write|Edit` also match apply_patch). */
export const CODEX_HOOK_MATCHER = 'Bash|apply_patch|Write|Edit';

export function shellLine(argv: readonly string[]): string {
  return argv.map((w) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`)).join(' ');
}

export function hookCommand(protectedFile: string): string {
  return shellLine(['node', path.join(HOOKS_DIR, 'protect-file.mjs'), protectedFile]);
}

export function claudeProjectSettings(task: TaskDef, fixture: Fixture, companionHook?: string): unknown {
  const allow = task.mcpServer === undefined ? CLAUDE_ALLOWED_TOOLS : [...CLAUDE_ALLOWED_TOOLS, `mcp__${task.mcpServer.name}`];
  const settings: Record<string, unknown> = { permissions: { allow }, sandbox: { enabled: true, autoAllowBashIfSandboxed: true }, autoMemoryEnabled: false };
  const preToolUse: unknown[] = [];
  if (task.protectedHook) preToolUse.push({ matcher: CLAUDE_HOOK_MATCHER, hooks: [{ type: 'command', command: hookCommand(fixture.facts.protectedFile), timeout: 30 }] });
  if (companionHook !== undefined) preToolUse.push({ matcher: CLAUDE_RUN_TOOL, hooks: [{ type: 'command', command: companionHook }] });
  if (preToolUse.length > 0) settings['hooks'] = { PreToolUse: preToolUse };
  return settings;
}

export function companionHookCommand(serverEntry: string): string {
  return shellLine([process.execPath, serverEntry, 'hook']);
}

export function initialTree(task: TaskDef, host: HostId, fixture: Fixture): Tree {
  const tree = new Map(task.setup(fixture.files, fixture.facts));
  if (host === 'claude') tree.set('.claude/settings.json', `${JSON.stringify(claudeProjectSettings(task, fixture), null, 2)}\n`);
  return new Map([...tree.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

const GIT_DATE = '2026-01-01T00:00:00Z';

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=.git/no-hooks', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: path.join(os.tmpdir(), 'agent-code-mode-bench-no-gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'bench',
      GIT_AUTHOR_EMAIL: 'bench@example.invalid',
      GIT_COMMITTER_NAME: 'bench',
      GIT_COMMITTER_EMAIL: 'bench@example.invalid',
      GIT_AUTHOR_DATE: GIT_DATE,
      GIT_COMMITTER_DATE: GIT_DATE,
    },
  });
}

export interface Workspace {
  readonly dir: string;
  readonly initial: Tree;
  readonly fixture: Fixture;
  readonly baseCommit: string;
}

export async function createWorkspace(dir: string, task: TaskDef, host: HostId, fixtureSeed: number): Promise<Workspace> {
  await mkdir(dir, { recursive: true });
  if ((await readdir(dir)).length > 0) throw new Error(`workspace dir is not empty: ${dir}`);
  const fixture = generateFixture(fixtureSeed);
  const initial = initialTree(task, host, fixture);
  await writeTree(dir, initial);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['add', '-A']);
  // No seed in the message: from inside the workspace it would say which data T16's generator makes.
  git(dir, ['commit', '-q', '--no-verify', '-m', `fixture for ${task.id}`]);
  return { dir, initial, fixture, baseCommit: git(dir, ['rev-parse', 'HEAD']).trim() };
}

export function workspaceDiff(dir: string): { status: string; diff: string } {
  git(dir, ['add', '-A', '-N']);
  return { status: git(dir, ['status', '--porcelain']), diff: git(dir, ['diff', 'HEAD']) };
}
