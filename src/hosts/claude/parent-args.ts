import { execFile } from 'node:child_process';
import { readFile, readlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

/**
 * Best-effort read of the Claude Code process that started this server, to
 * pick up the flags that change authorization: `--settings`,
 * `--permission-mode`, `--dangerously-skip-permissions`, `--allowedTools`,
 * `--disallowedTools`, `--setting-sources` and `--add-dir`.
 *
 * Linux reads `/proc/<pid>/cmdline` (exact argv) and `/proc/<pid>/cwd`.
 * Windows reads the process table through CIM (`Win32_Process`) and splits each
 * command line with the `CommandLineToArgvW` rules; no working directory is known.
 * macOS reads `ps -ww -o ppid=,command=`, which joins argv with spaces, so
 * argument boundaries are lost: `conservativeFlags` then drops the grants and
 * refuses the restrictions it cannot read exactly.
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
  /** True when `argv` was split from a joined command line, so its word boundaries are guesses. */
  readonly lossy?: boolean;
}

/**
 * Reads the nearest ancestor process that looks like Claude Code. Undefined when the whole ancestor chain was
 * read and none is Claude Code (or on a platform without a reader). Rejects when an ancestor cannot be read or
 * the chain is longer than it walks: launch flags of an unread Claude process cannot be ruled out.
 */
export type ParentArgsReader = () => Promise<ParentProcess | undefined>;

const MAX_ANCESTORS = 32;

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

function psProcess(pid: number): Promise<{ argv: string[]; ppid: number; joined: string } | undefined> {
  return new Promise((resolve) => {
    execFile('ps', ['-ww', '-o', 'ppid=,command=', '-p', String(pid)], { timeout: 2_000 }, (err, stdout) => {
      if (err) return resolve(undefined);
      const m = /^\s*(\d+)\s+(.*)$/s.exec(stdout.trim());
      if (!m?.[1] || m[2] === undefined) return resolve(undefined);
      resolve({ ppid: Number(m[1]), argv: m[2].trim().split(/\s+/), joined: m[2].trim() });
    });
  });
}

/**
 * Splits a Windows command line the way `CommandLineToArgvW` does: the program name ends at the first
 * whitespace outside quotes, with no escapes; in later arguments 2n backslashes before a quote give n
 * backslashes and toggle quoting, 2n+1 give n and a literal quote, other backslashes are literal, and `""`
 * inside quotes is a literal quote.
 */
export function splitWindowsCommandLine(line: string): string[] {
  const argv: string[] = [];
  let i = 0;
  let program = '';
  let quoted = false;
  for (; i < line.length; i++) {
    const ch = line[i] ?? '';
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === ' ' || ch === '\t')) break;
    else program += ch;
  }
  argv.push(program);
  for (;;) {
    while (line[i] === ' ' || line[i] === '\t') i++;
    if (i >= line.length) return argv;
    let arg = '';
    quoted = false;
    for (; i < line.length; i++) {
      const ch = line[i] ?? '';
      if (ch === '\\') {
        let n = 0;
        while (line[i + n] === '\\') n++;
        if (line[i + n] === '"') {
          arg += '\\'.repeat(Math.floor(n / 2));
          i += n;
          if (n % 2 === 1) arg += '"';
          else quoted = !quoted;
        } else {
          arg += '\\'.repeat(n);
          i += n - 1;
        }
      } else if (ch === '"') {
        if (quoted && line[i + 1] === '"') {
          arg += '"';
          i++;
        } else {
          quoted = !quoted;
        }
      } else if (!quoted && (ch === ' ' || ch === '\t')) {
        break;
      } else {
        arg += ch;
      }
    }
    argv.push(arg);
  }
}

const WindowsProcessSchema = z.object({ ProcessId: z.number(), ParentProcessId: z.number(), CommandLine: z.string().nullable(), Created: z.number() });
export type WindowsProcessRow = z.infer<typeof WindowsProcessSchema>;

// Module autoloading off, and the two modules imported by absolute path under the pinned PowerShell: no module
// path or analysis cache chooses a command, and nothing is scanned at startup.
const WINDOWS_PROCESS_SCRIPT =
  "$PSModuleAutoLoadingPreference = 'None'; " +
  'Import-Module "$PSHOME\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1"; ' +
  'Import-Module "$PSHOME\\Modules\\CimCmdlets\\CimCmdlets.psd1"; ' +
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process | ' +
  "Select-Object ProcessId,ParentProcessId,CommandLine,@{n='Created';e={$_.CreationDate.ToFileTimeUtc()}} | ConvertTo-Json -Compress";

/**
 * How the process table is read: the system Windows PowerShell by absolute path, run in System32, with the
 * environment minus every PowerShell variable (`PS*`, `__PS*`: module paths and analysis cache, execution
 * policy) and the module path pinned to the system modules, so no workspace file, module or policy variable
 * steers it. The script calls cmdlets only, so PATH chooses nothing. No `-ExecutionPolicy` flag: an inline
 * `-Command` and signed system modules are not subject to it.
 */
export function windowsPowerShellInvocation(env: Readonly<Record<string, string | undefined>>): { file: string; args: string[]; cwd: string; env: Record<string, string> } {
  const lookup = (name: string): string | undefined => {
    const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
    return key === undefined ? undefined : env[key];
  };
  const systemRoot = lookup('SystemRoot');
  if (systemRoot === undefined || !/^[A-Za-z]:\\/.test(systemRoot)) throw new Error('SystemRoot is missing or not an absolute path, so the Windows process table cannot be read');
  const system32 = path.win32.join(systemRoot, 'System32');
  const home = path.win32.join(system32, 'WindowsPowerShell', 'v1.0');
  return {
    file: path.win32.join(home, 'powershell.exe'),
    args: ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_SCRIPT],
    cwd: system32,
    env: {
      ...Object.fromEntries(Object.entries(env).flatMap(([name, value]) => (value === undefined || /^(__)?PS/i.test(name) || name.toLowerCase() === 'systemroot' ? [] : [[name, value]]))),
      SystemRoot: systemRoot,
      PSModulePath: path.win32.join(home, 'Modules'),
    },
  };
}

/**
 * A lookup by pid over one read of the process table. A process whose command line is empty or hidden cannot
 * be read; a parent created after its child gets ppid -1: its pid was reused after the real parent exited.
 */
export function processTableReader(rows: readonly WindowsProcessRow[]): (pid: number) => Promise<ProcessInfo | undefined> {
  const byPid = new Map(rows.map((r) => [r.ProcessId, r]));
  return async (pid) => {
    const row = byPid.get(pid);
    if (!row?.CommandLine?.trim()) return undefined;
    const parent = byPid.get(row.ParentProcessId);
    const ppid = parent !== undefined && parent.Created > row.Created ? -1 : row.ParentProcessId;
    return { argv: splitWindowsCommandLine(row.CommandLine.trim()), ppid };
  };
}

/** One read of the Windows process table. */
export function windowsProcessTable(env: Readonly<Record<string, string | undefined>> = process.env): Promise<(pid: number) => Promise<ProcessInfo | undefined>> {
  const run = windowsPowerShellInvocation(env);
  return new Promise((resolve, reject) => {
    execFile(run.file, run.args, { cwd: run.cwd, env: run.env, timeout: 20_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) return reject(new Error(`the Windows process table cannot be read: ${err.message}`));
      try {
        const json: unknown = JSON.parse(stdout);
        resolve(processTableReader(z.array(WindowsProcessSchema).parse(Array.isArray(json) ? json : [json])));
      } catch (parseErr) {
        reject(new Error(`the Windows process table is not in the expected shape: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`));
      }
    });
  });
}

export interface ProcessInfo {
  readonly argv: readonly string[];
  readonly ppid: number;
  readonly cwd?: string;
  readonly joined?: string;
}

/** Walks up from this server's own process, so the link to its immediate parent is checked like every other. */
export async function findClaudeFromSelf(selfPid: number, read: (pid: number) => Promise<ProcessInfo | undefined>): Promise<ParentProcess | undefined> {
  const self = await read(selfPid);
  if (!self) throw new Error('this server process cannot be read, so the Claude Code launch flags cannot be ruled out');
  return findClaudeAncestor(self.ppid, read);
}

export async function findClaudeAncestor(pid: number, read: (pid: number) => Promise<ProcessInfo | undefined>): Promise<ParentProcess | undefined> {
  for (let i = 0; i < MAX_ANCESTORS; i++) {
    if (pid < 0) throw new Error('an ancestor exited and its process id was reused, so the Claude Code launch flags cannot be ruled out');
    if (pid <= 1) return undefined;
    const info = await read(pid);
    if (!info) throw new Error(`ancestor process ${pid} cannot be read, so the Claude Code launch flags cannot be ruled out`);
    if (looksLikeClaude(info.argv) || (info.joined !== undefined && joinedLooksLikeClaude(info.joined))) {
      return { argv: info.argv, ...(info.cwd === undefined ? {} : { cwd: info.cwd }), ...(info.joined === undefined ? {} : { lossy: true }) };
    }
    pid = info.ppid;
  }
  throw new Error(`no Claude Code process within ${MAX_ANCESTORS} ancestors, so its launch flags cannot be ruled out`);
}

/**
 * The reader for a platform. Where no reader exists it rejects: a restriction passed at launch
 * (`--disallowedTools`, `--settings`) cannot be ruled out, so nothing may be approved.
 */
export function parentReaderFor(platform: NodeJS.Platform): ParentArgsReader {
  return async () => {
    if (platform === 'win32') return findClaudeFromSelf(process.pid, await windowsProcessTable());
    if (platform !== 'linux' && platform !== 'darwin') throw new Error(`the Claude Code launch flags cannot be read on ${platform}`);
    return findClaudeFromSelf(process.pid, platform === 'linux' ? linuxProcess : psProcess);
  };
}

/** Default reader for this platform. */
export const readParentClaudeProcess: ParentArgsReader = parentReaderFor(process.platform);

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
  /** Values of every `--agents` flag (JSON subagent definitions). */
  readonly agents: readonly string[];
}

const VARIADIC = new Set(['--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools', '--add-dir']);
const SINGLE = new Set(['--settings', '--permission-mode', '--setting-sources', '--agents']);

/** Parses the flags this adapter cares about; everything else is skipped. */
export function parseClaudeFlags(argv: readonly string[]): ClaudeCliFlags {
  const settings: string[] = [];
  const allowed: string[] = [];
  const disallowed: string[] = [];
  const addDirs: string[] = [];
  const agents: string[] = [];
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
      case '--agents':
        agents.push(value);
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
    agents,
  };
}

const RESTRICTIVE_MODES = new Set(['default', 'manual', 'plan', 'dontAsk']);

export function conservativeFlags(argv: readonly string[]): ClaudeCliFlags {
  const words = argv.slice(1);
  if (words.some((w) => /--(settings|disallowedTools|disallowed-tools|setting-sources|agents)(?![A-Za-z-])/.test(w))) {
    throw new Error('--settings, --disallowedTools, --setting-sources and --agents cannot be read exactly from the Claude Code command line on this platform');
  }
  const modes: string[] = [];
  words.forEach((w, i) => {
    if (w === '--permission-mode') modes.push(words[i + 1] ?? '');
    else if (w.startsWith('--permission-mode=')) modes.push(w.slice('--permission-mode='.length));
    else if (w.includes('--permission-mode') || w.includes('--dangerously-skip-permissions')) modes.push('bypassPermissions');
  });
  if (new Set(modes).size > 1) throw new Error('the Claude Code permission mode cannot be read exactly from the command line on this platform');
  const mode = modes[0];
  const flags: ClaudeCliFlags = { settings: [], allowedTools: [], disallowedTools: [], addDirs: [], agents: [] };
  if (mode === undefined) return flags;
  return { ...flags, permissionMode: RESTRICTIVE_MODES.has(mode) ? mode : 'default' };
}

/** A joined macOS command line that runs Claude Code (its path may contain spaces, so word splitting misses it). */
function joinedLooksLikeClaude(command: string): boolean {
  return /(^|\/)claude(\.exe)?(\s|$)/.test(command) || /claude-code\/\S*cli\.m?js(\s|$)/.test(command);
}
