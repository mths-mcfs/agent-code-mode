import type { ChildProcess } from 'node:child_process';

/** Kills `child` and resolves once it has exited; a child that already exited resolves at once. */
export function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
  });
}
