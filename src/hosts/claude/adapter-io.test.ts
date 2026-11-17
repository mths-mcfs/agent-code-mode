import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PreparedCall } from '../../core/types.js';
import { makeContext } from '../../testing/index.js';
import { ClaudeHostAdapter } from './adapter.js';

/** Paths whose `lstat` fails with the given code (an I/O fault the adapter cannot see through). */
const faults = new Map<string, string>();

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: async (p: Parameters<typeof actual.lstat>[0]) => {
      const code = faults.get(String(p));
      if (code !== undefined) throw Object.assign(new Error(`${code}: injected fault, lstat '${String(p)}'`), { code });
      return actual.lstat(p);
    },
  };
});

const posix = process.platform !== 'win32';

function bash(command: string, cwd: string): PreparedCall {
  return { id: 'c1', tool: 'bash', args: { command, cwd, timeoutMs: 120_000 }, effect: { command, cwd, timeoutMs: 120_000, containment: { mode: 'none' } } };
}

async function setup() {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'acm-claude-io-')));
  const home = path.join(base, 'home');
  const project = path.join(base, 'project');
  const state = path.join(base, 'state');
  for (const d of [path.join(home, '.claude'), path.join(project, '.claude'), state]) await mkdir(d, { recursive: true });
  await writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash'] } }));
  await writeFile(path.join(home, '.claude.json'), JSON.stringify({ projects: { [project]: { hasTrustDialogAccepted: true } } }));
  const adapter = new ClaudeHostAdapter({ env: {}, home, managedDir: null, stateDir: state, readParent: async () => undefined });
  const ctx = makeContext(project, { host: 'claude', permissionMode: 'default', sources: { cwd: 'roots' } });
  const policy = await adapter.loadPolicy(ctx);
  if ('error' in policy) throw new Error(policy.error);
  return { adapter, ctx, policy, project, state };
}

describe.runIf(posix)('resolving file targets fails closed on I/O errors', () => {
  it('an lstat error other than "missing" denies instead of treating the component as missing', async () => {
    const s = await setup();
    const alias = path.join(s.project, 'alias');
    await symlink(s.state, alias);
    faults.set(alias, 'EIO');
    try {
      const call = bash('echo x > alias/f', s.project);
      expect(await s.adapter.checkResolved(call, s.ctx, s.policy).catch((e: unknown) => ({ kind: 'deny', thrown: String(e) }))).toMatchObject({ kind: 'deny' });
      expect(await s.adapter.authorize(call, s.ctx, s.policy, new AbortController().signal).catch((e: unknown) => ({ kind: 'deny', thrown: String(e) }))).toMatchObject({ kind: 'deny' });
    } finally {
      faults.clear();
    }
  });

  it('a component that does not exist (ENOENT, ENOTDIR) is still just missing', async () => {
    const s = await setup();
    await writeFile(path.join(s.project, 'file'), 'x');
    for (const command of ['echo x > nope/a/b', 'echo x > file/a']) {
      expect([command, await s.adapter.checkResolved(bash(command, s.project), s.ctx, s.policy)]).toEqual([command, undefined]);
    }
  });
});
