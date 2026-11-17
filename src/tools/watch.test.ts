import { chmod, mkdir, mkdtemp, open, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { recordOwnFile, recordOwnWrite } from '../core/own-writes.js';
import { contextRecordFilter } from '../hosts/claude/context.js';
import { sha256 } from './fs-ops.js';
import { FileTransaction } from './journal.js';
import { WATCH_MAX_ENTRIES, WatchError, changedWatched, describeChanges, snapshotWatched, uncheckedWatched } from './watch.js';

const posix = process.platform !== 'win32';
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function lab() {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'acm-watch-')));
  dirs.push(base);
  const ws = path.join(base, 'ws');
  const state = path.join(base, 'state');
  const outside = path.join(base, 'outside');
  for (const d of [path.join(ws, '.claude', 'hooks'), state, outside]) await mkdir(d, { recursive: true });
  await writeFile(path.join(ws, '.claude', 'settings.json'), '{}');
  await writeFile(path.join(ws, '.claude', 'hooks', 'a.sh'), 'exit 0\n');
  await writeFile(path.join(ws, 'plain.txt'), 'x');
  const patterns = [path.join(ws, '.claude', 'settings*.json'), path.join(ws, '.claude', 'hooks', '**'), path.join(state, '**'), path.join(ws, '.mcp.json')];
  return { ws, state, outside, patterns };
}

async function changesAround(patterns: readonly string[], act: () => Promise<void>): Promise<string[]> {
  const before = await snapshotWatched(patterns);
  await act();
  return changedWatched(before, await snapshotWatched(patterns, before));
}

describe('protected-path watch', () => {
  it('reports a changed policy file, a new file under .claude/ and a new hook, and nothing outside the patterns', async () => {
    const l = await lab();
    const changed = await changesAround(l.patterns, async () => {
      await writeFile(path.join(l.ws, '.claude', 'settings.json'), '{"permissions":{"allow":["Bash"]}}');
      await writeFile(path.join(l.ws, '.claude', 'settings.local.json'), '{}');
      await writeFile(path.join(l.ws, '.claude', 'hooks', 'b.sh'), 'exit 0\n');
      await writeFile(path.join(l.ws, '.mcp.json'), '{}');
      await writeFile(path.join(l.ws, 'plain.txt'), 'changed');
      await writeFile(path.join(l.ws, '.claude', 'notes.md'), 'not a policy file');
    });
    expect(changed).toEqual(
      [
        path.join(l.ws, '.claude', 'hooks', 'b.sh'),
        path.join(l.ws, '.claude', 'settings.json'),
        path.join(l.ws, '.claude', 'settings.local.json'),
        path.join(l.ws, '.mcp.json'),
      ].sort(),
    );
  });

  it('reports a removed file and a same-size rewrite', async () => {
    const l = await lab();
    const changed = await changesAround(l.patterns, async () => {
      await rm(path.join(l.ws, '.claude', 'hooks', 'a.sh'));
      await writeFile(path.join(l.ws, '.claude', 'settings.json'), '[]');
    });
    expect(changed).toEqual([path.join(l.ws, '.claude', 'hooks', 'a.sh'), path.join(l.ws, '.claude', 'settings.json')]);
  });

  it.runIf(posix)('follows a link that was there at the snapshot to its target then, and reports a change there', async () => {
    const l = await lab();
    const target = path.join(l.outside, 'real-settings.json');
    await writeFile(target, '{}');
    const link = path.join(l.ws, '.claude', 'settings.local.json');
    await symlink(target, link);
    // The target's content changes: the link path is reported.
    expect(await changesAround(l.patterns, () => writeFile(target, '{"permissions":{"allow":["Bash"]}}'))).toEqual([link]);
    // The link is pointed elsewhere: reported too.
    const other = path.join(l.outside, 'other.json');
    await writeFile(other, '{}');
    expect(
      await changesAround(l.patterns, async () => {
        await rm(link);
        await symlink(other, link);
      }),
    ).toEqual([link]);
  });

  it.runIf(posix)('never follows a link that appears later (its creation is reported, its target is not read)', async () => {
    const l = await lab();
    const secret = path.join(l.outside, 'secret');
    await writeFile(secret, 's');
    const link = path.join(l.state, 'planted');
    const before = await snapshotWatched(l.patterns);
    await symlink(secret, link);
    const after = await snapshotWatched(l.patterns, before);
    expect(await changedWatched(before, after)).toEqual([link]);
    // Its target changing afterwards is not seen through the new link.
    await writeFile(secret, 'changed');
    expect(await changedWatched(after, await snapshotWatched(l.patterns, after))).toEqual([]);
  });

  it("does not report agent-code-mode's own journal writes, but does report another file changed next to them", async () => {
    const l = await lab();
    const tx = new FileTransaction(l.state);
    const file = path.join(l.ws, 'plain.txt');
    expect(
      await changesAround(l.patterns, async () => {
        await tx.record(file, l.ws, { bytes: Buffer.from('x'), mode: 0o644 }, 'h1', [], [l.ws]);
        await tx.record(file, l.ws, { bytes: Buffer.from('x'), mode: 0o644 }, 'h2', [], [l.ws]);
      }),
    ).toEqual([]);
    const planted = path.join(l.state, 'journal', 'planted.json');
    expect(
      await changesAround(l.patterns, async () => {
        await writeFile(planted, '{}');
        await tx.dispose();
      }),
    ).toEqual([planted]);
  });

  it('explains an own write only while the file holds exactly what was recorded', async () => {
    const l = await lab();
    const f = path.join(l.state, 'ctx-like.json');
    const before = await snapshotWatched(l.patterns);
    await writeFile(f, 'tampered');
    recordOwnWrite(f, { kind: 'absent' });
    expect(await changedWatched(before, await snapshotWatched(l.patterns, before))).toEqual([f]);
  });

  it('refuses to snapshot past its limits or from a pattern without a literal directory', async () => {
    const l = await lab();
    const many = path.join(l.state, 'many');
    await mkdir(many);
    await Promise.all(Array.from({ length: WATCH_MAX_ENTRIES + 1 }, (_, i) => writeFile(path.join(many, `f${i}`), '')));
    await expect(snapshotWatched(l.patterns)).rejects.toThrow(WatchError);
    await expect(snapshotWatched([path.join(path.parse(l.ws).root, '**', '.codex', '**')])).rejects.toThrow(/literal directory/);
  });

  it.runIf(posix)('sees a file rewritten through a symlinked directory (inside the watched tree, or as the pattern root)', async () => {
    const l = await lab();
    const real = path.join(l.outside, 'hooks-real');
    await mkdir(real);
    await writeFile(path.join(real, 'hook.sh'), 'exit 0\n');
    await symlink(real, path.join(l.state, 'hooks'));
    expect(await changesAround(l.patterns, () => writeFile(path.join(real, 'hook.sh'), 'exit 1\n'))).toEqual([path.join(l.state, 'hooks', 'hook.sh')]);
    // The pattern root itself is a link to a directory.
    const agents = path.join(l.outside, 'agents-real');
    await mkdir(agents);
    await symlink(agents, path.join(l.ws, '.claude', 'agents'));
    const patterns = [...l.patterns, path.join(l.ws, '.claude', 'agents', '**')];
    expect(await changesAround(patterns, () => writeFile(path.join(agents, 'new.md'), 'x'))).toEqual([path.join(l.ws, '.claude', 'agents', 'new.md')]);
  });

  it('sees a rewrite of a file over 1 MiB that keeps its size, inode, mode and time', async () => {
    const l = await lab();
    const big = path.join(l.state, 'big.bin');
    await writeFile(big, Buffer.alloc(1024 * 1024 + 1, 0x61));
    // A whole-second time, so restoring it after the rewrite is exact.
    await utimes(big, 1_700_000_000, 1_700_000_000);
    const st = await stat(big);
    const changed = await changesAround(l.patterns, async () => {
      const h = await open(big, 'r+');
      await h.write(Buffer.from('b'), 0, 1, 0);
      await h.close();
      await utimes(big, 1_700_000_000, 1_700_000_000);
    });
    expect((await stat(big)).mtimeMs).toBe(st.mtimeMs);
    expect((await stat(big)).ino).toBe(st.ino);
    expect(changed).toEqual([big]);
  });

  it('names the files it could only compare by metadata (hash budget spent), never silently', async () => {
    const l = await lab();
    const before = await snapshotWatched(l.patterns, undefined, { hashTotalBytes: 4 });
    const after = await snapshotWatched(l.patterns, before, { hashTotalBytes: 4 });
    expect(uncheckedWatched(before, after)).toContain(path.join(l.ws, '.claude', 'hooks', 'a.sh'));
  });

  it.runIf(posix)('follows a link created by one bash call from the next baseline on', async () => {
    const l = await lab();
    const target = path.join(l.outside, 't.json');
    await writeFile(target, '{}');
    const link = path.join(l.state, 'l.json');
    const first = await snapshotWatched(l.patterns);
    await symlink(target, link);
    const afterFirst = await snapshotWatched(l.patterns, first);
    expect(await changedWatched(first, afterFirst)).toEqual([link]);
    // Next call: its baseline resolves the new link (no change against the previous snapshot), then a rewrite of the target is seen.
    const baseline = await snapshotWatched(l.patterns, afterFirst, { baseline: true });
    expect(await changedWatched(afterFirst, baseline)).toEqual([]);
    await writeFile(target, '{"x":1}');
    expect(await changedWatched(baseline, await snapshotWatched(l.patterns, baseline))).toEqual([link]);
  });

  it('an own write explains a change only with the same type, mode and content', async () => {
    const l = await lab();
    const f = path.join(l.state, 'manifest.json');
    const before = await snapshotWatched(l.patterns);
    await writeFile(f, '{}', { mode: 0o600 });
    await recordOwnFile(f, sha256('{}'));
    expect(await changedWatched(before, await snapshotWatched(l.patterns, before))).toEqual([]);
    await chmod(f, 0o777);
    expect(await changedWatched(before, await snapshotWatched(l.patterns, before))).toEqual([f]);
  });

  it("context records: a new well-formed one is routine, a changed or ill-formed one is reported", async () => {
    const l = await lab();
    const ctx = path.join(l.state, 'ctx');
    const routine = contextRecordFilter(ctx);
    const record = (id: string, mode = 'default') => JSON.stringify({ tool_use_id: id, session_id: 's', permission_mode: mode });
    const before = await snapshotWatched(l.patterns);
    await mkdir(ctx, { mode: 0o700 });
    await chmod(ctx, 0o700);
    await writeFile(path.join(ctx, 'toolu_a.json'), record('toolu_a'), { mode: 0o600 });
    await writeFile(path.join(ctx, 'toolu_b.json'), record('toolu_other'), { mode: 0o600 });
    await writeFile(path.join(ctx, 'junk.txt'), 'x', { mode: 0o600 });
    const after = await snapshotWatched(l.patterns, before);
    expect(await changedWatched(before, after, routine)).toEqual([path.join(ctx, 'junk.txt'), path.join(ctx, 'toolu_b.json')]);
    // An existing record rewritten (permission mode raised) is reported; a consumed (removed) one is not.
    await writeFile(path.join(ctx, 'toolu_a.json'), record('toolu_a', 'bypassPermissions'), { mode: 0o600 });
    await rm(path.join(ctx, 'toolu_b.json'));
    expect(await changedWatched(after, await snapshotWatched(l.patterns, after), routine)).toEqual([path.join(ctx, 'toolu_a.json')]);
  });

  it('keeps the report short', () => {
    const paths = Array.from({ length: 25 }, (_, i) => `/p/${i}`);
    expect(describeChanges(paths)).toMatch(/\/p\/19 and 5 more$/);
  });
});
