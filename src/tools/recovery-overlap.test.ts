import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { runScript } from '../core/run.js';
import { FakeSandbox, StaticHostAdapter, makeContext } from '../testing/index.js';
import { FileTransaction, recoverStaleJournals } from './journal.js';
import { NodeToolRuntime } from './runtime.js';
import { ROOTED_OPS_REFUSED } from '../testing/platform.js';

it.skipIf(ROOTED_OPS_REFUSED)('keeps an acknowledged write when recovering an older unfinished run', async () => {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'acm-overlap-')));
  try {
    const ws = path.join(base, 'workspace');
    const stateDir = path.join(base, 'state');
    mkdirSync(ws);
    const file = path.join(ws, 'note.txt');
    writeFileSync(file, 'draft');
    const ctx = makeContext(ws);
    const tools = new NodeToolRuntime({ stateDir });
    const adapter = new StaticHostAdapter({ protectedPaths: [] });
    const policy = { host: 'generic' as const, bashContainment: { mode: 'none' as const }, protectedPaths: [], payload: null };
    const earlier = tools.beginTransaction();
    if (!(earlier instanceof FileTransaction)) throw new Error('Expected a disk journal');
    for (const [id, content] of [['one', 'reviewed'], ['two', 'editing']]) {
      const prepared = await tools.prepare({ id: id!, tool: 'write', args: { path: 'note.txt', content: content! } }, ctx, policy);
      await tools.commit(prepared, new AbortController().signal, earlier);
    }

    const code = JSON.stringify([{ tool: 'write', args: { path: 'note.txt', content: 'reviewed' } }]);
    const result = await runScript({ code, transaction: true, timeoutMs: 10_000 }, { ctx, tools, sandbox: new FakeSandbox(), adapter });
    console.log('Later run returned ok=%s, file=%s', result.ok, readFileSync(file, 'utf8'));
    expect(result.ok).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('reviewed');

    // Model server restart with an exited process as the unfinished journal owner.
    const manifestPath = path.join(earlier.dir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const dead = spawnSync(process.execPath, ['-e', '']);
    expect(dead.status).toBe(0);
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, pid: dead.pid }));

    const recovered = await recoverStaleJournals(stateDir, [ws], []);
    console.log('Recovered journals=%d, file=%s', recovered.length, readFileSync(file, 'utf8'));
    expect(readFileSync(file, 'utf8')).toBe('reviewed');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
