import { spawn, spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import type { Socket } from 'node:net';
import { z } from 'zod';
import { errorMessage } from '../core/errors.js';
import { systemPowerShell } from '../core/windows-powershell.js';

export interface ProcessEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  /** Session id; null where the platform does not report it (macOS). */
  readonly sid: number | null;
  /** When the process started, on the table's clock: with the pid, it names one process. */
  readonly start: number;
}

/** What the sweep reads and signals; the real one is the OS process table. */
export interface ProcessTable {
  list(): ProcessEntry[];
  /** Start time of each pid that still exists. */
  startTimes(pids: readonly number[]): Map<number, number>;
  /** The current time on the clock of `start`. */
  now(): number;
  /** The granularity of `start`, in its units: a start time names that whole interval. */
  readonly resolution: number;
  /** False when the signal was not delivered. */
  signal(pid: number, sig: NodeJS.Signals): boolean;
}

/** `/proc/<pid>/stat` after the command name, which may itself hold spaces and parentheses: field 3 is index 0. */
function procStatFields(stat: string): string[] {
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ');
}

function readProcStat(pid: number): string[] | null {
  try {
    return procStatFields(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return null;
  }
}

let clockTicks: number | undefined;

/** Clock ticks per second of `/proc/<pid>/stat` start times. */
function ticksPerSecond(): number {
  clockTicks ??= Number(spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).stdout?.trim()) || 100;
  return clockTicks;
}

const linuxTable: Omit<ProcessTable, 'signal'> = {
  list() {
    const out: ProcessEntry[] = [];
    for (const name of readdirSync('/proc')) {
      const pid = Number(name);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      const f = readProcStat(pid);
      const [ppid, pgid, sid, start] = [f?.[1], f?.[2], f?.[3], f?.[19]].map(Number);
      if (ppid === undefined || pgid === undefined || sid === undefined || start === undefined || ![ppid, pgid, sid, start].every(Number.isInteger)) continue;
      out.push({ pid, ppid, pgid, sid, start });
    }
    return out;
  },
  startTimes(pids) {
    const out = new Map<number, number>();
    for (const pid of pids) {
      const start = Number(readProcStat(pid)?.[19]);
      if (Number.isInteger(start)) out.set(pid, start);
    }
    return out;
  },
  now() {
    return Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]) * ticksPerSecond();
  },
  resolution: 1,
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `ps -o lstart` in the C locale, such as `Wed Nov 25 18:00:00 2026`, as epoch milliseconds (whole seconds). */
function parseLstart(text: string): number | undefined {
  const m = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(text);
  const month = m ? MONTHS.indexOf(m[1] ?? '') : -1;
  if (!m || month < 0) return undefined;
  return new Date(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])).getTime();
}

/** `ps` rows of `pid ppid pgid start`, where `lstart` (a date with spaces) runs to the end of the line. */
function psRows(args: readonly string[]): { pid: number; ppid: number; pgid: number; start: number }[] {
  const r = spawnSync('ps', args, { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  return (r.stdout ?? '').split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S.*\S)\s*$/.exec(line);
    const start = m ? parseLstart(m[4] ?? '') : undefined;
    return m && start !== undefined ? [{ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), start }] : [];
  });
}

const PS_COLUMNS = ['-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'lstart='];

const psTable: Omit<ProcessTable, 'signal'> = {
  list() {
    return psRows(['-A', ...PS_COLUMNS]).map((r) => ({ ...r, sid: null }));
  },
  startTimes(pids) {
    if (pids.length === 0) return new Map();
    return new Map(psRows([...PS_COLUMNS, '-p', pids.join(',')]).map((r) => [r.pid, r.start]));
  },
  now: () => Date.now(),
  resolution: 1000,
};

function sendSignal(pid: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false;
  }
}

const osTable: ProcessTable = { ...(process.platform === 'linux' ? linuxTable : psTable), signal: sendSignal };

/** The shell a call spawned detached, so it leads its own session and process group. */
export interface SessionLeader {
  readonly pid: number;
  /** When its exit was seen, on the table's clock; undefined while it is not known to have exited. */
  readonly exitedAt?: number;
  /** A process of the call that keeps its group and session ids reserved while it lives. */
  readonly sentinel?: { readonly pid: number; readonly start: number };
}

/** Identifies the sentinel `pid` reported, by its start time, if it is in the group `groupId`. */
export function sentinelOf(pid: number, groupId: number, table: ProcessTable = osTable): { pid: number; start: number } | undefined {
  const row = table.list().find((p) => p.pid === pid && p.pgid === groupId);
  return row ? { pid, start: row.start } : undefined;
}

export function processClock(table: ProcessTable = osTable): number {
  return table.now();
}

/**
 * Kills every process of the call that `leader` leads that can be proven to
 * belong to it: its process group, its session where the platform reports
 * one, and every descendant of those, until a round finds nothing new.
 *
 * A pid or group id is only a number, which the OS hands to another process
 * once its own is gone, and signalling a stranger is worse than leaving a
 * survivor. So a process whose membership or identity cannot be proven gets
 * no signal and is returned in `skipped`, for the call to report:
 * - Until the leader's exit is seen, Node has not reaped it, so its pid and
 *   ids still name it (alive or a zombie): the group is ours and is
 *   signalled. Once the exit is seen, the group is signalled by id only while
 *   the call's sentinel, checked by pid, start time and group, lives in it,
 *   because then the ids cannot have gone to another process.
 * - After the exit with no sentinel, a process counts as a member by its group or session id
 *   only if it started strictly before the clock interval the exit was seen
 *   in: the ids stay reserved while any member lives, so they could have
 *   gone to another process only after the exit.
 * - Each process is stopped first and kept only if its start time still
 *   matches the one read with it; a stopped process cannot exit, so its pid
 *   keeps naming it. One that changed is resumed.
 */
export function killPosixTree(leader: SessionLeader, table: ProcessTable = osTable): { readonly skipped: readonly number[] } {
  const id = leader.pid;
  const s = leader.sentinel;
  const sentinelHolds = (): boolean => s !== undefined && table.list().some((p) => p.pid === s.pid && p.start === s.start && p.pgid === id);
  const groupOurs = leader.exitedAt === undefined || sentinelHolds();
  const bound = groupOurs || leader.exitedAt === undefined ? Infinity : Math.floor(leader.exitedAt / table.resolution) * table.resolution;
  if (groupOurs) table.signal(-id, 'SIGSTOP');
  const found = new Map<number, number>();
  const skipped: number[] = [];
  for (let round = 0; round < 100; round++) {
    const stopped: ProcessEntry[] = [];
    for (const p of table.list()) {
      if (found.has(p.pid) || p.pid === process.pid || skipped.includes(p.pid)) continue;
      const byId = p.pgid === id || p.sid === id;
      if (!found.has(p.ppid) && !byId) continue;
      if (!found.has(p.ppid) && p.start >= bound) {
        skipped.push(p.pid);
        continue;
      }
      if (table.signal(p.pid, 'SIGSTOP')) stopped.push(p);
    }
    if (stopped.length === 0) break;
    const now = table.startTimes(stopped.map((p) => p.pid));
    for (const p of stopped) {
      if (now.get(p.pid) === p.start) found.set(p.pid, p.start);
      else if (now.has(p.pid)) {
        table.signal(p.pid, 'SIGCONT');
        skipped.push(p.pid);
      }
    }
  }
  if (leader.exitedAt === undefined || sentinelHolds()) table.signal(-id, 'SIGKILL');
  const before = table.startTimes([...found.keys()]);
  for (const [pid, start] of found) {
    if (before.get(pid) === start) table.signal(pid, 'SIGKILL');
    else if (before.has(pid)) skipped.push(pid);
  }
  return { skipped };
}

/** Node cannot create a Job Object, so a Windows PowerShell process compiles this class and owns them. */
const HELPER_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class AcmJobs {
  [StructLayout(LayoutKind.Sequential)]
  struct BasicLimit {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct IoCounters { public ulong A, B, C, D, E, F; }
  [StructLayout(LayoutKind.Sequential)]
  struct ExtendedLimit {
    public BasicLimit Basic; public IoCounters Io; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct Accounting {
    public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct ProcessEntry {
    public uint dwSize; public uint cntUsage; public uint th32ProcessID; public IntPtr th32DefaultHeapID;
    public uint th32ModuleID; public uint cntThreads; public uint th32ParentProcessID; public int pcPriClassBase;
    public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr attrs, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref ExtendedLimit info, int size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int cls, out Accounting info, int size, IntPtr ret);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr p, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32FirstW(IntPtr snap, ref ProcessEntry e);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32NextW(IntPtr snap, ref ProcessEntry e);

  const uint PROCESS_TERMINATE = 0x0001, PROCESS_SET_QUOTA = 0x0100, PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  const uint ProcessAccess = PROCESS_TERMINATE | PROCESS_SET_QUOTA | PROCESS_QUERY_LIMITED_INFORMATION;
  const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000, TH32CS_SNAPPROCESS = 2;
  const int JobObjectBasicAccountingInformation = 1, JobObjectExtendedLimitInformation = 9;
  static readonly Dictionary<long, IntPtr> jobs = new Dictionary<long, IntPtr>();
  static long next = 0;

  static string Fail(string what) { return "err " + what + " failed (error " + Marshal.GetLastWin32Error() + ")"; }

  static long CreatedAt(IntPtr p) {
    long created, exited, kernel, user;
    return GetProcessTimes(p, out created, out exited, out kernel, out user) ? created : long.MaxValue;
  }

  static List<KeyValuePair<uint, uint>> Snapshot() {
    var all = new List<KeyValuePair<uint, uint>>();
    IntPtr snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == new IntPtr(-1)) return all;
    var e = new ProcessEntry(); e.dwSize = (uint)Marshal.SizeOf(typeof(ProcessEntry));
    for (bool ok = Process32FirstW(snap, ref e); ok; ok = Process32NextW(snap, ref e)) all.Add(new KeyValuePair<uint, uint>(e.th32ProcessID, e.th32ParentProcessID));
    CloseHandle(snap);
    return all;
  }

  static string Attach(uint pid) {
    IntPtr root = OpenProcess(ProcessAccess, false, pid);
    if (root == IntPtr.Zero) return Fail("OpenProcess");
    IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
    if (job == IntPtr.Zero) { CloseHandle(root); return Fail("CreateJobObject"); }
    var info = new ExtendedLimit(); info.Basic.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref info, Marshal.SizeOf(typeof(ExtendedLimit)))) { CloseHandle(root); CloseHandle(job); return Fail("SetInformationJobObject"); }
    if (!AssignProcessToJobObject(job, root)) { string r = Fail("AssignProcessToJobObject"); CloseHandle(root); CloseHandle(job); return r; }
    // Every process started from now on is born in the job. The ones started
    // before (the Git for Windows launcher starts its bash at once) are added
    // here: they are blocked on stdin, so none starts another meanwhile.
    var created = new Dictionary<uint, long>(); created[pid] = CreatedAt(root);
    CloseHandle(root);
    bool grew = true;
    while (grew) {
      grew = false;
      foreach (var p in Snapshot()) {
        if (created.ContainsKey(p.Key) || !created.ContainsKey(p.Value)) continue;
        IntPtr h = OpenProcess(ProcessAccess, false, p.Key);
        if (h == IntPtr.Zero) continue;
        long at = CreatedAt(h);
        // A parent id can name an earlier process that had the same pid.
        if (at < created[p.Value]) { CloseHandle(h); continue; }
        if (!AssignProcessToJobObject(job, h)) { string r = Fail("AssignProcessToJobObject"); CloseHandle(h); CloseHandle(job); return r; }
        CloseHandle(h);
        created[p.Key] = at; grew = true;
      }
    }
    long id = ++next; jobs[id] = job;
    return "ok " + id;
  }

  static string Kill(long id) {
    IntPtr job;
    if (!jobs.TryGetValue(id, out job)) return "err unknown job " + id;
    jobs.Remove(id);
    string failed = TerminateJobObject(job, 1) ? null : Fail("TerminateJobObject");
    uint active = 0;
    for (int i = 0; i < 200; i++) {
      Accounting a;
      if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, out a, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) { failed = failed ?? Fail("QueryInformationJobObject"); break; }
      active = a.ActiveProcesses;
      if (active == 0) break;
      System.Threading.Thread.Sleep(25);
    }
    CloseHandle(job);
    if (failed != null) return failed;
    return active == 0 ? "ok" : "err " + active + " processes still running after the job was terminated";
  }

  public static void Serve() {
    Console.Out.WriteLine("ready"); Console.Out.Flush();
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      string[] parts = line.Split(' ');
      string answer;
      try {
        if (parts.Length == 2 && parts[0] == "attach") answer = Attach(uint.Parse(parts[1]));
        else if (parts.Length == 2 && parts[0] == "kill") answer = Kill(long.Parse(parts[1]));
        else answer = "err bad request";
      } catch (Exception e) { answer = "err " + e.Message.Replace("\n", " "); }
      Console.Out.WriteLine(answer); Console.Out.Flush();
    }
  }
}
`;

const HELPER_SCRIPT = `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n${HELPER_SOURCE}\n'@\n[AcmJobs]::Serve()\n`;

const HELPER_ANSWER_MS = 60_000;

class JobHelper {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #waiting: { resolve: (line: string) => void; reject: (err: Error) => void }[] = [];
  #buffer = '';
  #stderr = '';
  #dead: Error | undefined;

  constructor() {
    const run = systemPowerShell(process.env);
    const encoded = Buffer.from(HELPER_SCRIPT, 'utf16le').toString('base64');
    this.#child = spawn(run.file, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { cwd: run.cwd, env: run.env, windowsHide: true });
    this.#child.unref();
    // Child stdio pipes are sockets; unref'd, the idle helper never keeps the process alive.
    for (const s of [this.#child.stdin, this.#child.stdout, this.#child.stderr]) (s as Socket).unref();
    this.#child.stdout.setEncoding('utf8');
    this.#child.stdout.on('data', (chunk: string) => this.#onData(chunk));
    this.#child.stderr.setEncoding('utf8');
    this.#child.stderr.on('data', (chunk: string) => {
      if (this.#stderr.length < 4096) this.#stderr += chunk;
    });
    this.#child.stdin.on('error', () => undefined);
    this.#child.once('error', (e) => this.#die(e.message));
    this.#child.once('exit', (code) => this.#die(`it exited with code ${code}`));
  }

  ready(): Promise<string> {
    return this.#expect(HELPER_ANSWER_MS);
  }

  get alive(): boolean {
    return this.#dead === undefined;
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  request(line: string): Promise<string> {
    if (this.#dead) return Promise.reject(this.#dead);
    const answer = this.#expect(HELPER_ANSWER_MS);
    this.#child.stdin.write(`${line}\n`);
    return answer;
  }

  #expect(timeoutMs: number): Promise<string> {
    if (this.#dead) return Promise.reject(this.#dead);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#child.kill(), timeoutMs);
      timer.unref();
      this.#waiting.push({
        resolve: (l) => {
          clearTimeout(timer);
          resolve(l);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let nl: number;
    while ((nl = this.#buffer.indexOf('\n')) !== -1) {
      const line = this.#buffer.slice(0, nl).replace(/\r$/, '');
      this.#buffer = this.#buffer.slice(nl + 1);
      this.#waiting.shift()?.resolve(line);
    }
  }

  #die(why: string): void {
    if (this.#dead) return;
    const detail = this.#stderr.trim().split('\n')[0];
    this.#dead = new Error(`the Windows job helper stopped: ${why}${detail ? ` (${detail})` : ''}`);
    for (const w of this.#waiting.splice(0)) w.reject(this.#dead);
  }
}

let helper: Promise<JobHelper> | undefined;
let started: JobHelper | undefined;

function jobHelper(): Promise<JobHelper> {
  if (helper === undefined || (started !== undefined && !started.alive)) {
    started = undefined;
    const next = (async () => {
      const h = new JobHelper();
      const first = await h.ready();
      if (!ReadyReply.safeParse(first).success) throw new Error(`the Windows job helper did not start: ${first}`);
      started = h;
      return h;
    })();
    next.catch(() => {
      if (helper === next) helper = undefined;
    });
    helper = next;
  }
  return helper;
}

/** The running helper's process id, for tests that stop it. */
export function windowsJobHelperPid(): number | undefined {
  return started?.alive ? started.pid : undefined;
}

const ReadyReply = z.literal('ready');
const ErrReply = z
  .string()
  .regex(/^err ./)
  .transform((line) => ({ ok: false as const, reason: line.slice(4) }));
const AttachReply = z.union([
  z
    .string()
    .regex(/^ok [1-9][0-9]*$/)
    .transform((line) => ({ ok: true as const, id: line.slice(3) })),
  ErrReply,
]);
const KillReply = z.union([z.literal('ok').transform(() => ({ ok: true as const })), ErrReply]);

/** One request to the helper and its answer line. */
export type HelperRequest = (line: string) => Promise<string>;

export interface WindowsJob {
  /** Resolves once the job has no process left; rejects with the reason when that is not confirmed. */
  kill(): Promise<void>;
}

/**
 * Puts `pid`, and every process it already started, in a new Job Object
 * through `request`. Every answer is checked against the protocol.
 */
export async function attachJob(pid: number, request: HelperRequest): Promise<WindowsJob> {
  const attached = AttachReply.safeParse(await request(`attach ${pid}`));
  if (!attached.success) throw new Error('the Windows job helper answered an attach outside its protocol');
  if (!attached.data.ok) throw new Error(attached.data.reason);
  const id = attached.data.id;
  let killed: Promise<void> | undefined;
  return {
    kill: () =>
      (killed ??= (async () => {
        let line: string;
        try {
          line = await request(`kill ${id}`);
        } catch {
          // The helper is gone: the OS closed its handles, and closing a job kills its processes.
          return;
        }
        const reply = KillReply.safeParse(line);
        if (!reply.success) throw new Error('the Windows job helper answered a kill outside its protocol');
        if (!reply.data.ok) throw new Error(reply.data.reason);
      })()),
  };
}

/**
 * Starts `child`, which waits on stdin, only once it is in its own Job
 * Object: a call `stopped` by then never runs its command, and one whose
 * job cannot be made is killed while it has started nothing.
 */
export async function startInWindowsJob(child: ChildProcess, stopped: () => boolean): Promise<WindowsJob> {
  try {
    if (child.pid === undefined) throw new Error('bash did not start');
    const pid = child.pid;
    let job: WindowsJob;
    try {
      const h = await jobHelper();
      job = await attachJob(pid, (line) => h.request(line));
    } catch (err) {
      throw new Error(`bash on Windows needs a Job Object to own its processes: ${errorMessage(err)}`);
    }
    if (stopped()) child.stdin?.destroy();
    else child.stdin?.end('\n');
    return job;
  } catch (err) {
    child.stdin?.destroy();
    child.kill('SIGKILL');
    throw err;
  }
}
