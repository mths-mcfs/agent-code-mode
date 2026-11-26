import { afterEach, describe, expect, it } from 'vitest';
import { makeContext } from '../testing/context.js';
import { MemoryToolRuntime } from '../testing/memory-tool-runtime.js';
import { StaticHostAdapter, type StaticHostAdapterOptions } from '../testing/static-host-adapter.js';
import { Dispatcher } from './dispatcher.js';
import { releasingClaims } from './file-claims.js';
import type { CallReply, PolicySnapshot, ScratchDir, Transaction } from './types.js';

const SCRATCH = '/ws/.scratch';

/** Transactions claim the files they write until they end: end each test's, so the next test may write the same names. */
const open: Transaction[] = [];
afterEach(async () => {
  for (const tx of open.splice(0)) await tx.dispose();
});

function fakeScratch(full: () => string | undefined): ScratchDir & { checks: number } {
  return {
    path: SCRATCH,
    checks: 0,
    async enforceLimit() {
      this.checks++;
      return full();
    },
    remove: async () => undefined,
  };
}

async function setup(opts: { adapter?: StaticHostAdapterOptions; files?: Record<string, string>; transaction?: boolean; scratch?: ScratchDir; bashStdout?: string; bashExit?: number } = {}) {
  const ctx = makeContext('/ws');
  const adapter = new StaticHostAdapter(opts.adapter ?? {});
  const tools = new MemoryToolRuntime({
    root: '/ws',
    files: opts.files ?? {},
    ...(opts.bashStdout === undefined ? {} : { bashResult: () => ({ exitCode: opts.bashExit ?? 0, signal: null, stdout: opts.bashStdout ?? '', stderr: '', truncated: false, timedOut: false }) }),
  });
  const loaded = await adapter.loadPolicy(ctx);
  if ('error' in loaded) throw new Error(loaded.error);
  const policy: PolicySnapshot<null> = opts.scratch === undefined ? loaded : { ...loaded, scratchRoot: SCRATCH };
  const tx: Transaction | undefined = opts.transaction ? releasingClaims(tools.beginTransaction()) : undefined;
  if (tx) open.push(tx);
  const dispatcher = new Dispatcher<null>({ adapter, tools, ctx, policy, ...(tx ? { transaction: tx } : {}), ...(opts.scratch ? { scratch: opts.scratch } : {}) });
  return { adapter, tools, dispatcher, tx, ctx, policy };
}

function valueOf(reply: CallReply): unknown {
  if (!reply.ok) throw new Error(`expected success, got ${JSON.stringify(reply.error)}`);
  return reply.value;
}

describe('Dispatcher: test()', () => {
  it('authorizes and runs the command as a bash call, logs it as test, and parses the result', async () => {
    const { dispatcher, adapter } = await setup({ bashStdout: '      Tests  1 failed | 2 passed (3)\n', bashExit: 1 });
    const value = valueOf(await dispatcher.dispatch('test', { command: 'npx vitest run' }));
    expect(value).toMatchObject({ ok: false, runner: 'vitest', failed: 1, passed: 2 });
    expect(adapter.staticChecked.map((c) => c.tool)).toEqual(['bash']);
    expect(dispatcher.calls).toEqual([expect.objectContaining({ tool: 'test', summary: 'test npx vitest run', decision: 'allowed' })]);
    expect(dispatcher.bashCommits).toBe(1);
  });

  it('is denied exactly when the same bash command would be', async () => {
    const { dispatcher } = await setup({ adapter: { rules: [(p) => (p.tool === 'bash' && p.effect.command === 'npm test' ? { kind: 'deny', reason: 'no' } : undefined)] } });
    const reply = await dispatcher.dispatch('test', { command: 'npm test' });
    expect(reply).toMatchObject({ ok: false, error: { name: 'PermissionDenied' } });
    expect(dispatcher.calls).toEqual([expect.objectContaining({ tool: 'test', decision: 'denied' })]);
  });

  it('rejects arguments that are not a bash call', async () => {
    const { dispatcher } = await setup();
    expect(await dispatcher.dispatch('test', {})).toMatchObject({ ok: false, error: { code: 'invalid-args' } });
  });
});

describe('Dispatcher: undo()', () => {
  // The memory runtime's paths are POSIX; a path the script gives resolves to a drive path on Windows.
  it.skipIf(process.platform === 'win32')('restores through the transaction and drops the files from changedFiles and diff', async () => {
    const { dispatcher, tools } = await setup({ files: { 'a.txt': 'a0', 'b.txt': 'b0' }, transaction: true });
    await dispatcher.dispatch('write', { path: 'a.txt', content: 'a1' });
    await dispatcher.dispatch('write', { path: 'b.txt', content: 'b1' });
    const value = valueOf(await dispatcher.dispatch('undo', { paths: ['a.txt'] }));
    expect(value).toEqual({ restored: ['a.txt'], skipped: [] });
    expect(tools.read('a.txt')).toBe('a0');
    expect(dispatcher.changedFiles).toEqual(['b.txt']);
    expect(dispatcher.diff).not.toContain('a.txt');
    expect(dispatcher.diff).toContain('b.txt');
    expect(dispatcher.calls.at(-1)).toMatchObject({ tool: 'undo', summary: 'undo a.txt', decision: 'allowed' });
  });

  it('waits for the writes queued before it', async () => {
    const { dispatcher, tools } = await setup({ files: { 'a.txt': 'a0' }, transaction: true });
    const [, undone] = await Promise.all([dispatcher.dispatch('write', { path: 'a.txt', content: 'a1' }), dispatcher.dispatch('undo', {})]);
    expect(valueOf(undone)).toEqual({ restored: ['a.txt'], skipped: [] });
    expect(tools.read('a.txt')).toBe('a0');
  });

  it('never touches a protected path, even one the journal holds', async () => {
    const { dispatcher, tools, tx, ctx, policy } = await setup({ files: { 'a.txt': 'a0' }, transaction: true });
    await dispatcher.dispatch('write', { path: 'a.txt', content: 'a1' });
    if (tx === undefined) throw new Error('no transaction');
    const later = new Dispatcher<null>({ adapter: new StaticHostAdapter({}), tools, ctx, policy: { ...policy, protectedPaths: ['/ws/a.txt'] }, transaction: tx });
    expect(valueOf(await later.dispatch('undo', {}))).toEqual({ restored: [], skipped: [{ path: 'a.txt', reason: expect.stringMatching(/protected/) }] });
    expect(tools.read('a.txt')).toBe('a1');
  });

  it('needs a transaction, and validates its arguments', async () => {
    const { dispatcher } = await setup({ files: { 'a.txt': 'a0' } });
    expect(await dispatcher.dispatch('undo', {})).toMatchObject({ ok: false, error: { code: 'invalid-args', message: expect.stringMatching(/transaction: true/) } });
    const tx = await setup({ transaction: true });
    expect(await tx.dispatcher.dispatch('undo', { paths: [] })).toMatchObject({ ok: false, error: { code: 'invalid-args' } });
    expect(await tx.dispatcher.dispatch('undo', { all: true })).toMatchObject({ ok: false, error: { code: 'invalid-args' } });
  });
});

describe('Dispatcher: scratch directory', () => {
  it('keeps scratch writes out of the journal, changedFiles and diff', async () => {
    const scratch = fakeScratch(() => undefined);
    const { dispatcher, tools } = await setup({ transaction: true, scratch });
    await dispatcher.dispatch('write', { path: `${SCRATCH}/x.txt`, content: 'x' });
    await dispatcher.dispatch('write', { path: 'a.txt', content: 'a' });
    expect(dispatcher.changedFiles).toEqual(['a.txt']);
    expect(dispatcher.diff).not.toContain('x.txt');
    expect(valueOf(await dispatcher.dispatch('undo', {}))).toEqual({ restored: ['a.txt'], skipped: [] });
    expect(tools.read('.scratch/x.txt')).toBe('x');
  });

  it('checks the limit after each bash call and scratch write, and fails the call that passed it', async () => {
    let full = false;
    const scratch = fakeScratch(() => (full ? 'the scratch directory passed 10 bytes and was emptied' : undefined));
    const { dispatcher } = await setup({ scratch });
    expect((await dispatcher.dispatch('bash', { command: 'true' })).ok).toBe(true);
    await dispatcher.dispatch('write', { path: 'a.txt', content: 'a' });
    expect(scratch.checks).toBe(1);
    full = true;
    const reply = await dispatcher.dispatch('write', { path: `${SCRATCH}/big`, content: 'x'.repeat(100) });
    expect(reply).toMatchObject({ ok: false, error: { code: 'tool-error', message: expect.stringMatching(/passed 10 bytes/) } });
    expect(scratch.checks).toBe(2);
    expect(dispatcher.warnings).toContain('the scratch directory passed 10 bytes and was emptied');
  });
});
