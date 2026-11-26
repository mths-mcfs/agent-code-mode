import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { interactiveProgress, type InteractiveProgress } from './claude-interactive.ts';
import { trackTmuxServer, untrackTmuxServer } from './proc.ts';

/**
 * Drives one interactive Claude Code session in its own tmux server (`tmux -L <name>`, no user config): the
 * host starts under `env -i` with an allowlisted environment, the prompt goes in as a bracketed paste, each
 * permission prompt is denied for that call only (No, Tab and a note keep the turn going; Esc or a plain No
 * stop it, Claude Code 2.1.326), and the end of the turn is read from the transcript. Every exit path kills
 * the server: here, on SIGINT and SIGTERM through proc.ts, and after a SIGKILL through `sweepStaleTmuxServers`.
 */

/** In the config hash: a change to how sessions are driven is a new config. */
export const INTERACTIVE_DRIVER = 'tmux-v1: env -i allowlist, seeded .claude.json, bracketed paste, deny = No+Tab+note, end = transcript turn_duration + idle screen';
export const DENY_NOTE = 'Permission for this tool call was not granted. Continue the task without it.';
const SERVER_PREFIX = 'acmb-';
const WIDTH = 200;
const HEIGHT = 50;

export interface ScreenState {
  readonly codeModeOn: string | null;
  readonly codeModeUnavailable: string | null;
  /** A first-run or other blocking dialog the seeded config should have answered. */
  readonly dialog: string | null;
  readonly permission: { readonly options: readonly { readonly n: number; readonly text: string }[]; readonly selected: number | null } | null;
  /** The prompt input is shown and nothing blocks it. */
  readonly ready: boolean;
}

const DIALOG_MARKERS = [
  'Choose the text style',
  'Security notes:',
  'Quick safety check',
  'Yes, turn on Code Mode',
  'Claude in Chrome extension detected',
  'Do you want to use this API key',
  'Select login method',
];

export function classifyScreen(screen: string): ScreenState {
  const lines = screen.split('\n');
  const find = (test: (l: string) => boolean): string | null => lines.find(test)?.trim() ?? null;
  const dialog = DIALOG_MARKERS.map((m) => find((l) => l.includes(m))).find((l) => l !== null) ?? null;
  let permission: ScreenState['permission'] = null;
  // Options sit below the prompt's question (or the last rule line): a numbered list in the answer above is not one.
  const question = lines.findLastIndex((l) => /^\s*(Do you want|Would you like)/.test(l));
  const tail = lines.slice(question >= 0 ? question : Math.max(0, lines.findLastIndex((l) => /^\s*[─━]{10,}/.test(l))));
  if (tail.some((l) => l.includes('Esc to cancel')) && tail.some((l) => /^\s*(?:❯\s*)?\d+\.\s+No\b/.test(l))) {
    const options: { n: number; text: string }[] = [];
    let selected: number | null = null;
    for (const l of tail) {
      const m = /^\s*(❯)?\s*(\d+)\.\s+(.*)$/.exec(l);
      if (m === null || m[2] === undefined || m[3] === undefined) continue;
      const n = Number(m[2]);
      if (options.some((o) => o.n === n)) continue;
      options.push({ n, text: m[3].trim() });
      if (m[1] !== undefined) selected = n;
    }
    permission = { options, selected };
  }
  const prompt = lines.some((l) => l.startsWith('❯')) && lines.some((l) => l.includes('for shortcuts'));
  return {
    codeModeOn: find((l) => l.includes('Code Mode (experimental) is on')),
    codeModeUnavailable: find((l) => /Code Mode.*(isn't|is not) available/.test(l)),
    dialog,
    permission,
    ready: prompt && dialog === null && permission === null,
  };
}

function socketDir(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return path.join(process.env['TMUX_TMPDIR'] ?? '/tmp', `tmux-${uid}`);
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err instanceof Error && 'code' in err && err.code === 'EPERM';
  }
}

/** Kills the servers of a harness that died without cleanup (its pid is in the server name). */
export function sweepStaleTmuxServers(): string[] {
  let names: string[];
  try {
    names = readdirSync(socketDir()).filter((n) => n.startsWith(SERVER_PREFIX));
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    const pid = Number(name.slice(SERVER_PREFIX.length).split('-')[0]);
    if (pid === process.pid || alive(pid)) continue;
    killServer(name);
    removed.push(name);
  }
  return removed;
}

/** Kills a private server and removes the socket file tmux leaves behind. */
export function killServer(name: string): void {
  try {
    execFileSync('tmux', ['-L', name, 'kill-server'], { stdio: 'ignore', timeout: 10_000, env: tmuxClientEnv() });
  } catch {
  }
  if (!serverAlive(name)) rmSync(path.join(socketDir(), name), { force: true });
  untrackTmuxServer(name);
}

export function serverAlive(name: string): boolean {
  try {
    execFileSync('tmux', ['-L', name, 'list-sessions'], { stdio: 'ignore', timeout: 10_000, env: tmuxClientEnv() });
    return true;
  } catch {
    return false;
  }
}

export interface InteractiveSpec {
  readonly cwd: string;
  /** Run as `env -i <env> <command...>`. */
  readonly command: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly prompt: string;
  /** The transcript the host writes (`--session-id`), read for progress and the end of the turn. */
  readonly transcriptFile: () => string | null;
  readonly timeoutMs: number;
  /** Stop once the model has made this many tool calls plus one (the `-p` `--max-turns` count). */
  readonly maxTurns: number;
  /** Where the prompt file is written for the paste. */
  readonly scratchDir: string;
  readonly readyTimeoutMs?: number;
  /** Poll period: 1 s against a real host, shorter in tests. */
  readonly pollMs?: number;
}

export type InteractiveStop = 'finished' | 'timeout' | 'max-turns' | 'not-ready' | 'host-exited' | 'not-submitted';

export interface InteractiveOutcome {
  readonly stop: InteractiveStop;
  /** Why the run is unusable, when it is. */
  readonly problem: string | null;
  /** The host's exit status after `/exit`; null when it had to be killed. */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly wallMs: number;
  readonly readyMs: number | null;
  readonly codeModeLine: string | null;
  readonly permissionPrompts: number;
  /** Screens at the points that matter (ready, each permission prompt, the end), for the record. */
  readonly screens: string;
  readonly server: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The tmux client must not think it is nested in the caller's tmux. */
function tmuxClientEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env['TMUX'];
  delete env['TMUX_PANE'];
  return env;
}

function tmux(server: string, args: readonly string[]): string {
  return execFileSync('tmux', ['-L', server, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, env: tmuxClientEnv() });
}

function capture(server: string): string {
  try {
    return tmux(server, ['capture-pane', '-p', '-J', '-t', 'main']);
  } catch {
    return '';
  }
}

function paneDead(server: string): { dead: boolean; status: number | null } {
  try {
    const [dead, status] = tmux(server, ['list-panes', '-t', 'main', '-F', '#{pane_dead} #{pane_dead_status}']).trim().split(' ');
    return { dead: dead === '1', status: status !== undefined && status !== '' ? Number(status) : null };
  } catch {
    return { dead: true, status: null };
  }
}

function readProgress(spec: InteractiveSpec): InteractiveProgress {
  const file = spec.transcriptFile();
  try {
    if (file !== null) return interactiveProgress(readFileSync(file, 'utf8'));
  } catch {
  }
  return { promptSeen: false, outerToolUses: 0, finished: false };
}

async function denyCall(server: string, permission: NonNullable<ScreenState['permission']>): Promise<void> {
  const no = permission.options.findIndex((o) => /^No\b/.test(o.text));
  if (no < 0) throw new Error('permission prompt without a No option');
  const from = Math.max(0, permission.options.findIndex((o) => o.n === (permission.selected ?? permission.options[0]?.n)));
  for (let i = 0; i < Math.abs(no - from); i++) {
    tmux(server, ['send-keys', '-t', 'main', no > from ? 'Down' : 'Up']);
    await sleep(150);
  }
  tmux(server, ['send-keys', '-t', 'main', 'Tab']);
  await sleep(400);
  tmux(server, ['send-keys', '-t', 'main', '-l', DENY_NOTE]);
  await sleep(300);
  tmux(server, ['send-keys', '-t', 'main', 'Enter']);
}

/** Runs one session to the end of its first turn. Always kills its tmux server before returning. */
export async function driveInteractive(spec: InteractiveSpec): Promise<InteractiveOutcome> {
  const server = `${SERVER_PREFIX}${process.pid}-${randomBytes(4).toString('hex')}`;
  const poll = spec.pollMs ?? 1000;
  const screens: string[] = [];
  const snap = (label: string, screen: string): void => {
    screens.push(`===== ${label} =====\n${screen.trimEnd()}\n`);
  };
  const started = performance.now();
  const elapsed = (): number => Math.round(performance.now() - started);
  let readyMs: number | null = null;
  let codeModeLine: string | null = null;
  let permissionPrompts = 0;
  const outcome = (stop: InteractiveStop, problem: string | null, exitCode: number | null, wallMs: number): InteractiveOutcome =>
    ({ stop, problem, exitCode, timedOut: stop === 'timeout', wallMs, readyMs, codeModeLine, permissionPrompts, screens: screens.join('\n'), server });
  trackTmuxServer(server);
  try {
    const envArgs = Object.entries(spec.env).map(([k, v]) => `${k}=${v}`);
    // remain-on-exit keeps the pane, and its exit status, when the host exits early.
    tmux(server, ['-f', '/dev/null', 'start-server', ';', 'set-option', '-g', 'remain-on-exit', 'on', ';', 'new-session', '-d', '-x', String(WIDTH), '-y', String(HEIGHT), '-s', 'main', '-c', spec.cwd, 'env', '-i', ...envArgs, ...spec.command]);

    const readyDeadline = spec.readyTimeoutMs ?? 90_000;
    for (;;) {
      const screen = capture(server);
      const s = classifyScreen(screen);
      codeModeLine ??= s.codeModeOn;
      let problem: string | null = null;
      if (s.codeModeUnavailable !== null) problem = `Code Mode not available: ${s.codeModeUnavailable}`;
      else if (s.dialog !== null) problem = `unexpected dialog before the prompt: ${s.dialog}`;
      else if (paneDead(server).dead) problem = 'host exited before the prompt was shown';
      else if (s.ready && s.codeModeOn !== null) {
        readyMs = elapsed();
        snap('ready', screen);
        break;
      } else if (elapsed() > readyDeadline) problem = `session not ready after ${Math.round(readyDeadline / 1000)} s`;
      if (problem !== null) {
        snap('not ready', screen);
        return outcome('not-ready', problem, null, elapsed());
      }
      await sleep(poll / 2);
    }

    const promptFile = path.join(spec.scratchDir, `prompt-${server}.txt`);
    writeFileSync(promptFile, spec.prompt);
    try {
      tmux(server, ['load-buffer', '-b', 'task', promptFile]);
      tmux(server, ['paste-buffer', '-p', '-d', '-b', 'task', '-t', 'main']);
    } finally {
      rmSync(promptFile, { force: true });
    }
    await sleep(poll);
    tmux(server, ['send-keys', '-t', 'main', 'Enter']);
    let stop: InteractiveStop = 'finished';
    let problem: string | null = null;
    const submitted = elapsed();
    let resent = false;
    while (!readProgress(spec).promptSeen) {
      if (!resent && elapsed() - submitted > 10 * poll) {
        tmux(server, ['send-keys', '-t', 'main', 'Enter']);
        resent = true;
      }
      if (elapsed() - submitted > 30 * poll) {
        snap('prompt not submitted', capture(server));
        stop = 'not-submitted';
        problem = 'the task prompt never reached the transcript';
        break;
      }
      await sleep(poll / 2);
    }

    let lastScreen = '';
    let stableSince = 0;
    while (problem === null) {
      if (elapsed() > spec.timeoutMs) {
        stop = 'timeout';
        break;
      }
      if (paneDead(server).dead) {
        stop = 'host-exited';
        problem = 'host exited during the task';
        break;
      }
      const screen = capture(server);
      const s = classifyScreen(screen);
      codeModeLine ??= s.codeModeOn;
      if (s.permission !== null) {
        permissionPrompts += 1;
        snap(`permission prompt ${permissionPrompts}`, screen);
        await denyCall(server, s.permission);
        await sleep(poll);
        continue;
      }
      const progress = readProgress(spec);
      if (progress.outerToolUses + 1 > spec.maxTurns) {
        stop = 'max-turns';
        tmux(server, ['send-keys', '-t', 'main', 'Escape']);
        await sleep(poll);
        break;
      }
      if (screen !== lastScreen) {
        lastScreen = screen;
        stableSince = elapsed();
      }
      if (progress.finished && s.ready && elapsed() - stableSince >= 2 * poll) break;
      await sleep(poll);
    }
    const wallMs = elapsed();
    snap(`end (${stop})`, capture(server));

    if (!paneDead(server).dead) {
      tmux(server, ['send-keys', '-t', 'main', 'Escape']);
      await sleep(300);
      tmux(server, ['send-keys', '-t', 'main', '-l', '/exit']);
      await sleep(300);
      tmux(server, ['send-keys', '-t', 'main', 'Enter']);
      for (let i = 0; i < 30 && !paneDead(server).dead; i++) await sleep(500);
    }
    const pane = paneDead(server);
    return outcome(stop, problem, pane.dead ? pane.status : null, wallMs);
  } finally {
    killServer(server);
  }
}

/** The transcript of `sessionId` under a Claude config dir (`projects/<cwd slug>/<id>.jsonl`). */
export function findSessionTranscript(configDir: string, sessionId: string): string | null {
  let dirs: string[];
  try {
    dirs = readdirSync(path.join(configDir, 'projects'));
  } catch {
    return null;
  }
  for (const d of dirs) {
    const f = path.join(configDir, 'projects', d, `${sessionId}.jsonl`);
    try {
      if (statSync(f).isFile()) return f;
    } catch {
    }
  }
  return null;
}

export function tmuxVersion(): string | null {
  try {
    return execFileSync('tmux', ['-V'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
  } catch {
    return null;
  }
}
