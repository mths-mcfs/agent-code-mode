import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256 } from './fs-ops.js';
import { Jail } from './jail.js';
import { SessionDirs } from './session-dirs.js';
import { MAX_RUN_UNDO_BYTES, MAX_TOTAL_UNDO_BYTES, MAX_UNDO_RUNS, UndoStore, type UndoStoreOptions } from './undo.js';

const made: (() => void)[] = [];
afterEach(() => {
  for (const undo of made.splice(0)) undo();
});

function store(opts: UndoStoreOptions = {}): { undo: UndoStore; state: string } {
  const state = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'acm-undo-')));
  const dirs = new SessionDirs(state);
  made.push(() => {
    dirs.close();
    rmSync(state, { recursive: true, force: true });
  });
  return { undo: new UndoStore(dirs, opts), state };
}

const found = { dev: 1n, ino: 2n, size: 1n, mode: 0o644 };
const file = (name: string, size: number) => ({ absPath: `/w/${name}`, root: '/w', before: { bytes: Buffer.alloc(size, 'x'), mode: 0o644, fingerprint: found } });
const stats = { bashCalls: 0, mcpCalls: 0 };
const landed = (hash: string) => ({ sha256: hash, dev: 1n, ino: 1n, size: 1n, mode: 0o644 });

async function finished(undo: UndoStore, name: string, size = 1): Promise<string> {
  const run = undo.begin();
  await run.capture(file(name, size));
  run.committed(`/w/${name}`, landed('h'));
  return (await run.finish(stats)).undoId ?? '';
}

describe('UndoStore limits', () => {
  it('a run above its limit keeps going without an undoId, says so and leaves nothing saved', async () => {
    const { undo, state } = store();
    const run = undo.begin();
    await run.capture(file('a', MAX_RUN_UNDO_BYTES));
    run.committed('/w/a', landed('h1'));
    await run.capture(file('b', 1));
    run.committed('/w/b', landed('h2'));
    const outcome = await run.finish(stats);
    expect(outcome.undoId).toBeUndefined();
    expect(outcome.warning).toContain('cannot be undone');
    await new Promise((r) => setTimeout(r, 50));
    const session = readdirSync(path.join(state, 'undo'))[0] ?? '';
    expect(readdirSync(path.join(state, 'undo', session))).toEqual([]);
  }, 30_000);

  it('the total limit drops the oldest finished runs first', async () => {
    const { undo } = store();
    const size = Math.floor(MAX_RUN_UNDO_BYTES / 2);
    const ids: string[] = [];
    const count = Math.ceil(MAX_TOTAL_UNDO_BYTES / size) + 1;
    for (let i = 0; i < Math.min(count, 9); i++) {
      const run = undo.begin();
      await run.capture(file(`f${i}`, size));
      run.committed(`/w/f${i}`, landed('h'));
      ids.push((await run.finish(stats)).undoId ?? '');
    }
    expect(ids.every((id) => id !== '')).toBe(true);
    const used = ids.length * size;
    expect(used).toBeGreaterThan(MAX_TOTAL_UNDO_BYTES);
    await expect(undo.open(ids[0] ?? '', undefined as never)).rejects.toThrow('unknown undoId');
  }, 60_000);

  it('a file outside the roots of the run that undoes it is left alone', async () => {
    const { undo, state } = store();
    const inside = path.join(state, 'first');
    const other = path.join(state, 'second');
    mkdirSync(inside);
    mkdirSync(other);
    const absPath = path.join(inside, 'a.txt');
    writeFileSync(absPath, 'final');
    const run = undo.begin();
    await run.capture({ absPath, root: inside, before: { bytes: Buffer.from('original'), mode: 0o644, fingerprint: found } });
    run.committed(absPath, landed(sha256('final')));
    const { undoId } = await run.finish(stats);
    const session = await undo.open(undoId ?? '', await Jail.create({ cwd: other, roots: [], protectedPaths: [] }));
    expect(session.steps).toEqual([]);
    expect(session.skipped).toEqual([{ path: absPath, reason: expect.stringContaining('outside the workspace') }]);
    await session.close(false);
  });

  it('keeps only the last runs', async () => {
    const { undo, state } = store();
    const ids: string[] = [];
    for (let i = 0; i <= MAX_UNDO_RUNS; i++) ids.push(await finished(undo, `f${i}`));
    const jail = await Jail.create({ cwd: state, roots: [], protectedPaths: [] });
    await expect(undo.open(ids[0] ?? '', jail)).rejects.toThrow('unknown undoId');
    await (await undo.open(ids[MAX_UNDO_RUNS] ?? '', jail)).close(false);
  });

  it('while every kept run is being undone, the next run gets a warning instead of an id that cannot work', async () => {
    const { undo, state } = store();
    const jail = await Jail.create({ cwd: state, roots: [], protectedPaths: [] });
    const sessions = [];
    for (let i = 0; i < MAX_UNDO_RUNS; i++) sessions.push(await undo.open(await finished(undo, `f${i}`), jail));
    const run = undo.begin();
    await run.capture(file('last', 1));
    run.committed('/w/last', landed('h'));
    const outcome = await run.finish(stats);
    expect(outcome.undoId).toBeUndefined();
    expect(outcome.warning).toContain('cannot be undone');
    for (const session of sessions) await session.close(false);
    expect(await finished(undo, 'after')).toMatch(/^undo_/);
  });

  it('room is made before anything is written: a new original waits until the dropped ones are gone from disk', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const removed: string[] = [];
    const { undo, state } = store({ removeDir: async (dir) => { removed.push(dir); await gate; rmSync(dir, { recursive: true, force: true }); } });
    for (let i = 0; i < MAX_TOTAL_UNDO_BYTES / MAX_RUN_UNDO_BYTES; i++) await finished(undo, `big${i}`, MAX_RUN_UNDO_BYTES);
    const run = undo.begin();
    let done = false;
    const capture = run.capture(file('next', 1024)).then(() => void (done = true));
    await new Promise((r) => setTimeout(r, 100));
    expect(removed).toHaveLength(1);
    expect(done).toBe(false);
    const session = readdirSync(path.join(state, 'undo'))[0] ?? '';
    expect(readdirSync(path.join(state, 'undo', session))).toHaveLength(MAX_TOTAL_UNDO_BYTES / MAX_RUN_UNDO_BYTES);
    release();
    await capture;
    expect(done).toBe(true);
    await run.discard();
  }, 60_000);

  it('a write that never landed leaves no undo record', async () => {
    const { undo } = store();
    const run = undo.begin();
    await run.capture(file('a', 3));
    expect(await run.finish(stats)).toEqual({});
  });

  it('a first write that failed does not fix the original: the next capture replaces it', async () => {
    const { undo } = store();
    const run = undo.begin();
    await run.capture(file('a', 3));
    await run.capture(file('a', 5));
    run.committed('/w/a', landed('h'));
    expect((await run.finish(stats)).undoId).toMatch(/^undo_/);
  });

  it('a discarded run leaves no undoId and no saved file', async () => {
    const { undo, state } = store();
    const run = undo.begin();
    await run.capture(file('a', 3));
    run.committed('/w/a', landed('h'));
    await run.discard();
    await new Promise((r) => setTimeout(r, 50));
    const session = readdirSync(path.join(state, 'undo'))[0] ?? '';
    expect(readdirSync(path.join(state, 'undo', session))).toEqual([]);
  });
});
