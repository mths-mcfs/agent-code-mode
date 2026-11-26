import { execFile, execFileSync } from 'node:child_process';
import { lstatSync, type Stats } from 'node:fs';

/**
 * Reads another process's exact argv, environment, parent pid and working
 * directory on macOS, which has no `/proc`. The system perl calls
 * `__sysctl` with `{CTL_KERN, KERN_PROCARGS2, pid}` and `proc_info` with
 * `PROC_PIDTBSDINFO` and `PROC_PIDVNODEPATHINFO`, and copies the raw kernel
 * buffers to stdout; everything is parsed and validated here. The kernel
 * answers only for processes of the same user (another user's process fails
 * with EINVAL).
 */
export interface MacProcess {
  readonly argv: readonly string[];
  /** The environment region as the kernel returns it: `KEY=value` entries separated by NUL (same shape as `/proc/<pid>/environ`). */
  readonly environ: Buffer;
  readonly ppid: number;
  /** Absolute working directory, when the kernel reports one in UTF-8. */
  readonly cwd?: string;
}

export const SYSTEM_PERL = '/usr/bin/perl';

const BSDINFO_SIZE = 136;
const VNODEPATHINFO_SIZE = 2352;
const CWD_OFFSET = 152;
const MAXPATHLEN = 1024;

// Syscalls 202 (__sysctl) and 336 (proc_info). Flavors: 3 PROC_PIDTBSDINFO, 9 PROC_PIDVNODEPATHINFO.
const PERL_SCRIPT = String.raw`
my $pid = $ARGV[0] + 0;
my $amib = pack("i2", 1, 8); my $amax = pack("i", 0); my $alen = pack("Q", 4);
syscall(202, $amib, 2, $amax, $alen, 0, 0) == 0 or die "KERN_ARGMAX: $!\n";
my $max = unpack("i", $amax);
my $mib = pack("i3", 1, 49, $pid); my $buf = "\0" x $max; my $len = pack("Q", $max);
syscall(202, $mib, 3, $buf, $len, 0, 0) == 0 or die "KERN_PROCARGS2: $!\n";
$len = unpack("Q", $len);
my $bsd = "\0" x ${BSDINFO_SIZE}; my $bn = syscall(336, 2, $pid, 3, 0, $bsd, ${BSDINFO_SIZE});
my $vp = "\0" x ${VNODEPATHINFO_SIZE}; my $vn = syscall(336, 2, $pid, 9, 0, $vp, ${VNODEPATHINFO_SIZE});
binmode STDOUT;
print pack("q", $len), substr($buf, 0, $len), pack("q", $bn), $bsd, pack("q", $vn), $vp;
`;

export function checkSystemPerl(st: Pick<Stats, 'uid' | 'mode' | 'isFile'>): void {
  if (!st.isFile() || st.uid !== 0 || (st.mode & 0o022) !== 0) throw new Error(`${SYSTEM_PERL} is not a regular root-owned file writable only by root`);
}

/**
 * How perl runs: by absolute path, from `/`, with an empty environment (no `PERL5LIB`, `PERL5OPT` or
 * `PERL5DB`) and an inline `-e` script, so nothing in the workspace or the environment steers it.
 */
export function macPerlInvocation(pid: number): { file: string; args: string[]; cwd: string; env: Record<string, string> } {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`invalid process id ${String(pid)}`);
  return { file: SYSTEM_PERL, args: ['-e', PERL_SCRIPT, String(pid)], cwd: '/', env: {} };
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

function utf8(bytes: Uint8Array): string | undefined {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * `KERN_PROCARGS2`: `int argc`, the exec path, NUL padding to an 8-byte boundary of the string area, then
 * `argc` NUL-terminated arguments and the environment. The arguments start at the computed boundary, so an
 * empty argument (even `argv[0]`) is kept rather than taken for padding.
 */
function splitProcargs(args: Buffer): { argv: string[]; environ: Buffer } {
  if (args.length < 4) throw new Error('the argument area is shorter than its header');
  const argc = args.readInt32LE(0);
  const pathEnd = args.indexOf(0, 4);
  const start = 4 + Math.ceil((pathEnd - 4 + 1) / 8) * 8;
  if (argc < 0 || pathEnd === -1 || start > args.length || args.subarray(pathEnd, start).some((b) => b !== 0)) {
    throw new Error('the argument area is not in the expected layout');
  }
  const argv: string[] = [];
  let at = start;
  for (let i = 0; i < argc; i++) {
    const end = args.indexOf(0, at);
    if (end === -1) throw new Error(`the argument area ends inside argument ${i}`);
    const arg = utf8(args.subarray(at, end));
    if (arg === undefined) throw new Error(`argument ${i} is not valid UTF-8`);
    argv.push(arg);
    at = end + 1;
  }
  return { argv, environ: args.subarray(at) };
}

export function parseMacProcess(pid: number, out: Buffer): MacProcess {
  let at = 0;
  const section = (fixed?: number): { result: number; bytes: Buffer } => {
    if (out.length < at + 8) throw new Error('the output is truncated');
    const result = Number(out.readBigInt64LE(at));
    const size = fixed ?? result;
    if (size < 0 || out.length < at + 8 + size) throw new Error('the output is truncated');
    const bytes = out.subarray(at + 8, at + 8 + size);
    at += 8 + size;
    return { result, bytes };
  };
  const args = section();
  const bsd = section(BSDINFO_SIZE);
  const vnode = section(VNODEPATHINFO_SIZE);
  if (at !== out.length) throw new Error('the output has trailing bytes');
  if (bsd.result !== BSDINFO_SIZE || bsd.bytes.readUInt32LE(12) !== pid) throw new Error('its parent process id cannot be read');
  const { argv, environ } = splitProcargs(args.bytes);
  const path = vnode.bytes.subarray(CWD_OFFSET, CWD_OFFSET + MAXPATHLEN);
  const end = path.indexOf(0);
  const cwd = vnode.result === VNODEPATHINFO_SIZE && end !== -1 ? utf8(path.subarray(0, end)) : undefined;
  return { argv, environ, ppid: bsd.bytes.readUInt32LE(16), ...(cwd?.startsWith('/') ? { cwd } : {}) };
}

function failure(pid: number, err: unknown, stderr?: Buffer): Error {
  const output = stderr ?? (err instanceof Error && 'stderr' in err && Buffer.isBuffer(err.stderr) ? err.stderr : undefined);
  const detail = output?.toString().trim() || (err instanceof Error ? err.message : String(err));
  return new Error(`process ${pid} cannot be read on macOS: ${detail}`);
}

function prepare(pid: number): ReturnType<typeof macPerlInvocation> {
  const run = macPerlInvocation(pid);
  try {
    checkSystemPerl(lstatSync(run.file));
  } catch (err) {
    throw failure(pid, err);
  }
  return run;
}

const LIMITS = { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 } as const;

export function readMacProcessSync(pid: number): MacProcess {
  const run = prepare(pid);
  try {
    return parseMacProcess(pid, execFileSync(run.file, run.args, { cwd: run.cwd, env: run.env, stdio: ['ignore', 'pipe', 'pipe'], ...LIMITS }));
  } catch (err) {
    throw failure(pid, err);
  }
}

export async function readMacProcess(pid: number): Promise<MacProcess> {
  const run = prepare(pid);
  return new Promise((resolve, reject) => {
    execFile(run.file, run.args, { cwd: run.cwd, env: run.env, encoding: 'buffer', ...LIMITS }, (err, stdout, stderr) => {
      if (err) return reject(failure(pid, err, stderr));
      try {
        resolve(parseMacProcess(pid, stdout));
      } catch (parseErr) {
        reject(failure(pid, parseErr));
      }
    });
  });
}
