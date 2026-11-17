import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { interactiveProgress, type InteractiveProgress } from './claude-interactive.ts';
import { trackTmuxServer, untrackTmuxServer } from './proc.ts';

/**
 * Drives an interactive Claude Code session in tmux: one private tmux server (`tmux -L <name>`, no user
 * config) per run, the host started under `env -i` with an allowlisted environment, the task prompt sent
 * as a bracketed paste, permission prompts denied for the one call (No + Tab + a note, which keeps the
 * turn going; Esc or a plain No stop the whole turn, checked with Claude Code 2.1.326), the end of the
 * turn read from the session transcript, then `/exit` and `kill-server`. Every exit path kills the server
 * (also SIGINT/SIGTERM through proc.ts, and `sweepStaleTmuxServers` after a SIGKILL).
 */

/** Recorded in the config hash of interactive runs: a change to how sessions are driven is a new config. */
export const INTERACTIVE_DRIVER = 'tmux-v1: env -i allowlist, seeded .claude.json, bracketed paste, deny = No+Tab+note, end = transcript turn_duration + idle screen';
/** The note sent with a denied call (what the model reads, like the `-p` denial text). */
export const DENY_NOTE = 'Permission for this tool call was not granted. Continue the task without it.';
const SERVER_PREFIX = 'acmb-';
const WIDTH = 200;
const HEIGHT = 50;

export interface ScreenState {
  /** The line saying Code Mode is on, if shown. */
  readonly codeModeOn: string | null;
  /** The line saying Code Mode is not available, if shown. */
  readonly codeModeUnavailable: string | null;
  /** A first-run or other blocking dialog the seeded config should have answered. */
  readonly dialog: string | null;
  /** A permission prompt: its numbered options and which one is selected. */
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

/** Reads a captured screen (plain text, wrapped lines joined). Pure. */
export function classifyScreen(screen: string): ScreenState {
  const lines = screen.split('\n');
  const find = (re: RegExp): string | null => lines.find((l) => re.test(l))?.trim() ?? null;
  const dialog = DIALOG_MARKERS.map((m) => find(new RegExp(m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).find((l) => l !== null) ?? null;
  let permission: ScreenState['permission'] = null;
  // The options are below the prompt's question (or the last rule line): numbered lists in the answer above are not options.
  const question = lines.findLastIndex((l) => /^\s*(Do you want|Would you like)/.test(l));
  const tail = lines.slice(question >= 0 ? question : Math.max(0, lines.findLastIndex((l) => /^\s*[─━]{10,}/.test(l))));
  if (tail.some((l) => /Esc to cancel/.test(l)) && tail.some((l) => /^\s*(?:❯\s*)?\d+\.\s+No\b/.test(l))) {
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
  const prompt = lines.some((l) => /^❯/.test(l)) && lines.some((l) => /\? for shortcuts|for shortcuts/.test(l));
  return {
    codeModeOn: find(/Code Mode \(experimental\) is on/),
    codeModeUnavailable: find(/Code Mode.*(isn't|is not) available/),
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

/** Kills tmux servers left by a harness that died without cleanup (its pid is in the server name). */
export function sweepStaleTmuxServers(): string[] {
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(socketDir()).filter((n) => n.startsWith(SERVER_PREFIX));
  } catch {
    return removed;
  }
  for (const name of names) {
    const pid = Number(name.slice(SERVER_PREFIX.length).split('-')[0]);
    if (pid === process.pid || alive(pid)) continue;
    killServer(name);
    removed.push(name);
  }
  return removed;
}

/** Kills a private server and removes its socket file (tmux leaves it behind). */
export function killServer(name: string): void {
  try {
    execFileSync('tmux', ['-L', name, 'kill-server'], { stdio: 'ignore', timeout: 10_000 });
  } catch {
    // not running
  }
  if (!serverAlive(name)) rmSync(path.join(socketDir(), name), { force: true });
  untrackTmuxServer(name);
}

/** True when the private server `name` still answers. */
export function serverAlive(name: string): boolean {
  try {
    execFileSync('tmux', ['-L', name, 'list-sessions'], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export interface InteractiveSpec {
  readonly cwd: string;
  /** The host command and arguments, run as `env -i <env> <command...>`. */
  readonly command: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly prompt: string;
  /** Session transcript the host writes (`--session-id`): read for progress and the end of the turn. */
  readonly transcriptFile: () => string | null;
  readonly codeMode: boolean;
  readonly timeoutMs: number;
  /** Stop once the model has made this many tool calls plus one (the `-p` `--max-turns` count). */
  readonly maxTurns: number;
  /** A scratch directory for the prompt file. */
  readonly scratchDir: string;
  /** Seconds to wait for the session to be ready. */
  readonly readyTimeoutMs?: number;
}

export type InteractiveStop = 'finished' | 'timeout' | 'max-turns' | 'not-ready' | 'host-exited' | 'not-submitted';

export interface InteractiveOutcome {
  readonly stop: InteractiveStop;
  /** Why the run is unusable, when it is (not ready, Code Mode unavailable, an unexpected dialog...). */
  readonly problem: string | null;
  /** Exit status of the host after `/exit` (null when it had to be killed). */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** From the session start to the end of the turn. */
  readonly wallMs: number;
  readonly readyMs: number | null;
  readonly codeModeLine: string | null;
  readonly permissionPrompts: number;
  /** Screens captured at the points that matter (ready, each permission prompt, the end), for the record. */
  readonly screens: string;
  /** The tmux server name used, to check it is gone. */
  readonly server: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function tmux(server: string, args: readonly string[], timeout = 10_000): string {
  return execFileSync('tmux', ['-L', server, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, env: tmuxClientEnv() });
}

/** The tmux client must not think it is nested in the caller's tmux. */
function tmuxClientEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env['TMUX'];
  delete env['TMUX_PANE'];
  return env;
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
    const out = tmux(server, ['list-panes', '-t', 'main', '-F', '#{pane_dead} #{pane_dead_status}']).trim();
    const [dead, status] = out.split(' ');
    return { dead: dead === '1', status: status !== undefined && status !== '' ? Number(status) : null };
  } catch {
    return { dead: true, status: null };
  }
}

function readTranscript(spec: InteractiveSpec): InteractiveProgress {
  const file = spec.transcriptFile();
  if (file === null) return { promptSeen: false, outerToolUses: 0, finished: false };
  try {
    return interactiveProgress(readFileSync(file, 'utf8'));
  } catch {
    return { promptSeen: false, outerToolUses: 0, finished: false };
  }
}

/** Selects the "No" option of a permission prompt, opens its note (Tab), types the note and submits it. */
async function denyCall(server: string, permission: NonNullable<ScreenState['permission']>): Promise<void> {
  const no = permission.options.find((o) => /^No\b/.test(o.text));
  if (no === undefined) throw new Error('permission prompt without a No option');
  const from = permission.selected ?? permission.options[0]?.n ?? 1;
  const steps = permission.options.findIndex((o) => o.n === no.n) - permission.options.findIndex((o) => o.n === from);
  for (let i = 0; i < Math.abs(steps); i++) {
    tmux(server, ['send-keys', '-t', 'main', steps > 0 ? 'Down' : 'Up']);
    await sleep(150);
  }
  tmux(server, ['send-keys', '-t', 'main', 'Tab']);
  await sleep(400);
  tmux(server, ['send-keys', '-t', 'main', '-l', DENY_NOTE]);
  await sleep(300);
  tmux(server, ['send-keys', '-t', 'main', 'Enter']);
}

/** Runs one interactive session to the end of its first turn. Always kills its tmux server before returning. */
export async function driveInteractive(spec: InteractiveSpec): Promise<InteractiveOutcome> {
  const server = `${SERVER_PREFIX}${process.pid}-${randomBytes(4).toString('hex')}`;
  const screens: string[] = [];
  const snap = (label: string, screen: string): void => {
    screens.push(`===== ${label} =====\n${screen.replace(/\s+$/g, '')}\n`);
  };
  const started = performance.now();
  const elapsed = (): number => Math.round(performance.now() - started);
  let stop: InteractiveStop = 'finished';
  let problem: string | null = null;
  let readyMs: number | null = null;
  let codeModeLine: string | null = null;
  let permissionPrompts = 0;
  let wallMs = 0;
  let exitCode: number | null = null;
  trackTmuxServer(server);
  try {
    const envArgs = Object.entries(spec.env).map(([k, v]) => `${k}=${v}`);
    // remain-on-exit keeps the pane (and its exit status) when the host exits early.
    tmux(server, ['-f', '/dev/null', 'start-server', ';', 'set-option', '-g', 'remain-on-exit', 'on', ';', 'new-session', '-d', '-x', String(WIDTH), '-y', String(HEIGHT), '-s', 'main', '-c', spec.cwd, 'env', '-i', ...envArgs, ...spec.command]);

    // 1. Ready: the prompt is shown, nothing blocks it, and (Code Mode arm) the Code Mode line is on screen.
    const readyDeadline = spec.readyTimeoutMs ?? 90_000;
    for (;;) {
      const screen = capture(server);
      const s = classifyScreen(screen);
      codeModeLine ??= s.codeModeOn;
      if (s.codeModeUnavailable !== null) problem = `Code Mode not available: ${s.codeModeUnavailable}`;
      else if (s.dialog !== null) problem = `unexpected dialog before the prompt: ${s.dialog}`;
      else if (paneDead(server).dead) problem = 'host exited before the prompt was shown';
      else if (s.ready && (!spec.codeMode || s.codeModeOn !== null)) {
        readyMs = elapsed();
        snap('ready', screen);
        break;
      } else if (elapsed() > readyDeadline) problem = `session not ready after ${Math.round(readyDeadline / 1000)} s`;
      if (problem !== null) {
        snap('not ready', screen);
        stop = 'not-ready';
        return { stop, problem, exitCode: null, timedOut: false, wallMs: elapsed(), readyMs, codeModeLine, permissionPrompts, screens: screens.join('\n'), server };
      }
      await sleep(500);
    }

    // 2. The task prompt as one bracketed paste, then Enter; submitted once the transcript has it.
    const promptFile = path.join(spec.scratchDir, `prompt-${server}.txt`);
    writeFileSync(promptFile, spec.prompt);
    try {
      tmux(server, ['load-buffer', '-b', 'task', promptFile]);
      tmux(server, ['paste-buffer', '-p', '-d', '-b', 'task', '-t', 'main']);
    } finally {
      rmSync(promptFile, { force: true });
    }
    await sleep(1000);
    tmux(server, ['send-keys', '-t', 'main', 'Enter']);
    const submitStart = elapsed();
    let resent = false;
    while (!readTranscript(spec).promptSeen) {
      if (!resent && elapsed() - submitStart > 10_000) {
        tmux(server, ['send-keys', '-t', 'main', 'Enter']);
        resent = true;
      }
      if (elapsed() - submitStart > 30_000) {
        snap('prompt not submitted', capture(server));
        stop = 'not-submitted';
        problem = 'the task prompt never reached the transcript';
        break;
      }
      await sleep(500);
    }

    // 3. Until the turn ends: deny permission prompts one call at a time, enforce timeout and turn cap.
    let lastScreen = '';
    let stableSince = 0;
    while (stop === 'finished' && problem === null) {
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
        await sleep(1000);
        continue;
      }
      const progress = readTranscript(spec);
      if (progress.outerToolUses + 1 > spec.maxTurns) {
        stop = 'max-turns';
        tmux(server, ['send-keys', '-t', 'main', 'Escape']);
        await sleep(1000);
        break;
      }
      if (screen !== lastScreen) {
        lastScreen = screen;
        stableSince = elapsed();
      }
      // The transcript says the turn ended and the screen has been still for 2 s.
      if (progress.finished && s.ready && elapsed() - stableSince >= 2000) break;
      await sleep(1000);
    }
    wallMs = elapsed();
    snap(`end (${stop})`, capture(server));

    // 4. Leave: /exit, wait for the host to exit, keep its status.
    if (!paneDead(server).dead) {
      tmux(server, ['send-keys', '-t', 'main', 'Escape']);
      await sleep(300);
      tmux(server, ['send-keys', '-t', 'main', '-l', '/exit']);
      await sleep(300);
      tmux(server, ['send-keys', '-t', 'main', 'Enter']);
      for (let i = 0; i < 30 && !paneDead(server).dead; i++) await sleep(500);
    }
    const pane = paneDead(server);
    exitCode = pane.dead ? pane.status : null;
    return { stop, problem, exitCode, timedOut: stop === 'timeout', wallMs, readyMs, codeModeLine, permissionPrompts, screens: screens.join('\n'), server };
  } finally {
    killServer(server);
  }
}

/** The transcript of session `sessionId` under a Claude config dir (`projects/<cwd slug>/<id>.jsonl`), or null. */
export function findSessionTranscript(configDir: string, sessionId: string): string | null {
  const root = path.join(configDir, 'projects');
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const f = path.join(root, d, `${sessionId}.jsonl`);
    try {
      if (statSync(f).isFile()) return f;
    } catch {
      // not here
    }
  }
  return null;
}

/** `tmux -V`, or null when tmux is missing. */
export function tmuxVersion(): string | null {
  try {
    return execFileSync('tmux', ['-V'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
  } catch {
    return null;
  }
}
