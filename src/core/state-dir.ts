import { lstat, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Server state directory: `$XDG_STATE_HOME/agent-code-mode` when
 * `XDG_STATE_HOME` is an absolute path, else `~/.local/state/agent-code-mode`.
 */
export function stateDirPath(env: Readonly<Record<string, string | undefined>> = process.env, home: string = os.homedir()): string {
  const xdg = env['XDG_STATE_HOME'];
  if (xdg !== undefined && xdg !== '' && path.isAbsolute(xdg)) return path.join(xdg, 'agent-code-mode');
  return path.join(home, '.local', 'state', 'agent-code-mode');
}

/** Creates or verifies a private state directory. Returns its path. */
export async function ensureStateDir(dir: string = stateDirPath()): Promise<string> {
  if (process.platform === 'win32') throw new Error('private overflow storage is unavailable on Windows');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const entry = await lstat(dir);
  if (!entry.isDirectory() || entry.uid !== process.getuid?.() || (entry.mode & 0o077) !== 0) {
    throw new Error('overflow storage must use a private directory owned by the server user');
  }
  return dir;
}
