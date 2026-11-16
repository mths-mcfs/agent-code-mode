import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCodexHome, HOME_MARKER, sweepStaleHomes } from '../lib/codex-home.ts';

const BENCH = path.join(import.meta.dirname, '..');
const CATALOG = path.join(BENCH, 'parser-fixtures', 'codex-catalog.json');
const posix = process.platform !== 'win32';

/** A fake `codex` that answers the harness's preflight calls and hangs in `exec`, writing its pid. */
function fakeCodex(pidFile: string): string {
  return `#!${process.execPath}
const fs = require('node:fs');
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('codex-cli 0.169.0'); process.exit(0); }
if (a[0] === 'debug' && a[1] === 'models') { process.stdout.write(fs.readFileSync(${JSON.stringify(CATALOG)}, 'utf8')); process.exit(0); }
if (a[0] === 'debug' && a[1] === 'prompt-input') { console.log(JSON.stringify([{ type: 'additional_tools', tools: [{ type: 'function', name: 'exec_command' }] }])); process.exit(0); }
if (a[0] === 'exec') { fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000); }
else process.exit(2);
`;
}

async function authFiles(dir: string): Promise<{ file: string; symlink: boolean }[]> {
  let files: string[] = [];
  try {
    files = await readdir(dir, { recursive: true });
  } catch {
    return [];
  }
  const out: { file: string; symlink: boolean }[] = [];
  for (const f of files.filter((x) => path.basename(x) === 'auth.json')) out.push({ file: f, symlink: (await lstat(path.join(dir, f))).isSymbolicLink() });
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

async function harnessKilledBy(signal: NodeJS.Signals): Promise<{ root: string; work: string; exec: number; code: number | null; sig: string | null }> {
  const root = await mkdtemp(path.join(os.tmpdir(), `acm-iso-${signal}-`));
  const bin = path.join(root, 'bin');
  const source = path.join(root, 'source-home');
  await mkdir(bin, { recursive: true });
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'auth.json'), JSON.stringify({ token: 'FAKE_AUTH_ONLY' }), { mode: 0o600 });
  const pidFile = path.join(root, 'exec.pid');
  await writeFile(path.join(bin, 'codex'), fakeCodex(pidFile), { mode: 0o755 });
  const work = path.join(root, 'work');
  const env = { PATH: `${bin}${path.delimiter}${process.env['PATH'] ?? ''}`, HOME: root, CODEX_HOME: source };
  const child = spawn(process.execPath, [path.join(BENCH, 'run.ts'), '--host', 'codex', '--arms', 'A', '--tasks', 'T1', '--runs', '1', '--seed', '1', '--work-dir', work, '--out', path.join(root, 'results')], { env, stdio: 'ignore' });
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
    throw new Error('fake codex exec never started');
  }
  child.kill(signal);
  const [code, sig] = (await exited) as [number | null, string | null];
  return { root, work, exec, code, sig };
}

describe.skipIf(!posix)('temporary CODEX_HOME isolation', () => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    it(`leaves no auth file and no running host when the harness gets ${signal}`, async () => {
      const r = await harnessKilledBy(signal);
      try {
        expect(r.sig).toBe(signal);
        expect(await authFiles(r.work)).toEqual([]);
        await new Promise((res) => setTimeout(res, 100));
        expect(alive(r.exec)).toBe(false);
      } finally {
        if (alive(r.exec)) process.kill(r.exec, 'SIGKILL');
        await rm(r.root, { recursive: true, force: true });
      }
    }, 30_000);
  }

  it('after SIGKILL leaves only a symlink (no credential copy), swept at the next start', async () => {
    const r = await harnessKilledBy('SIGKILL');
    try {
      expect(r.sig).toBe('SIGKILL');
      const left = await authFiles(r.work);
      expect(left.length).toBeGreaterThan(0);
      expect(left.every((f) => f.symlink)).toBe(true);
      process.kill(-r.exec, 'SIGKILL');
      await new Promise((res) => setTimeout(res, 100));
      const removed = sweepStaleHomes(r.work);
      expect(removed.length).toBeGreaterThan(0);
      expect(await authFiles(r.work)).toEqual([]);
    } finally {
      try {
        process.kill(-r.exec, 'SIGKILL');
      } catch {
        // already gone
      }
      await rm(r.root, { recursive: true, force: true });
    }
  }, 30_000);

  it('links the auth file instead of copying it, and the sweep spares homes of live harnesses', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'acm-home-'));
    try {
      await mkdir(path.join(root, 'src'));
      await writeFile(path.join(root, 'src', 'auth.json'), '{}');
      expect(createCodexHome(path.join(root, 'live'), path.join(root, 'src'))).toBe('symlink');
      // A home owned by this (live) process is not stale for another harness... unless it is ours.
      await mkdir(path.join(root, 'other'));
      await writeFile(path.join(root, 'other', HOME_MARKER), `${process.ppid}\n`);
      await mkdir(path.join(root, 'dead'));
      await writeFile(path.join(root, 'dead', HOME_MARKER), '999999999\n');
      const removed = sweepStaleHomes(root).map((d) => path.basename(d)).sort();
      expect(removed).toEqual(['dead', 'live']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
