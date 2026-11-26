import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WATCH_MAX_ENTRIES, snapshotWatched } from './watch.js';

describe.runIf(process.platform !== 'win32')('snapshotWatched', () => {
  let base: string;
  let claude: string;
  const settings = (): string => path.join(claude, 'settings*.json');
  const hooks = (): string => path.join(claude, 'hooks', '**');

  beforeEach(() => {
    base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'acm-watch-')));
    claude = path.join(base, '.claude');
    mkdirSync(path.join(claude, 'hooks'), { recursive: true });
    writeFileSync(path.join(claude, 'settings.json'), '{}');
    writeFileSync(path.join(claude, 'hooks', 'guard.sh'), 'exit 0\n');
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const changes = async (patterns: string[], act: () => void): Promise<string[]> => {
    const before = await snapshotWatched(patterns);
    act();
    return (await snapshotWatched(patterns)).changedSince(before);
  };

  it('sees nothing when nothing changed, and ignores names the patterns do not match', async () => {
    expect(await changes([settings(), hooks()], () => writeFileSync(path.join(claude, 'notes.txt'), 'x'))).toEqual([]);
  });

  it('sees a rewrite with the same bytes and the old mtime, a chmod, a new file and a removal', async () => {
    const file = path.join(claude, 'settings.json');
    // Whole seconds, so restoring the mtime restores it to the nanosecond and only the change time can tell.
    utimesSync(file, 1_700_000_000, 1_700_000_000);
    const rewrite = (): void => {
      writeFileSync(file, readFileSync(file));
      utimesSync(file, 1_700_000_000, 1_700_000_000);
    };
    expect(await changes([settings()], rewrite)).toEqual([file]);
    expect(await changes([settings()], () => chmodSync(file, 0o600))).toEqual([file]);
    const local = path.join(claude, 'settings.local.json');
    expect(await changes([settings()], () => writeFileSync(local, '{}'))).toEqual([local]);
    expect(await changes([hooks()], () => rmSync(path.join(claude, 'hooks', 'guard.sh')))).toEqual([path.join(claude, 'hooks', 'guard.sh')]);
  });

  it('follows a linked directory, a link retargeted, and a link that loops back up without hanging', async () => {
    const real = path.join(base, 'real-hooks');
    mkdirSync(real);
    writeFileSync(path.join(real, 'a.sh'), 'exit 0\n');
    rmSync(path.join(claude, 'hooks'), { recursive: true });
    symlinkSync(real, path.join(claude, 'hooks'));
    symlinkSync(claude, path.join(real, 'loop'));
    const shown = path.join(claude, 'hooks', 'a.sh');
    expect(await changes([hooks()], () => writeFileSync(path.join(real, 'a.sh'), 'exit 2\n'))).toEqual([shown]);
    const other = path.join(base, 'other-hooks');
    mkdirSync(other);
    writeFileSync(path.join(other, 'a.sh'), 'exit 0\n');
    const moved = await changes([hooks()], () => {
      rmSync(path.join(claude, 'hooks'));
      symlinkSync(other, path.join(claude, 'hooks'));
    });
    expect(moved).toContain(path.join(claude, 'hooks'));
    expect(moved).toContain(shown);
  });

  it('passes each change to the routine filter, which can leave it out', async () => {
    const before = await snapshotWatched([settings()]);
    writeFileSync(path.join(claude, 'settings.local.json'), '{}');
    const seen: unknown[] = [];
    const left = await (await snapshotWatched([settings()])).changedSince(before, async (c) => {
      seen.push(c);
      return true;
    });
    expect(left).toEqual([]);
    expect(seen).toEqual([{ path: path.join(claude, 'settings.local.json'), after: { type: 'file', mode: expect.any(Number) } }]);
  });

  it('rejects past its entry limit and for a pattern with no literal directory', async () => {
    const many = path.join(base, 'many');
    mkdirSync(many);
    for (let i = 0; i <= WATCH_MAX_ENTRIES; i++) writeFileSync(path.join(many, `f${i}`), '');
    await expect(snapshotWatched([path.join(many, '**')])).rejects.toThrow(/more than 5000 entries/);
    await expect(snapshotWatched(['/*/settings.json'])).rejects.toThrow(/literal directory/);
    // Names that cannot match still cost: the limit bounds the reading, not only what is kept.
    await expect(snapshotWatched([path.join(many, 'settings*.json')])).rejects.toThrow(/more than 5000 entries/);
  });
});
