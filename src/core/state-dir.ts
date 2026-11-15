import { chmod, mkdir } from 'node:fs/promises';
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

/** Creates the state directory with mode 0700 (and tightens it if it already existed). Returns its path. */
export async function ensureStateDir(dir: string = stateDirPath()): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(dir, 0o700);
  return dir;
}
