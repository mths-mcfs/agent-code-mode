import { linkSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import nodeFs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolError } from '../core/errors.js';
import type { PolicySnapshot, PreparedCall, SessionContext, ToolCall } from '../core/types.js';
import { makeContext } from '../testing/context.js';
import { FileTransaction, journalRoot, recoverStaleJournals } from './journal.js';
import { NodeToolRuntime } from './runtime.js';

/**
 * One test per defect found by the correctness review of the first version:
 * each failed (or hung) before its fix.
 */

const IS_WINDOWS = process.platform === 'win32';

let base: string;
let ws: string;
let outside: string;
let ctx: SessionContext;
let rt: NodeToolRuntime;
let seq = 0;
const policy: PolicySnapshot = { host: 'generic', bashContainment: { mode: 'none' }, protectedPaths: [], payload: null };

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ToolError) return err.code;
    throw err;
  }
  return 'resolved';
}

function prepWrite(rel: string, content: string, p: PolicySnapshot = policy): Promise<PreparedCall> {
  return rt.prepare({ id: `c${++seq}`, tool: 'write', args: { path: rel, content } } satisfies ToolCall, ctx, p);
}

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'acm-hard-')));
  ws = path.join(base, 'ws');
  outside = path.join(base, 'outside');
  mkdirSync(ws);
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'secret'), 'EXTERNAL_SECRET\n');
  ctx = makeContext(ws);
  rt = new NodeToolRuntime({ stateDir: path.join(base, 'state') });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe.skipIf(IS_WINDOWS)('1. grep and glob reach every directory and file without a link', () => {
  function swapAfterListing(name: string): void {
    const sub = path.join(ws, 'sub');
    const readdirSync = nodeFs.readdirSync;
    let swapped = false;
    vi.spyOn(nodeFs, 'readdirSync').mockImplementation(((dir: string, options: { withFileTypes: true }) => {
      const entries = readdirSync(dir, options);
      if (!swapped && entries.some((e) => e.name === name)) {
        swapped = true;
        renameSync(sub, `${sub}-old`);
        symlinkSync(outside, sub, 'dir');
      }
      return entries;
    }) as typeof readdirSync);
  }

  beforeEach(() => {
    mkdirSync(path.join(ws, 'sub'));
    writeFileSync(path.join(ws, 'sub', 'secret'), 'inside\n');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('grep does not read a file through a parent swapped for a link after the parent was listed', async () => {
    const prepared = await rt.prepare({ id: 'g', tool: 'grep', args: { pattern: 'SECRET' } }, ctx, policy);
    swapAfterListing('secret');
    const result = await rt.commit(prepared, new AbortController().signal);
    expect('matches' in result ? result.matches : null).toEqual([]);
  });

  it('glob does not list names from a directory swapped for a link after it was queued', async () => {
    const prepared = await rt.prepare({ id: 'g', tool: 'glob', args: { pattern: '**/*' } }, ctx, policy);
    swapAfterListing('sub');
    const result = await rt.commit(prepared, new AbortController().signal);
    expect('files' in result ? result.files : null).toEqual([]);
  });
});

describe.skipIf(IS_WINDOWS)('2. crash recovery never deletes through a link', () => {
  it('leaves a directory outside the roots alone when a created dir path now goes through a link', async () => {
    mkdirSync(path.join(outside, 'empty'));
    symlinkSync(outside, path.join(ws, 'sub'), 'dir');
    const dir = path.join(journalRoot(path.join(base, 'state')), 'abc-99999999-dead');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ version: 1, pid: 99_999_999, host: os.hostname(), startedAt: 0, roots: [ws], dirs: [path.join(ws, 'sub', 'empty')], entries: [] }),
    );
    await recoverStaleJournals(path.join(base, 'state'), [ws], []);
    expect(existsSync(path.join(outside, 'empty'))).toBe(true);
  });
});

describe.skipIf(IS_WINDOWS)('2b. rollback never changes a file through a parent swapped for a link', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Swaps `ws/sub` for a link to `outside` right before each `name` syscall, and back right after. */
  function swapAround(name: 'unlinkSync' | 'renameSync'): void {
    const original = nodeFs[name] as (...args: unknown[]) => void;
    vi.spyOn(nodeFs, name).mockImplementation(((...args: unknown[]) => {
      renameSync(path.join(ws, 'sub'), path.join(ws, 'sub-real'));
      symlinkSync(outside, path.join(ws, 'sub'), 'dir');
      try {
        original(...args);
      } finally {
        rmSync(path.join(ws, 'sub'));
        renameSync(path.join(ws, 'sub-real'), path.join(ws, 'sub'));
      }
    }) as never);
  }

  beforeEach(() => {
    mkdirSync(path.join(ws, 'sub'));
    writeFileSync(path.join(ws, 'sub', 'old.txt'), 'original\n');
    // Outside holds exactly what the run writes, so content and name alone would match.
    writeFileSync(path.join(outside, 'new.txt'), 'run bytes\n');
    writeFileSync(path.join(outside, 'old.txt'), 'run bytes\n');
  });

  it.each([
    ['removes the created file', 'unlinkSync', 'sub/new.txt'],
    ['restores the edited file', 'renameSync', 'sub/old.txt'],
  ] as const)('%s inside the workspace when the swap lands inside the final syscall', async (_label, syscall, rel) => {
    const tx = rt.beginTransaction();
    await rt.commit(await prepWrite(rel, 'run bytes\n'), new AbortController().signal, tx);
    swapAround(syscall);
    await tx.rollback();
    vi.restoreAllMocks();
    expect(readFileSync(path.join(outside, 'new.txt'), 'utf8')).toBe('run bytes\n');
    expect(readFileSync(path.join(outside, 'old.txt'), 'utf8')).toBe('run bytes\n');
    expect(readdirSync(outside).sort()).toEqual(['new.txt', 'old.txt', 'secret']);
    expect(existsSync(path.join(ws, 'sub', 'new.txt'))).toBe(false);
    expect(readFileSync(path.join(ws, 'sub', 'old.txt'), 'utf8')).toBe('original\n');
  });
});

describe.skipIf(IS_WINDOWS)('3. protected paths are checked on every path the resolution goes through', () => {
  it('refuses writing a protected path that is a link to an unprotected file', async () => {
    writeFileSync(path.join(ws, 'f'), 'old');
    symlinkSync(path.join(ws, 'f'), path.join(ws, 'config.json'));
    const p = { ...policy, protectedPaths: [path.join(ws, 'config.json')] };
    expect(await code(prepWrite('config.json', 'overwritten', p))).toBe('protected-path');
    expect(readFileSync(path.join(ws, 'f'), 'utf8')).toBe('old');
  });

  it('refuses writing through a final-component link even inside the workspace', async () => {
    writeFileSync(path.join(ws, 'target.txt'), 'old');
    symlinkSync(path.join(ws, 'target.txt'), path.join(ws, 'alias.txt'));
    expect(await code(prepWrite('alias.txt', 'new'))).toBe('invalid-args');
    expect(await code(rt.prepare({ id: 'e', tool: 'edit', args: { path: 'alias.txt', oldString: 'old', newString: 'new' } }, ctx, policy))).toBe('invalid-args');
    expect(readFileSync(path.join(ws, 'target.txt'), 'utf8')).toBe('old');
  });
});

describe('4. abort stops a write that already entered commit', () => {
  it('refuses the rename after the signal aborted', async () => {
    writeFileSync(path.join(ws, 'f'), 'old');
    const prepared = await prepWrite('f', 'new');
    const ac = new AbortController();
    const work = rt.commit(prepared, ac.signal);
    ac.abort();
    expect(await code(work)).toBe('cancelled');
    expect(readFileSync(path.join(ws, 'f'), 'utf8')).toBe('old');
  });
});

describe('5. concurrent commits on one path', () => {
  it('lets only the first of two writes prepared against the same content succeed', async () => {
    writeFileSync(path.join(ws, 'f'), 'old');
    const a = await prepWrite('f', 'first');
    const b = await prepWrite('f', 'second');
    class SlowTransaction extends FileTransaction {
      override async record(...args: Parameters<FileTransaction['record']>): Promise<void> {
        await super.record(...args);
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    const tx = new SlowTransaction(path.join(base, 'state'));
    const signal = new AbortController().signal;
    const results = await Promise.allSettled([rt.commit(a, signal, tx), rt.commit(b, signal, tx)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    const second = results[1];
    expect(second?.status === 'rejected' && second.reason instanceof ToolError && second.reason.code).toBe('stale');
    expect(readFileSync(path.join(ws, 'f'), 'utf8')).toBe('first');
    await tx.dispose();
  });
});

describe.skipIf(IS_WINDOWS)('6. identity of the file and its directories', () => {
  it('refuses a commit when the file was replaced by a hard link with the same content', async () => {
    writeFileSync(path.join(ws, 'f'), 'old');
    const prepared = await prepWrite('f', 'new');
    writeFileSync(path.join(ws, 'other'), 'old');
    rmSync(path.join(ws, 'f'));
    linkSync(path.join(ws, 'other'), path.join(ws, 'f'));
    expect(await code(rt.commit(prepared, new AbortController().signal))).toBe('stale');
    expect(readFileSync(path.join(ws, 'other'), 'utf8')).toBe('old');
  });

  it('refuses a commit when a parent directory was replaced by another one', async () => {
    mkdirSync(path.join(ws, 'd'));
    writeFileSync(path.join(ws, 'd', 'f'), 'old');
    const prepared = await prepWrite('d/f', 'new');
    const created = await prepWrite('d/new.txt', 'new');
    renameSync(path.join(ws, 'd'), path.join(ws, 'd-moved'));
    mkdirSync(path.join(ws, 'd'));
    writeFileSync(path.join(ws, 'd', 'f'), 'old');
    expect(statSync(path.join(ws, 'd')).isDirectory()).toBe(true);
    expect(await code(rt.commit(prepared, new AbortController().signal))).toBe('stale');
    expect(await code(rt.commit(created, new AbortController().signal))).toBe('stale');
    expect(readFileSync(path.join(ws, 'd', 'f'), 'utf8')).toBe('old');
  });
});

describe('7. a pathological grep pattern can be stopped', () => {
  beforeEach(() => {
    writeFileSync(path.join(ws, 'f'), `${'a'.repeat(40)}!\n`);
  });

  it('fails with a ToolError when the per-file budget runs out', async () => {
    const budgeted = new NodeToolRuntime({ stateDir: path.join(base, 'state'), grepFileBudgetMs: 200 });
    const prepared = await budgeted.prepare({ id: 'g', tool: 'grep', args: { pattern: '(a+)+$' } }, ctx, policy);
    const started = Date.now();
    const err = await budgeted.commit(prepared, new AbortController().signal).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ToolError);
    expect(String(err)).toMatch(/too expensive/);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('stops on abort', async () => {
    const prepared = await rt.prepare({ id: 'g', tool: 'grep', args: { pattern: '(a+)+$' } }, ctx, policy);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const started = Date.now();
    expect(await code(rt.commit(prepared, ac.signal))).toBe('cancelled');
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe.skipIf(IS_WINDOWS)('8. path oracle: accepted iff the real path is inside the roots', () => {
  it('agrees with the operating system on links followed by ..', async () => {
    mkdirSync(path.join(outside, 'sub'));
    mkdirSync(path.join(ws, 'dir'));
    writeFileSync(path.join(ws, 'f'), 'inside');
    writeFileSync(path.join(outside, 'f'), 'outside');
    writeFileSync(path.join(outside, 'sub', 'f'), 'outside sub');
    symlinkSync(path.join(outside, 'sub'), path.join(ws, 'link'));
    symlinkSync(path.join(ws, 'dir'), path.join(ws, 'inlink'));
    symlinkSync('../outside/sub', path.join(ws, 'rel-link'));
    const parts = ['f', '.', '..', 'link', 'inlink', 'rel-link', 'dir', 'sub', 'ws', 'outside'];
    let seed = 1234;
    let checked = 0;
    for (let i = 0; i < 400; i++) {
      const n = 1 + (i % 5);
      const comps: string[] = [];
      for (let k = 0; k < n; k++) {
        seed = (1664525 * seed + 1013904223) >>> 0;
        comps.push(parts[seed % parts.length] ?? 'f');
      }
      comps.push('f');
      const input = comps.join('/');
      let real: string | null;
      try {
        // The kernel decides whether the path resolves (macOS realpath(3) alone
        // accepts `file/..`); native realpath then gives where it lands.
        await fsp.stat(`${ws}/${input}`);
        real = await fsp.realpath(`${ws}/${input}`);
      } catch {
        real = null;
      }
      if (real === null) continue; // the OS cannot open it; the jail may refuse it any way it likes
      checked++;
      const inside = real === ws || real.startsWith(`${ws}${path.sep}`);
      let prepared: PreparedCall | undefined;
      try {
        prepared = await rt.prepare({ id: `o${i}`, tool: 'read', args: { path: input } }, ctx, policy);
      } catch {
        prepared = undefined;
      }
      expect({ input, accepted: prepared !== undefined }).toEqual({ input, accepted: inside });
      if (prepared?.tool === 'read') expect({ input, abs: prepared.effect.absPath }).toEqual({ input, abs: real });
    }
    expect(checked).toBeGreaterThan(30);
  });
});

describe('commit works on the copy the dispatcher hands it', () => {
  it('commits a structured clone of the prepared call once', async () => {
    writeFileSync(path.join(ws, 'f'), 'old');
    const copy = structuredClone(await prepWrite('f', 'new'));
    await rt.commit(copy, new AbortController().signal);
    expect(readFileSync(path.join(ws, 'f'), 'utf8')).toBe('new');
    expect(await code(rt.commit(structuredClone(copy), new AbortController().signal))).toBe('tool-error');
  });
});
