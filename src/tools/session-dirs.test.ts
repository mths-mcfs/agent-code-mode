import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Jail } from './jail.js';
import { SessionDirs, closeSessionsOnExit, processStartTicks, scratchBase, sweepDeadSessions, undoBase } from './session-dirs.js';
import { EventEmitter } from 'node:events';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const stateDir = (): string => {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'acm-session-')));
  made.push(dir);
  return dir;
};

const ID = 'a'.repeat(32);
function planted(state: string, id: string, owner: unknown): { scratch: string; undo: string; record: string } {
  const scratch = path.join(scratchBase(state), id);
  const undo = path.join(undoBase(state), id);
  mkdirSync(scratch, { recursive: true });
  mkdirSync(undo, { recursive: true });
  const record = path.join(scratchBase(state), `${id}.json`);
  writeFileSync(record, typeof owner === 'string' ? owner : JSON.stringify(owner));
  return { scratch, undo, record };
}

/** A pid that no process has: a child that already exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise((r) => child.once('exit', r));
  return child.pid ?? 0;
}

describe('SessionDirs', () => {
  it('creates a private scratch directory with an unpredictable name, once', async () => {
    const state = stateDir();
    const session = new SessionDirs(state);
    const dir = await session.scratch();
    expect(await session.scratch()).toBe(dir);
    expect(path.dirname(dir)).toBe(scratchBase(state));
    expect(path.basename(dir)).toMatch(/^[0-9a-f]{32}$/);
    if (process.platform !== 'win32') expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(new SessionDirs(state).id).not.toBe(session.id);
    session.close();
  });

  it('close removes the directories and the owner record, and later calls fail', async () => {
    const state = stateDir();
    const session = new SessionDirs(state);
    const dir = await session.scratch();
    writeFileSync(path.join(dir, 'a.txt'), 'x');
    session.close();
    session.close();
    expect(readdirSync(scratchBase(state))).toEqual([]);
    expect(readdirSync(undoBase(state))).toEqual([]);
    await expect(session.scratch()).rejects.toThrow('closed');
  });

  it('close does not follow a link planted in the scratch directory', async () => {
    const state = stateDir();
    const outside = stateDir();
    writeFileSync(path.join(outside, 'keep.txt'), 'x');
    const session = new SessionDirs(state);
    const dir = await session.scratch();
    rmSync(dir, { recursive: true });
    mkdirSync(dir);
    if (process.platform !== 'win32') (await import('node:fs')).symlinkSync(outside, path.join(dir, 'link'));
    session.close();
    expect(existsSync(path.join(outside, 'keep.txt'))).toBe(true);
  });
});

describe('Jail with a scratch root', () => {
  it('lifts the protected patterns inside the scratch directory and nowhere else', async () => {
    const state = stateDir();
    const cwd = path.join(state, 'ws');
    const scratch = path.join(state, 'scratch', 'mine');
    mkdirSync(cwd);
    mkdirSync(scratch, { recursive: true });
    const jail = await Jail.create({ cwd, roots: [], protectedPaths: [path.join(state, '**')], scratchRoot: scratch });
    expect(() => jail.assertWritable(path.join(scratch, 'a.txt'))).not.toThrow();
    expect(() => jail.assertWritable(path.join(state, 'journal', 'a.txt'))).toThrow('protected');
    expect(() => jail.assertWritable(path.join(scratch, '.git', 'config'))).toThrow('.git');
  });
});

describe('sweepDeadSessions', () => {
  const host = os.hostname();

  it('removes the directories of a dead owner', async () => {
    const state = stateDir();
    const p = planted(state, ID, { pid: await deadPid(), host, startedAt: Date.now() });
    await sweepDeadSessions(state);
    expect([existsSync(p.scratch), existsSync(p.undo), existsSync(p.record)]).toEqual([false, false, false]);
  });

  it('never removes those of a live owner', async () => {
    const state = stateDir();
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    try {
      const p = planted(state, ID, { pid: child.pid, host, startedAt: Date.now() });
      await sweepDeadSessions(state);
      expect([existsSync(p.scratch), existsSync(p.undo), existsSync(p.record)]).toEqual([true, true, true]);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('a session open in this process survives another session starting', async () => {
    const state = stateDir();
    const first = new SessionDirs(state);
    const dir = await first.scratch();
    const second = new SessionDirs(state);
    await second.scratch();
    expect(existsSync(dir)).toBe(true);
    first.close();
    second.close();
  });

  it('a pid reused after a reboot does not keep a session alive', async () => {
    const state = stateDir();
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    try {
      const startedAt = Date.now() - os.uptime() * 1000 - 3_600_000;
      const p = planted(state, ID, { pid: child.pid, host, startedAt });
      await sweepDeadSessions(state);
      expect(existsSync(p.scratch)).toBe(false);
    } finally {
      child.kill('SIGKILL');
    }
  });

  describe.runIf(process.platform === 'linux')('a pid reused since the session started', () => {
    const sleeper = async () => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
      await new Promise((r) => child.once('spawn', r));
      return child;
    };

    it('a live process with another start time does not keep the directories', async () => {
      const state = stateDir();
      const child = await sleeper();
      try {
        const p = planted(state, ID, { pid: child.pid, host, startedAt: Date.now(), processStart: '1' });
        await sweepDeadSessions(state);
        expect(existsSync(p.scratch)).toBe(false);
      } finally {
        child.kill('SIGKILL');
      }
    });

    it('the owner itself, with the same start time, keeps them', async () => {
      const state = stateDir();
      const child = await sleeper();
      try {
        const p = planted(state, ID, { pid: child.pid, host, startedAt: Date.now(), processStart: processStartTicks(child.pid ?? 0) });
        await sweepDeadSessions(state);
        expect(existsSync(p.scratch)).toBe(true);
      } finally {
        child.kill('SIGKILL');
      }
    });

    it('a record without a start time is judged by when the process started', async () => {
      const state = stateDir();
      const child = await sleeper();
      try {
        const orphan = planted(state, ID, { pid: child.pid, host, startedAt: Date.now() - 60_000 });
        const owner = planted(state, 'b'.repeat(32), { pid: child.pid, host, startedAt: Date.now() });
        await sweepDeadSessions(state);
        expect([existsSync(orphan.scratch), existsSync(owner.scratch)]).toEqual([false, true]);
      } finally {
        child.kill('SIGKILL');
      }
    });

    it('a command name with spaces and parentheses does not shift the fields', () => {
      const proc = stateDir();
      mkdirSync(path.join(proc, '42'));
      const fields = Array.from({ length: 30 }, (_, i) => String(i === 19 ? 777 : i));
      writeFileSync(path.join(proc, '42', 'stat'), `42 (a b) c) ${fields.join(' ')}\n`);
      expect(processStartTicks(42, proc)).toBe('777');
    });
  });

  it('leaves a record it cannot read, and one from another machine', async () => {
    const state = stateDir();
    const unreadable = planted(state, ID, 'not json');
    const remote = planted(state, 'b'.repeat(32), { pid: await deadPid(), host: `${host}-other`, startedAt: Date.now() });
    await sweepDeadSessions(state);
    expect([existsSync(unreadable.scratch), existsSync(remote.scratch)]).toEqual([true, true]);
  });

  it('removes a directory without a record, and only names it created', async () => {
    const state = stateDir();
    mkdirSync(path.join(scratchBase(state), ID), { recursive: true });
    mkdirSync(path.join(undoBase(state), ID), { recursive: true });
    mkdirSync(path.join(scratchBase(state), 'something-else'), { recursive: true });
    await sweepDeadSessions(state);
    expect(readdirSync(scratchBase(state))).toEqual(['something-else']);
    expect(readdirSync(undoBase(state))).toEqual([]);
  });

  it('a missing state dir is nothing to do', async () => {
    await expect(sweepDeadSessions(path.join(stateDir(), 'missing'))).resolves.toBeUndefined();
  });
});

describe('closeSessionsOnExit', () => {
  const fake = () => {
    const proc = Object.assign(new EventEmitter(), { stdin: new EventEmitter(), exits: [] as number[], exit(code: number) { proc.exits.push(code); } });
    return proc;
  };

  it.each([
    ['stdin EOF', (p: ReturnType<typeof fake>) => p.stdin.emit('end'), []],
    ['SIGTERM', (p: ReturnType<typeof fake>) => p.emit('SIGTERM'), [143]],
    ['SIGINT', (p: ReturnType<typeof fake>) => p.emit('SIGINT'), [130]],
    ['SIGHUP', (p: ReturnType<typeof fake>) => p.emit('SIGHUP'), [129]],
    ['exit', (p: ReturnType<typeof fake>) => p.emit('exit'), []],
  ])('%s removes the directories', async (_name, trigger, exits) => {
    const state = stateDir();
    const session = new SessionDirs(state);
    const dir = await session.scratch();
    const proc = fake();
    closeSessionsOnExit(proc, true);
    trigger(proc);
    expect(existsSync(dir)).toBe(false);
    expect(proc.exits).toEqual(exits);
  });

  it('leaves the exit to whoever else handles the signal', async () => {
    const proc = fake();
    closeSessionsOnExit(proc, false);
    proc.emit('SIGTERM');
    expect(proc.exits).toEqual([]);
  });
});
