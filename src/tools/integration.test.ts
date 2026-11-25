import { existsSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runScript } from '../core/run.js';
import { FakeSandbox, StaticHostAdapter, makeContext } from '../testing/index.js';
import { NodeToolRuntime } from './runtime.js';

/** The real tool runtime behind the P0 dispatcher and run pipeline. */
let base: string;
let ws: string;

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'acm-int-')));
  ws = path.join(base, 'ws');
  mkdirSync(ws);
  writeFileSync(path.join(ws, 'a.txt'), 'alpha\n');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function deps(adapter = new StaticHostAdapter({ protectedPaths: [] })) {
  return { sandbox: new FakeSandbox(), adapter, tools: new NodeToolRuntime({ stateDir: path.join(base, 'state') }), ctx: makeContext(ws) };
}

describe('NodeToolRuntime in the run pipeline', () => {
  it('commits writes and edits and reports the diff', async () => {
    const code = JSON.stringify([
      { tool: 'edit', args: { path: 'a.txt', oldString: 'alpha', newString: 'beta' } },
      { tool: 'write', args: { path: 'b/c.txt', content: 'new\n' } },
      { tool: 'read', args: { path: 'b/c.txt' } },
    ]);
    const result = await runScript({ code, transaction: false, timeoutMs: 10_000 }, deps());
    expect(result.ok).toBe(true);
    expect(result.changedFiles).toEqual(['a.txt', 'b/c.txt']);
    expect(result.diff).toContain('-alpha\n+beta\n');
    expect(result.diff).toContain('--- /dev/null\n+++ b/b/c.txt\n');
    expect(readFileSync(path.join(ws, 'a.txt'), 'utf8')).toBe('beta\n');
  });

  it('rolls a transactional run back when a call is denied', async () => {
    const adapter = new StaticHostAdapter({
      protectedPaths: [],
      rules: [(p) => (p.tool === 'write' && p.effect.absPath.endsWith('denied.txt') ? { kind: 'deny', reason: 'no' } : undefined)],
    });
    const code = JSON.stringify([
      { tool: 'write', args: { path: 'a.txt', content: 'changed\n' } },
      { tool: 'write', args: { path: 'fresh/new.txt', content: 'x' } },
      { tool: 'write', args: { path: 'denied.txt', content: 'x' } },
    ]);
    const result = await runScript({ code, transaction: true, timeoutMs: 10_000 }, deps(adapter));
    expect(result.ok).toBe(false);
    expect(result.rolledBack?.skipped).toEqual([]);
    expect(result.rolledBack?.restored.length).toBe(2);
    expect(readFileSync(path.join(ws, 'a.txt'), 'utf8')).toBe('alpha\n');
    expect(existsSync(path.join(ws, 'fresh'))).toBe(false);
    // The journal is released once the run is over.
    expect(readdirSync(path.join(base, 'state', 'journal'))).toEqual([]);
  });
});
