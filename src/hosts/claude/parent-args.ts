import { execFile } from 'node:child_process';
import { readFile, readlink } from 'node:fs/promises';
import path from 'node:path';

/**
 * Best-effort read of the Claude Code process that started this server, to
 * pick up the flags that change authorization: `--settings`,
 * `--permission-mode`, `--dangerously-skip-permissions`, `--allowedTools`,
 * `--disallowedTools`, `--setting-sources` and `--add-dir`.
 *
 * Linux reads `/proc/<pid>/cmdline` (exact argv) and `/proc/<pid>/cwd`.
 * macOS reads `ps -ww -o ppid=,command=`, which joins argv with spaces, so
 * arguments containing spaces are split wrongly; a `--settings` JSON value
 * that no longer parses then fails the policy load (fail closed).
 *
 * Flags that reach Claude Code any other way are invisible here: an Agent SDK
 * host passing options over its control channel, environment variables read
 * by the CLI, settings changed with `/permissions` during the session (those
 * are written to settings files and are seen), or a server launched by a
 * process that is not a descendant of Claude Code.
 */

export interface ParentProcess {
  readonly argv: readonly string[];
  /** Working directory of that process, when known (resolves a relative `--settings` path). */
  readonly cwd?: string;
}

/** Reads the nearest ancestor process that looks like Claude Code. Undefined when none is found. */
export type ParentArgsReader = () => Promise<ParentProcess | undefined>;

const MAX_ANCESTORS = 6;

function looksLikeClaude(argv: readonly string[]): boolean {
  const first = argv[0];
  if (first === undefined) return false;
  if (/^claude(\.exe)?$/i.test(path.basename(first))) return true;
  // `node .../@anthropic-ai/claude-code/cli.js`
  return argv.slice(1, 3).some((a) => /claude-code[\\/].*cli\.(m?js)$/.test(a) || /^claude$/.test(path.basename(a)));
}

async function linuxProcess(pid: number): Promise<{ argv: string[]; ppid: number; cwd?: string } | undefined> {
  try {
    const raw = await readFile(`/proc/${pid}/cmdline`, 'utf8');
    const argv = raw.split('\0');
    if (argv.at(-1) === '') argv.pop();
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const afterName = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ppid = Number(afterName[1]);
    let cwd: string | undefined;
    try {
      cwd = await readlink(`/proc/${pid}/cwd`);
    } catch {
      cwd = undefined;
    }
    return { argv, ppid: Number.isInteger(ppid) ? ppid : 0, ...(cwd === undefined ? {} : { cwd }) };
  } catch {
    return undefined;
  }
}

function psProcess(pid: number): Promise<{ argv: string[]; ppid: number } | undefined> {
  return new Promise((resolve) => {
    execFile('ps', ['-ww', '-o', 'ppid=,command=', '-p', String(pid)], { timeout: 2_000 }, (err, stdout) => {
      if (err) return resolve(undefined);
      const m = /^\s*(\d+)\s+(.*)$/s.exec(stdout.trim());
      if (!m?.[1] || m[2] === undefined) return resolve(undefined);
      resolve({ ppid: Number(m[1]), argv: m[2].trim().split(/\s+/) });
    });
  });
}

/** Default reader for this platform. */
export const readParentClaudeProcess: ParentArgsReader = async () => {
  if (process.platform !== 'linux' && process.platform !== 'darwin') return undefined;
  let pid = process.ppid;
  for (let i = 0; i < MAX_ANCESTORS && pid > 1; i++) {
    const info: { argv: string[]; ppid: number; cwd?: string } | undefined = process.platform === 'linux' ? await linuxProcess(pid) : await psProcess(pid);
    if (!info) return undefined;
    if (looksLikeClaude(info.argv)) return { argv: info.argv, ...(info.cwd === undefined ? {} : { cwd: info.cwd }) };
    pid = info.ppid;
  }
  return undefined;
};

/** Authorization-relevant flags parsed from a Claude Code argv. */
export interface ClaudeCliFlags {
  /** Values of every `--settings` flag, in order (file path or JSON text). */
  readonly settings: readonly string[];
  readonly permissionMode?: string;
  readonly allowedTools: readonly string[];
  readonly disallowedTools: readonly string[];
  /** `--setting-sources`: which of user/project/local load. Undefined = all. */
  readonly settingSources?: readonly string[];
  readonly addDirs: readonly string[];
}

const VARIADIC = new Set(['--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools', '--add-dir']);
const SINGLE = new Set(['--settings', '--permission-mode', '--setting-sources']);

/** Parses the flags this adapter cares about; everything else is skipped. */
export function parseClaudeFlags(argv: readonly string[]): ClaudeCliFlags {
  const settings: string[] = [];
  const allowed: string[] = [];
  const disallowed: string[] = [];
  const addDirs: string[] = [];
  let permissionMode: string | undefined;
  let settingSources: string[] | undefined;
  const take = (flag: string, value: string): void => {
    switch (flag) {
      case '--settings':
        settings.push(value);
        break;
      case '--permission-mode':
        permissionMode = value;
        break;
      case '--setting-sources':
        settingSources = value
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s !== '');
        break;
      case '--allowedTools':
      case '--allowed-tools':
        allowed.push(value);
        break;
      case '--disallowedTools':
      case '--disallowed-tools':
        disallowed.push(value);
        break;
      case '--add-dir':
        addDirs.push(value);
        break;
    }
  };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--') break;
    if (arg === '--dangerously-skip-permissions') {
      permissionMode ??= 'bypassPermissions';
      continue;
    }
    const eq = arg.indexOf('=');
    const flag = arg.startsWith('--') && eq !== -1 ? arg.slice(0, eq) : arg;
    if (!SINGLE.has(flag) && !VARIADIC.has(flag)) continue;
    if (eq !== -1 && arg.startsWith('--')) {
      take(flag, arg.slice(eq + 1));
      continue;
    }
    if (SINGLE.has(flag)) {
      const value = argv[i + 1];
      if (value !== undefined) take(flag, value);
      i++;
      continue;
    }
    while (i + 1 < argv.length && !(argv[i + 1] ?? '').startsWith('-')) {
      take(flag, argv[i + 1] ?? '');
      i++;
    }
  }
  // An explicit --permission-mode wins over --dangerously-skip-permissions.
  return {
    settings,
    ...(permissionMode === undefined ? {} : { permissionMode }),
    allowedTools: allowed,
    disallowedTools: disallowed,
    ...(settingSources === undefined ? {} : { settingSources }),
    addDirs,
  };
}
