// Workspace isolation checks that run main() end to end, apart from run.test.ts so that Vitest runs them in their own process.
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertWorkspaceIsolated, defaultWorkDir, insideRepo, main, parseOptions, REPO_ROOT, resolveBaseline } from '../run.ts';
import { quiet } from './quiet.ts';

/** Every directory from `dir` up to the filesystem root. */
function ancestors(dir: string): string[] {
  const out = [dir];
  while (path.dirname(out.at(-1) as string) !== out.at(-1)) out.push(path.dirname(out.at(-1) as string));
  return out;
}

describe('workspace isolation from the checkout', () => {
  it('defaults the work dir to outside the repository', () => {
    expect(insideRepo(defaultWorkDir())).toBe(false);
    expect(defaultWorkDir({ XDG_CACHE_HOME: '/var/cache/x' })).toBe(path.join('/var/cache/x', 'agent-code-mode-bench'));
    expect(defaultWorkDir({})).toBe(path.join(os.homedir(), '.cache', 'agent-code-mode-bench'));
    expect(parseOptions([]).workDir).toBe(defaultWorkDir());
    expect(insideRepo(path.join(REPO_ROOT, 'bench', '.work'))).toBe(true);
    expect(insideRepo(REPO_ROOT)).toBe(true);
  });

  it('refuses a --work-dir inside the checkout, also through a symlink', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'acm-link-'));
    try {
      await symlink(path.join(REPO_ROOT, 'bench'), path.join(tmp, 'bench-link'), process.platform === 'win32' ? 'junction' : 'dir');
      for (const dir of [path.join(REPO_ROOT, 'bench', '.work'), REPO_ROOT, path.join(tmp, 'bench-link', 'work')]) {
        const errs: string[] = [];
        const orig = process.stderr.write.bind(process.stderr);
        process.stderr.write = ((c: string | Uint8Array) => (errs.push(String(c)), true)) as typeof process.stderr.write;
        try {
          expect(await main(['--dry-run', '--tasks', 'T1', '--runs', '1', '--work-dir', dir])).toBe(2);
        } finally {
          process.stderr.write = orig;
        }
        expect(errs.join('')).toMatch(/--work-dir .* is inside the repository checkout/);
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('rejects a workspace with bench/tasks in any directory above it', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'acm-anc-'));
    try {
      await mkdir(path.join(tmp, 'bench', 'tasks'), { recursive: true });
      expect(() => assertWorkspaceIsolated(path.join(tmp, 'a', 'b', 'ws'))).toThrow(/bench\/tasks above it/);
      expect(() => assertWorkspaceIsolated(path.join(REPO_ROOT, 'x', 'ws'))).toThrow(/inside the repository checkout/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('no run workspace has an ancestor holding bench/tasks, and both hosts are pointed only at it', async () => {
    const work = await mkdtemp(path.join(os.tmpdir(), 'acm-iso-ws-'));
    const out = path.join(work, 'results');
    try {
      const dry = await quiet(() => main(['--dry-run', '--keep-work', '--tasks', 'T9,T10', '--runs', '1', '--seed', '2', '--work-dir', work, '--out', out, '--date', '2026-01-06']));
      expect(dry.value, dry.errors).toBe(0);
      const wss = (await readdir(path.join(work, 'runs'), { recursive: true })).filter((f) => path.basename(f) === 'ws').map((f) => path.join(work, 'runs', f));
      expect(wss.length).toBe(2 * 4 + 2 * 3 + 7);
      for (const ws of wss) {
        expect(insideRepo(ws)).toBe(false);
        for (const dir of ancestors(ws)) expect(existsSync(path.join(dir, 'bench', 'tasks')), dir).toBe(false);
      }
      // Codex is given the workspace and nothing else (`-C <workspace>`); arm C's MCP server inherits that cwd.
      const commands = (await readdir(out, { recursive: true })).filter((f) => path.basename(f) === 'command.txt');
      for (const f of commands.filter((c) => c.includes('codex'))) expect(await readFile(path.join(out, f), 'utf8')).toMatch(/ -C <workspace> /);
      // Claude is started in the workspace: its init cwd, which is also the MCP root of arm B, is the workspace.
      for (const f of commands.filter((c) => c.includes('claude'))) expect(await readFile(path.join(out, f), 'utf8')).not.toContain('--add-dir');
      const records = (await readdir(out, { recursive: true })).filter((f) => path.basename(f) === 'record.json');
      for (const f of records) expect(await readFile(path.join(out, f), 'utf8')).not.toContain('<repo>/bench/tasks');
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }, 300_000); // End to end through main(): on Windows it competes for the CPU with the other test files.

  it('the --acm-ref build has no bench/ or test/ next to the run workspaces', async () => {
    const work = await mkdtemp(path.join(os.tmpdir(), 'acm-build-'));
    try {
      const build = await resolveBaseline({ acmRef: 'HEAD', acmDist: undefined, dryRun: false }, work);
      const dir = path.dirname(path.dirname(build?.entry ?? ''));
      expect(existsSync(build?.entry ?? '')).toBe(true);
      expect(existsSync(path.join(dir, 'bench'))).toBe(false);
      expect(existsSync(path.join(dir, 'test'))).toBe(false);
      expect(existsSync(path.join(dir, 'src'))).toBe(true);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }, 600_000);
});
