import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { ToolError } from '../core/errors.js';
import { OverflowStore } from '../core/overflow.js';
import type { McpEffect, McpServerSpec } from '../core/types.js';
import { McpUpstreams, shapeResult } from './upstream.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'upstream-server.mjs');
const dir = mkdtempSync(path.join(os.tmpdir(), 'acm-upstream-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
let pools: McpUpstreams[] = [];
afterEach(async () => {
  await Promise.all(pools.map((p) => p.close()));
  pools = [];
});

function setup(env: Record<string, string> = {}, opts: { startupTimeoutMs?: number; overflow?: OverflowStore; maxResultChars?: number } = {}) {
  const log = path.join(dir, `log-${++n}.jsonl`);
  const spec: McpServerSpec = {
    name: 'fx',
    command: process.execPath,
    args: [FIXTURE],
    env: { PATH: process.env['PATH'] ?? '', FIXTURE_LOG: log, ...env },
    cwd: dir,
    startupTimeoutMs: opts.startupTimeoutMs ?? 10_000,
    origin: 'test config',
    autostart: true,
  };
  const pool = new McpUpstreams({ ...(opts.overflow ? { overflow: opts.overflow } : {}), ...(opts.maxResultChars ? { maxResultChars: opts.maxResultChars } : {}) });
  pools.push(pool);
  pool.start(Promise.resolve([spec]));
  const events = (): { pid: number; event: string; tool?: string }[] => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { spec, pool, events };
}

const effect = (tool: string, input: Record<string, unknown> = {}, timeoutMs = 10_000): McpEffect => ({ server: 'fx', tool, qualifiedName: `mcp__fx__${tool}`, input, timeoutMs });
const signal = (): AbortSignal => new AbortController().signal;
const failure = (p: Promise<unknown>): Promise<ToolError> => p.then(() => { throw new Error('expected a failure'); }, (e: unknown) => (e instanceof ToolError ? e : Promise.reject(e)));
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('McpUpstreams', () => {
  it('starts the server with the session, keeps it for every call, and passes the configured environment', async () => {
    const { spec, pool, events } = setup({ FIXTURE_SECRET: 's3cret' });
    expect(await pool.call(spec, effect('echo', { a: 1 }), signal())).toEqual({ isError: false, structuredContent: { echoed: { a: 1 } } });
    expect(await pool.call(spec, effect('env'), signal())).toEqual({ isError: false, text: 'set' });
    expect(events().filter((e) => e.event === 'start')).toHaveLength(1);
  });

  it('refuses a tool the server does not list, without sending it', async () => {
    const { spec, pool, events } = setup();
    const err = await failure(pool.call(spec, effect('nope'), signal()));
    expect(err.code).toBe('invalid-args');
    expect(err.message).toMatch(/has no tool "nope" \(tools: "echo"/);
    expect(events().filter((e) => e.event === 'call')).toEqual([]);
  });

  it('times out a hung call and keeps the server for the next call', async () => {
    const { spec, pool, events } = setup();
    const t0 = Date.now();
    const err = await failure(pool.call(spec, effect('hang', {}, 300), signal()));
    expect(err.message).toMatch(/did not answer within 300 ms; its effect is unknown/);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(await pool.call(spec, effect('echo'), signal())).toMatchObject({ isError: false });
    expect(events().filter((e) => e.event === 'start')).toHaveLength(1);
  });

  it('reports a server that exits during a call, and never starts it again', async () => {
    const { spec, pool, events } = setup();
    expect((await failure(pool.call(spec, effect('crash'), signal()))).message).toMatch(/exited or closed its pipes during mcp__fx__crash/);
    expect((await failure(pool.call(spec, effect('echo'), signal()))).message).toMatch(/no longer running .*not started again/);
    expect(events().filter((e) => e.event === 'start')).toHaveLength(1);
  });

  it('refuses a server that was not started with the session, even one whose config changed since', async () => {
    const { spec, pool, events } = setup();
    await pool.call(spec, effect('echo'), signal());
    const changed = { ...spec, args: [...spec.args, '--other'] };
    expect((await failure(pool.call(changed, effect('echo'), signal()))).message).toMatch(/was not started with this session/);
    expect(events().filter((e) => e.event === 'start')).toHaveLength(1);
  });

  it('bounds a server that never initializes, and says nothing of its environment', async () => {
    const { spec, pool } = setup({ FIXTURE_NO_INIT: '1', FIXTURE_SECRET: 'do-not-show' }, { startupTimeoutMs: 300 });
    const err = await failure(pool.call(spec, effect('echo'), signal()));
    expect(err.message).toMatch(/could not be started: did not start and initialize within 300 ms/);
    expect(err.message).not.toContain('do-not-show');
  });

  it('rejects an invalid result', async () => {
    const { spec, pool } = setup();
    expect((await failure(pool.call(spec, effect('bad'), signal()))).message).toMatch(/not a valid tools\/call result/);
  });

  it('cuts a result past the cap and keeps the whole of it for readOverflow', async () => {
    const overflow = new OverflowStore();
    const { spec, pool } = setup({ FIXTURE_BIG: '5000' }, { overflow, maxResultChars: 1_000 });
    const r = await pool.call(spec, effect('big'), signal());
    expect(r.truncated).toBe(true);
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(1_000);
    expect(r.overflow?.chars).toBe(5_000);
    const page = overflow.read({ id: r.overflow?.id, offset: 0, limit: 5_000 });
    expect(page.ok && 'text' in page.value ? page.value.text : '').toBe('x'.repeat(5_000));
  });

  it('does not send a call whose run already stopped, and stops waiting for a start when it stops', async () => {
    const { spec, pool, events } = setup({ FIXTURE_NO_INIT: '1' }, { startupTimeoutMs: 5_000 });
    const stopped = new AbortController();
    stopped.abort();
    expect((await failure(pool.call(spec, effect('echo'), stopped.signal))).code).toBe('cancelled');
    expect(events().filter((e) => e.event === 'call')).toEqual([]);
    const later = new AbortController();
    const pending = failure(pool.call(spec, effect('echo'), later.signal));
    setTimeout(() => later.abort(), 200);
    expect((await pending).code).toBe('cancelled');
  });

  it('close ends every server process, and killAll kills them at once', async () => {
    const a = setup();
    await a.pool.call(a.spec, effect('echo'), signal());
    const pidA = a.events()[0]?.pid ?? 0;
    await a.pool.close();
    expect(alive(pidA)).toBe(false);
    await expect(a.pool.call(a.spec, effect('echo'), signal())).rejects.toThrow(/no longer running/);

    const b = setup();
    await b.pool.call(b.spec, effect('echo'), signal());
    const pidB = b.events()[0]?.pid ?? 0;
    b.pool.killAll();
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(pidB)).toBe(false);
  });
});

describe('shapeResult', () => {
  it('prefers structuredContent, else joins the text of the content blocks', () => {
    expect(shapeResult({ content: [{ type: 'text', text: 'x' }], structuredContent: { a: 1 } }, 1_000, undefined, 't')).toEqual({ isError: false, structuredContent: { a: 1 } });
    const text = shapeResult({ content: [{ type: 'text', text: 'a' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }], isError: true }, 1_000, undefined, 't');
    expect(text).toEqual({ isError: true, text: 'a\n[image content omitted (image/png)]' });
  });

  it('refuses results that are not tools/call results', () => {
    expect(() => shapeResult({}, 1_000, undefined, 't')).toThrow(/neither content nor structuredContent/);
    expect(() => shapeResult({ structuredContent: [1] }, 1_000, undefined, 't')).toThrow(/not an object/);
    expect(() => shapeResult({ content: [{ type: 'video' }] }, 1_000, undefined, 't')).toThrow(/not a valid/);
  });

  it('says when a cut result could not be kept', () => {
    const r = shapeResult({ content: [{ type: 'text', text: '\n'.repeat(5_000) }] }, 500, undefined, 't');
    expect(r.truncated).toBe(true);
    expect(r.warning).toMatch(/could not be kept/);
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(500);
  });
});
