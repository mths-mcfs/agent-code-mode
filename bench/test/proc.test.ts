import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runProcess } from '../lib/proc.ts';

describe('runProcess', () => {
  it('streams stdout to a file, feeds stdin and reports the exit code', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'acm-proc-'));
    try {
      const out = await runProcess({
        command: process.execPath,
        args: ['-e', "process.stdin.on('data', (d) => process.stdout.write(String(d).toUpperCase())); process.stdin.on('end', () => process.exit(3));"],
        cwd: dir,
        env: { PATH: process.env['PATH'] },
        timeoutMs: 20_000,
        stdoutFile: path.join(dir, 'out'),
        stderrFile: path.join(dir, 'err'),
        stdin: 'hello',
      });
      expect(out).toMatchObject({ exitCode: 3, timedOut: false });
      expect(await readFile(path.join(dir, 'out'), 'utf8')).toBe('HELLO');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('kills a process that runs past the wall timeout', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'acm-proc-'));
    try {
      const out = await runProcess({
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: dir,
        env: { PATH: process.env['PATH'] },
        timeoutMs: 300,
        stdoutFile: path.join(dir, 'out'),
        stderrFile: path.join(dir, 'err'),
      });
      expect(out.timedOut).toBe(true);
      expect(out.wallMs).toBeLessThan(10_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
