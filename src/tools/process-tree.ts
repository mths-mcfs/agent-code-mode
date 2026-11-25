import { spawn, spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import type { Socket } from 'node:net';
import path from 'node:path';
import { errorMessage } from '../core/errors.js';

interface ProcessEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  /** Session id; null where the platform does not report it (macOS). */
  readonly sid: number | null;
}

/** Fields after the command name of `/proc/<pid>/stat`, which may itself hold spaces and parentheses. */
function parseProcStat(pid: number, stat: string): ProcessEntry | null {
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const ppid = Number(fields[1]);
  const pgid = Number(fields[2]);
  const sid = Number(fields[3]);
  if (!Number.isInteger(ppid) || !Number.isInteger(pgid) || !Number.isInteger(sid)) return null;
  return { pid, ppid, pgid, sid };
}

function listLinuxProcesses(): ProcessEntry[] {
  const out: ProcessEntry[] = [];
  for (const name of readdirSync('/proc')) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      const entry = parseProcStat(pid, readFileSync(`/proc/${name}/stat`, 'utf8'));
      if (entry) out.push(entry);
    } catch {}
  }
  return out;
}

function listPsProcesses(): ProcessEntry[] {
  const r = spawnSync('ps', ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid='], { encoding: 'utf8' });
  const out: ProcessEntry[] = [];
  for (const line of (r.stdout ?? '').split('\n')) {
    const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
    if (pid !== undefined && ppid !== undefined && pgid !== undefined && [pid, ppid, pgid].every(Number.isInteger)) {
      out.push({ pid, ppid, pgid, sid: null });
    }
  }
  return out;
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {}
}

/**
 * Each process found is stopped before the table is read again, so none can
 * fork a child the sweep misses or exit and orphan one.
 *
 * Group and session ids stay reserved while any member lives, and a stopped
 * process keeps its pid, so no id this matches can belong to an unrelated
 * process.
 */
export function killPosixTree(sessionLeader: number): void {
  signal(-sessionLeader, 'SIGSTOP');
  const list = process.platform === 'linux' ? listLinuxProcesses : listPsProcesses;
  const found = new Set<number>();
  for (let round = 0; round < 100; round++) {
    let added = false;
    for (const p of list()) {
      if (found.has(p.pid) || p.pid === process.pid) continue;
      if (p.pgid === sessionLeader || p.sid === sessionLeader || found.has(p.ppid)) {
        found.add(p.pid);
        signal(p.pid, 'SIGSTOP');
        added = true;
      }
    }
    if (!added) break;
  }
  signal(-sessionLeader, 'SIGKILL');
  for (const pid of found) signal(pid, 'SIGKILL');
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
        if (at >= created[p.Value] && AssignProcessToJobObject(job, h)) { created[p.Key] = at; grew = true; }
        CloseHandle(h);
      }
    }
    long id = ++next; jobs[id] = job;
    return "ok " + id;
  }

  static string Kill(long id) {
    IntPtr job;
    if (!jobs.TryGetValue(id, out job)) return "err unknown job " + id;
    jobs.Remove(id);
    TerminateJobObject(job, 1);
    for (int i = 0; i < 200; i++) {
      Accounting a;
      if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, out a, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero) || a.ActiveProcesses == 0) break;
      System.Threading.Thread.Sleep(25);
    }
    CloseHandle(job);
    return "ok";
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
    const powershell = path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const encoded = Buffer.from(HELPER_SCRIPT, 'utf16le').toString('base64');
    this.#child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true });
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
      if (first !== 'ready') throw new Error(`the Windows job helper did not start: ${first}`);
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

export interface WindowsJob {
  kill(): Promise<void>;
}

export async function startInWindowsJob(child: ChildProcess, stopped: () => boolean): Promise<WindowsJob> {
  try {
    if (child.pid === undefined) throw new Error('bash did not start');
    const job = await attachWindowsJob(child.pid);
    if (stopped()) child.stdin?.destroy();
    else child.stdin?.end('\n');
    return job;
  } catch (err) {
    child.stdin?.destroy();
    child.kill('SIGKILL');
    throw err;
  }
}

async function attachWindowsJob(pid: number): Promise<WindowsJob> {
  let h: JobHelper;
  let answer: string;
  try {
    h = await jobHelper();
    answer = await h.request(`attach ${pid}`);
  } catch (err) {
    throw new Error(`bash on Windows needs a Job Object to own its processes: ${errorMessage(err)}`);
  }
  const [status, id] = answer.split(' ', 2);
  if (status !== 'ok' || id === undefined) throw new Error(`bash on Windows needs a Job Object to own its processes: ${answer.replace(/^err /, '')}`);
  let killed: Promise<void> | undefined;
  return {
    kill: () => {
      // A dead helper already closed the job, which killed its processes.
      killed ??= h.request(`kill ${id}`).then(
        () => undefined,
        () => undefined,
      );
      return killed;
    },
  };
}
