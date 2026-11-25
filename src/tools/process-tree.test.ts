import { describe, expect, it } from 'vitest';
import { attachJob, killPosixTree, type ProcessEntry, type ProcessTable } from './process-tree.js';

/**
 * A process table at time 1000 where `reused` pids name another process by
 * the time they are stopped, and `gone` pids no longer exist.
 */
function fakeTable(rows: ProcessEntry[], opts: { reused?: number[]; unstoppable?: number[]; gone?: number[] } = {}) {
  const signals: string[] = [];
  const stoppedOnce = new Set<number>();
  const table: ProcessTable = {
    list: () => rows.filter((r) => !opts.gone?.includes(r.pid)),
    startTimes: (pids) => {
      const out = new Map<number, number>();
      for (const pid of pids) {
        const row = rows.find((r) => r.pid === pid);
        if (!row || opts.gone?.includes(pid)) continue;
        out.set(pid, opts.reused?.includes(pid) && stoppedOnce.has(pid) ? row.start + 1 : row.start);
      }
      return out;
    },
    now: () => 1000,
    signal: (pid, sig) => {
      if (sig === 'SIGSTOP' && opts.unstoppable?.includes(pid)) return false;
      if (sig === 'SIGSTOP') stoppedOnce.add(pid);
      signals.push(`${sig} ${pid}`);
      return true;
    },
  };
  return { table, signals };
}

const row = (pid: number, ppid: number, pgid: number, sid: number | null = null, start = pid): ProcessEntry => ({ pid, ppid, pgid, sid, start });
const leader = (pid: number, start: number | undefined, exitedAt?: number) => ({ pid, start, ...(exitedAt === undefined ? {} : { exitedAt }) });

describe('killPosixTree', () => {
  it('kills the group, the session and every descendant while the leader runs', () => {
    const { table, signals } = fakeTable([row(100, 1, 100, 100), row(101, 100, 101, 100), row(102, 101, 102, 102), row(200, 1, 200, 200)]);
    expect(killPosixTree(leader(100, 100), table).skipped).toEqual([]);
    expect(signals[0]).toBe('SIGSTOP -100');
    expect(signals.filter((s) => s.startsWith('SIGKILL'))).toEqual(['SIGKILL -100', 'SIGKILL 100', 'SIGKILL 101', 'SIGKILL 102']);
  });

  it('never signals a group by its id once the leader is gone', () => {
    const { table, signals } = fakeTable([], {});
    killPosixTree(leader(12345, 7, 900), table);
    expect(signals).toEqual([]);
  });

  it('never signals a group whose leader id now names another process', () => {
    const { table, signals } = fakeTable([row(12345, 1, 12345, 12345, 950)]);
    killPosixTree(leader(12345, 7), table);
    expect(signals.some((s) => s.includes('-12345'))).toBe(false);
  });

  it('after the leader exited, kills members that started before the exit and their children, not later ones', () => {
    const { table, signals } = fakeTable([row(101, 1, 100, 100, 500), row(102, 101, 102, 102, 950), row(103, 1, 100, 100, 950)], { gone: [100] });
    killPosixTree(leader(100, 10, 900), table);
    expect(signals.filter((s) => s.startsWith('SIGKILL'))).toEqual(['SIGKILL 101', 'SIGKILL 102']);
    expect(signals.some((s) => s.endsWith(' 103'))).toBe(false);
  });

  it('never kills a pid that named another process by the time it was stopped, nor that process children', () => {
    const { table, signals } = fakeTable([row(100, 1, 100), row(101, 100, 999), row(102, 101, 999)], { reused: [101] });
    expect(killPosixTree(leader(100, 100), table).skipped).toEqual([101]);
    expect(signals).toContain('SIGCONT 101');
    expect(signals).not.toContain('SIGKILL 101');
    expect(signals.some((s) => s.endsWith(' 102'))).toBe(false);
  });

  it('never kills a pid it could not stop', () => {
    const { table, signals } = fakeTable([row(100, 1, 100), row(101, 100, 999)], { unstoppable: [101] });
    killPosixTree(leader(100, 100), table);
    expect(signals).not.toContain('SIGKILL 101');
  });
});

describe('Windows job helper protocol', () => {
  const helper = (answers: Record<string, string | Error>) => (line: string) => {
    const a = answers[line.split(' ')[0] ?? ''];
    return a instanceof Error ? Promise.reject(a) : Promise.resolve(a ?? 'err no answer');
  };

  it('attaches with an id and kills with ok', async () => {
    const job = await attachJob(42, helper({ attach: 'ok 7', kill: 'ok' }));
    await expect(job.kill()).resolves.toBeUndefined();
  });

  it('reports a kill the helper could not complete as a failure', async () => {
    const job = await attachJob(42, helper({ attach: 'ok 7', kill: 'err 1 processes still running after the job was terminated' }));
    await expect(job.kill()).rejects.toThrow(/still running/);
  });

  it('refuses answers outside the protocol', async () => {
    for (const bad of ['ok', 'ok 0', 'ok 7 extra', 'yes', 'err ']) {
      await expect(attachJob(42, helper({ attach: bad })), bad).rejects.toThrow();
    }
    const job = await attachJob(42, helper({ attach: 'ok 7', kill: 'done' }));
    await expect(job.kill()).rejects.toThrow(/protocol/);
  });

  it('counts a kill as done when the helper is gone, since closing it closed the job', async () => {
    const job = await attachJob(42, helper({ attach: 'ok 7', kill: new Error('the Windows job helper stopped') }));
    await expect(job.kill()).resolves.toBeUndefined();
  });
});
