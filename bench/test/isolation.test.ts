import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createCodexHome, HOME_MARKER, removeCodexHome, sweepStaleHomes, syncBack } from '../lib/codex-home.ts';

const BENCH = path.join(import.meta.dirname, '..');
const CATALOG = path.join(BENCH, 'parser-fixtures', 'codex-catalog.json');
const posix = process.platform !== 'win32';
const ORIGINAL = JSON.stringify({ token: 'FAKE_AUTH_ONLY', refresh: 'r1' });
const REFRESHED = JSON.stringify({ token: 'REFRESHED', refresh: 'r2' });
const OTHER = JSON.stringify({ token: 'OTHER_LOGIN', refresh: 'r9' });
const ARM_A_TOOLS = z.object({ A: z.array(z.string()) }).parse(JSON.parse(readFileSync(path.join(BENCH, 'parser-fixtures', 'codex-surfaces.json'), 'utf8'))).A.map((t) => ({ type: 'function', name: t.replace(/^functions\./, '') }));

type ExecMode = 'hang' | 'exit' | 'refresh-hang' | 'refresh-exit' | 'refresh-conflict-exit';

function fakeCodex(pidFile: string, mode: ExecMode, realAuth: string): string {
  return `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const a = process.argv.slice(2);
const mode = ${JSON.stringify(mode)};
if (a[0] === '--version') { console.log('codex-cli 0.169.0'); process.exit(0); }
if (a[0] === 'debug' && a[1] === 'models') { process.stdout.write(fs.readFileSync(${JSON.stringify(CATALOG)}, 'utf8')); process.exit(0); }
if (a[0] === 'debug' && a[1] === 'prompt-input') { console.log(JSON.stringify([{ type: 'additional_tools', tools: [{ type: 'namespace', name: 'functions', tools: ${JSON.stringify(ARM_A_TOOLS)} }] }])); process.exit(0); }
if (a[0] !== 'exec') process.exit(2);
const first = !fs.existsSync(${JSON.stringify(pidFile)});
if (first && mode.startsWith('refresh')) {
  const auth = path.join(process.env.CODEX_HOME, 'auth.json');
  fs.writeFileSync(auth + '.tmp', ${JSON.stringify(REFRESHED)}, { mode: 0o600 });
  fs.renameSync(auth + '.tmp', auth);
}
if (first && mode === 'refresh-conflict-exit') fs.writeFileSync(${JSON.stringify(realAuth)}, ${JSON.stringify(OTHER)});
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
if (mode.endsWith('hang')) setInterval(() => {}, 1000);
else {
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'ANSWER: 7' } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 } }));
  process.exit(0);
}
`;
}

async function authFiles(dir: string): Promise<{ file: string; symlink: boolean; mode: number }[]> {
  let files: string[] = [];
  try {
    files = await readdir(dir, { recursive: true });
  } catch {
    return [];
  }
  const out: { file: string; symlink: boolean; mode: number }[] = [];
  for (const f of files.filter((x) => path.basename(x) === 'auth.json')) {
    const st = await lstat(path.join(dir, f));
    out.push({ file: f, symlink: st.isSymbolicLink(), mode: st.mode & 0o777 });
  }
  return out;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface Harness {
  readonly root: string;
  readonly work: string;
  readonly realAuth: string;
  readonly exec: number;
  readonly sig: string | null;
  readonly code: number | null;
  readonly stderr: string;
}

async function harness(mode: ExecMode, signal?: NodeJS.Signals): Promise<Harness> {
  const root = await mkdtemp(path.join(os.tmpdir(), `acm-iso-${mode}-`));
  const bin = path.join(root, 'bin');
  const source = path.join(root, 'source-home');
  const realAuth = path.join(source, 'auth.json');
  await mkdir(bin, { recursive: true });
  await mkdir(source, { recursive: true });
  await writeFile(realAuth, ORIGINAL, { mode: 0o600 });
  const pidFile = path.join(root, 'exec.pid');
  await writeFile(path.join(bin, 'codex'), fakeCodex(pidFile, mode, realAuth), { mode: 0o755 });
  const work = path.join(root, 'work');
  const env = { PATH: `${bin}${path.delimiter}${process.env['PATH'] ?? ''}`, HOME: root, CODEX_HOME: source };
  const args = [path.join(BENCH, 'run.ts'), '--host', 'codex', '--arms', 'A', '--tasks', 'T1', '--runs', '1', '--seed', '1', '--work-dir', work, '--out', path.join(root, 'results')];
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
  const exited = once(child, 'exit');
  let exec = 0;
  for (let i = 0; i < 400 && exec === 0; i++) {
    try {
      exec = Number(await readFile(pidFile, 'utf8'));
    } catch {
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  if (exec === 0) {
    child.kill('SIGKILL');
    throw new Error(`fake codex exec never started: ${stderr}`);
  }
  if (signal !== undefined) child.kill(signal);
  const [code, sig] = (await exited) as [number | null, string | null];
  return { root, work, realAuth, exec, sig, code, stderr };
}

async function cleanup(h: Harness): Promise<void> {
  try {
    process.kill(-h.exec, 'SIGKILL');
  } catch {
  }
  await rm(h.root, { recursive: true, force: true });
}

/**
 * A file of the one warmup run or the one matrix run, picked by the `warmup` flag of the record next to
 * it: directory order (and so which run comes first) differs between filesystems.
 */
async function runFile(dir: string, name: string, warmup: boolean): Promise<string> {
  const records = (await readdir(dir, { recursive: true })).filter((f) => path.basename(f) === 'record.json');
  const hits: string[] = [];
  for (const r of records) if (z.object({ warmup: z.boolean() }).parse(JSON.parse(await readFile(path.join(dir, r), 'utf8'))).warmup === warmup) hits.push(r);
  if (hits.length !== 1 || hits[0] === undefined) throw new Error(`expected one ${warmup ? 'warmup' : 'matrix'} record under ${dir}, found ${hits.length}`);
  return readFile(path.join(dir, path.dirname(hits[0]), name), 'utf8');
}

describe.skipIf(!posix)('temporary CODEX_HOME: interruption', () => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    it(`on ${signal}: kills the host, writes the refreshed token back, leaves no auth copy`, async () => {
      const h = await harness('refresh-hang', signal);
      try {
        expect(h.sig).toBe(signal);
        expect(await authFiles(h.work)).toEqual([]);
        expect(await readFile(h.realAuth, 'utf8')).toBe(REFRESHED);
        expect((await stat(h.realAuth)).mode & 0o777).toBe(0o600);
        await new Promise((res) => setTimeout(res, 100));
        expect(alive(h.exec)).toBe(false);
      } finally {
        await cleanup(h);
      }
    }, 30_000);
  }

  it('on SIGINT without a refresh: the real auth file is left byte-identical', async () => {
    const h = await harness('hang', 'SIGINT');
    try {
      expect(await authFiles(h.work)).toEqual([]);
      expect(await readFile(h.realAuth, 'utf8')).toBe(ORIGINAL);
    } finally {
      await cleanup(h);
    }
  }, 30_000);

  it('after SIGKILL: the 0600 copy is left, and the next start syncs the refresh back and removes it', async () => {
    const h = await harness('refresh-hang', 'SIGKILL');
    try {
      expect(h.sig).toBe('SIGKILL');
      const left = await authFiles(h.work);
      expect(left.length).toBeGreaterThan(0);
      expect(left.every((f) => !f.symlink && f.mode === 0o600)).toBe(true);
      expect(await readFile(h.realAuth, 'utf8')).toBe(ORIGINAL);
      process.kill(-h.exec, 'SIGKILL');
      await new Promise((res) => setTimeout(res, 100));
      expect(sweepStaleHomes(h.work).length).toBeGreaterThan(0);
      expect(await authFiles(h.work)).toEqual([]);
      expect(await readFile(h.realAuth, 'utf8')).toBe(REFRESHED);
    } finally {
      await cleanup(h);
    }
  }, 30_000);
});

describe.skipIf(!posix)('temporary CODEX_HOME: token refresh on a finished run', () => {
  it('writes a refreshed token back when the real file is unchanged', async () => {
    const h = await harness('refresh-exit');
    try {
      expect(h.code).toBe(0);
      expect(await readFile(h.realAuth, 'utf8')).toBe(REFRESHED);
      expect((await stat(h.realAuth)).mode & 0o777).toBe(0o600);
      expect(await authFiles(h.work)).toEqual([]);
      // The warmup run is the one that refreshed; the matrix run after it found nothing to write back.
      expect(await runFile(path.join(h.root, 'results'), 'auth.txt', true)).toBe('auth.json: written-back\n');
      expect(await runFile(path.join(h.root, 'results'), 'auth.txt', false)).toBe('auth.json: unchanged\n');
    } finally {
      await cleanup(h);
    }
  }, 30_000);

  it('keeps the real file and warns when both changed', async () => {
    const h = await harness('refresh-conflict-exit');
    try {
      expect(await readFile(h.realAuth, 'utf8')).toBe(OTHER);
      expect(h.stderr).toContain('kept the real file');
      expect(await runFile(path.join(h.root, 'results'), 'auth.txt', true)).toBe('auth.json: conflict-kept-real\n');
      expect(await authFiles(h.work)).toEqual([]);
    } finally {
      await cleanup(h);
    }
  }, 30_000);

  it('leaves the real file alone when nothing was refreshed', async () => {
    const h = await harness('exit');
    try {
      expect(await readFile(h.realAuth, 'utf8')).toBe(ORIGINAL);
      expect(await runFile(path.join(h.root, 'results'), 'auth.txt', true)).toBe('auth.json: unchanged\n');
      expect(await runFile(path.join(h.root, 'results'), 'auth.txt', false)).toBe('auth.json: unchanged\n');
      const record = JSON.parse(await runFile(path.join(h.root, 'results'), 'record.json', false));
      expect(record.invalidReasons).toEqual([]);
      expect(record.valid).toBe(true);
      expect(record.parsed.availableTools).toContain('functions.exec_command');
    } finally {
      await cleanup(h);
    }
  }, 30_000);
});

describe('syncBack rule', () => {
  async function setup(): Promise<{ root: string; real: string; home: string }> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'acm-sync-'));
    await mkdir(path.join(root, 'src'));
    const real = path.join(root, 'src', 'auth.json');
    await writeFile(real, ORIGINAL, { mode: 0o600 });
    const home = path.join(root, 'home');
    createCodexHome(home, path.join(root, 'src'));
    return { root, real, home };
  }

  it('applies the same rule to the Claude credentials file in a temp CLAUDE_CONFIG_DIR', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'acm-claude-cfg-'));
    try {
      await mkdir(path.join(root, 'user'));
      const real = path.join(root, 'user', '.credentials.json');
      await writeFile(real, ORIGINAL, { mode: 0o600 });
      const cfg = path.join(root, 'cfg');
      createCodexHome(cfg, path.join(root, 'user'), '.credentials.json');
      expect(await readFile(path.join(cfg, '.credentials.json'), 'utf8')).toBe(ORIGINAL);
      await writeFile(path.join(cfg, '.credentials.json'), REFRESHED);
      await writeFile(path.join(cfg, '.claude.json'), '{}');
      expect(removeCodexHome(cfg)).toBe('written-back');
      expect(await readFile(real, 'utf8')).toBe(REFRESHED);
      expect((await readdir(path.join(root, 'user'))).sort()).toEqual(['.credentials.json']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('copies (never links) with mode 0600', async () => {
    const { root, home } = await setup();
    try {
      const st = await lstat(path.join(home, 'auth.json'));
      expect(st.isSymbolicLink()).toBe(false);
      if (posix) expect(st.mode & 0o777).toBe(0o600);
    } finally {
      removeCodexHome(home);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('unchanged → nothing; temp changed → written back; both changed → real kept with a warning', async () => {
    const { root, real, home } = await setup();
    try {
      expect(syncBack(home)).toBe('unchanged');
      await writeFile(path.join(home, 'auth.json'), REFRESHED);
      expect(syncBack(home)).toBe('written-back');
      expect(await readFile(real, 'utf8')).toBe(REFRESHED);
      if (posix) expect((await stat(real)).mode & 0o777).toBe(0o600);
      expect((await readdir(path.dirname(real))).filter((f) => f !== 'auth.json')).toEqual([]);
      await writeFile(path.join(home, 'auth.json'), OTHER);
      const warnings: string[] = [];
      expect(syncBack(home, (m) => warnings.push(m))).toBe('conflict-kept-real');
      expect(await readFile(real, 'utf8')).toBe(REFRESHED);
      expect(warnings).toHaveLength(1);
    } finally {
      removeCodexHome(home);
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(!posix || process.getuid?.() === 0)('keeps the only refreshed copy when the write-back fails, and the next sweep finishes it', async () => {
    const { root, real, home } = await setup();
    try {
      await writeFile(path.join(home, 'auth.json'), REFRESHED);
      await chmod(path.dirname(real), 0o500);
      expect(() => removeCodexHome(home)).toThrow(/kept in .*next bench run retries/);
      await chmod(path.dirname(real), 0o700);
      expect(await readFile(path.join(home, 'auth.json'), 'utf8')).toBe(REFRESHED);
      expect(await readFile(real, 'utf8')).toBe(ORIGINAL);
      expect(sweepStaleHomes(root).map((d) => path.basename(d))).toEqual(['home']);
      expect(await readFile(real, 'utf8')).toBe(REFRESHED);
    } finally {
      await chmod(path.dirname(real), 0o700);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('the sweep applies the rule before deleting and spares homes of live harnesses', async () => {
    const { root, real, home } = await setup();
    try {
      await writeFile(path.join(home, 'auth.json'), REFRESHED);
      const marker = JSON.parse(await readFile(path.join(home, HOME_MARKER), 'utf8'));
      await writeFile(path.join(home, HOME_MARKER), JSON.stringify({ ...marker, pid: 999_999_999 }));
      const other = path.join(root, 'other');
      await mkdir(other);
      await writeFile(path.join(other, HOME_MARKER), JSON.stringify({ ...marker, pid: process.ppid }));
      await writeFile(path.join(other, 'auth.json'), OTHER);
      expect(sweepStaleHomes(root).map((d) => path.basename(d))).toEqual(['home']);
      expect(await readFile(real, 'utf8')).toBe(REFRESHED);
      expect(await readFile(path.join(other, 'auth.json'), 'utf8')).toBe(OTHER);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
