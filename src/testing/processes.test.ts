import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { stopProcess } from './processes.js';

it('stops a running child', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await stopProcess(child);
  expect(child.signalCode ?? child.exitCode).not.toBeNull();
});

it('returns at once for a child that already exited', { timeout: 5_000 }, async () => {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(child, 'exit');
  await stopProcess(child);
});
