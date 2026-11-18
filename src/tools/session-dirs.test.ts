import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Jail } from './jail.js';
import { SessionDirs, closeSessionsOnExit, processStartTicks, scratchBase, scratchName, sweepDeadSessions, undoBase } from './session-dirs.js';
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

const ID = randomBytes(16).toString('hex');
const ID2 = randomBytes(16).toString('hex');
const temp = realpathSync.native(os.tmpdir());
function planted(state: string, id: string, owner: unknown): { scratch: string; undo: string; record: string } {
  const scratch = path.join(temp, scratchName(id));
  const undo = path.join(undoBase(state), id);
  mkdirSync(scratch, { recursive: true });
  made.push(scratch);
  mkdirSync(undo, { recursive: true });
  mkdirSync(scratchBase(state), { recursive: true });
  const record = path.join(scratchBase(state), `${id}.json`);
  writeFileSync(record, typeof owner === 'string' ? owner : JSON.stringify({ scratch, ...(owner as object) }));
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
    expect(path.dirname(dir)).toBe(temp);
    expect(path.basename(dir)).toBe(scratchName(session.id));
    expect(dir.startsWith(state)).toBe(false);
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
    expect(existsSync(dir)).toBe(false);
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
    if (process.platform !== 'win32') symlinkSync(outside, path.join(dir, 'link'));
    session.close();
    expect(existsSync(path.join(outside, 'keep.txt'))).toBe(true);
  });
});

describe('Jail with a scratch root', () => {
  it('makes it one more root, with the protected patterns still in force', async () => {
    const state = stateDir();
    const cwd = path.join(state, 'ws');
    const scratch = path.join(state, 'tmp', 'mine');
    mkdirSync(cwd);
    mkdirSync(scratch, { recursive: true });
    const jail = await Jail.create({ cwd, roots: [], protectedPaths: [path.join(scratch, 'locked', '**')], scratchRoot: scratch });
    expect(jail.rootOf(path.join(scratch, 'a.txt'))).toBe(scratch);
    expect(() => jail.assertWritable(path.join(scratch, 'a.txt'))).not.toThrow();
    expect(() => jail.assertWritable(path.join(scratch, 'locked', 'a.txt'))).toThrow('protected');
    expect(() => jail.assertWritable(path.join(scratch, '.git', 'config'))).toThrow('.git');
  });

  it('a recorded path is taken as it is, spaces at its end included', async () => {
    const cwd = stateDir();
    mkdirSync(path.join(cwd, 'space '));
    const jail = await Jail.create({ cwd, roots: [], protectedPaths: [] });
    expect(await jail.resolveRecorded(path.join(cwd, 'space '))).toBe(path.join(cwd, 'space '));
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
        const owner = planted(state, ID2, { pid: child.pid, host, startedAt: Date.now() });
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
    const remote = planted(state, ID2, { pid: await deadPid(), host: `${host}-other`, startedAt: Date.now() });
    await sweepDeadSessions(state);
    expect([existsSync(unreadable.scratch), existsSync(remote.scratch)]).toEqual([true, true]);
  });

  it('removes saved originals without a record, and only names it created', async () => {
    const state = stateDir();
    mkdirSync(path.join(undoBase(state), ID), { recursive: true });
    mkdirSync(path.join(undoBase(state), 'something-else'), { recursive: true });
    await sweepDeadSessions(state);
    expect(readdirSync(undoBase(state))).toEqual(['something-else']);
  });

  describe('a dead owner\'s record names', () => {
    const swept = async (scratch: string): Promise<void> => {
      const state = stateDir();
      mkdirSync(scratchBase(state), { recursive: true });
      writeFileSync(path.join(scratchBase(state), `${ID}.json`), JSON.stringify({ pid: await deadPid(), host, startedAt: Date.now(), scratch }));
      await sweepDeadSessions(state);
    };

    it('a directory with another name: it stays', async () => {
      const victim = stateDir();
      writeFileSync(path.join(victim, 'keep.txt'), 'x');
      await swept(victim);
      expect(existsSync(path.join(victim, 'keep.txt'))).toBe(true);
    });

    it('the name of another session: it stays', async () => {
      const victim = path.join(temp, scratchName(ID2));
      mkdirSync(victim);
      made.push(victim);
      await swept(victim);
      expect(existsSync(victim)).toBe(true);
    });

    it('the right name outside a temp directory: it stays', async () => {
      const parent = path.join(stateDir(), 'deep');
      const victim = path.join(parent, scratchName(ID));
      mkdirSync(victim, { recursive: true });
      await swept(victim);
      expect(existsSync(victim)).toBe(true);
    });

    it('a path that climbs back to the right name: it stays', async () => {
      const victim = path.join(temp, scratchName(ID));
      mkdirSync(victim);
      made.push(victim);
      await swept(`${temp}/x/../${scratchName(ID)}`);
      expect(existsSync(victim)).toBe(true);
    });

    it.runIf(process.platform !== 'win32')('a link at the right name: neither it nor its target is removed', async () => {
      const target = stateDir();
      writeFileSync(path.join(target, 'keep.txt'), 'x');
      const link = path.join(temp, scratchName(ID));
      symlinkSync(target, link);
      made.push(link);
      await swept(link);
      expect(existsSync(path.join(target, 'keep.txt'))).toBe(true);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
    });
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
