import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { FAKE_MCP_UPSTREAM, MemoryMcpUpstream } from '../testing/index.js';
import { parseMcpConfigFlag, startMcpUpstreams, upstreamLifecycle, type ExitHooks } from './start.js';

async function configFile(servers: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'acm-mcp-start-'));
  const file = path.join(dir, 'mcp.json');
  await writeFile(file, JSON.stringify({ mcpServers: servers }));
  return file;
}

const inventory = { command: process.execPath, args: [FAKE_MCP_UPSTREAM, 'inventory'] };

describe('startMcpUpstreams', () => {
  it.each(['codex', 'generic'] as const)('refuses the %s host', async (host) => {
    const r = await startMcpUpstreams({ configFile: await configFile({ inventory }), host, managedDir: undefined });
    expect(!r.ok && r.message).toContain('needs the Claude Code host');
  });

  it('refuses an invalid config', async () => {
    const r = await startMcpUpstreams({ configFile: await configFile({ inventory: { command: '' } }), host: 'claude', managedDir: undefined });
    expect(!r.ok && r.message).toContain('--mcp-config');
  });

  it.each(['allowedMcpServers', 'deniedMcpServers'])('refuses to start when managed settings set %s', async (key) => {
    const managedDir = await mkdtemp(path.join(os.tmpdir(), 'acm-mcp-managed-'));
    await mkdir(path.join(managedDir, 'managed-settings.d'));
    await writeFile(path.join(managedDir, 'managed-settings.d', '10-mcp.json'), JSON.stringify({ [key]: [] }));
    const r = await startMcpUpstreams({ configFile: await configFile({ inventory }), host: 'claude', managedDir });
    expect(!r.ok && r.message).toContain(key);
  });

  it('connects the servers that start and reports the ones that do not', async () => {
    const r = await startMcpUpstreams({
      configFile: await configFile({
        inventory,
        broken: { command: process.execPath, args: [FAKE_MCP_UPSTREAM, 'exit-early'] },
        missing: { command: path.join(os.tmpdir(), 'no-such-binary-acm') },
        silent: { command: process.execPath, args: [FAKE_MCP_UPSTREAM, 'never-init'] },
        garbage: { command: process.execPath, args: [FAKE_MCP_UPSTREAM, 'garbage'] },
        paged: { command: process.execPath, args: [FAKE_MCP_UPSTREAM, 'paged'] },
        many: { command: process.execPath, args: [FAKE_MCP_UPSTREAM, 'many'] },
        badlist: { command: process.execPath, args: [FAKE_MCP_UPSTREAM, 'bad-list'] },
      }),
      host: 'claude',
      managedDir: undefined,
      connectTimeoutMs: 1_500,
    });
    if (!r.ok) throw new Error(r.message);
    try {
      const { catalog } = r.upstream;
      expect([...catalog.servers].sort()).toEqual(['inventory', 'many', 'paged']);
      expect(catalog.tools.filter((t) => t.server === 'paged').map((t) => t.tool)).toEqual(['p1_tool', 'p2_tool', 'p3_tool']);
      expect(catalog.tools.filter((t) => t.server === 'many')).toHaveLength(500);
      const problems = catalog.problems.join('\n');
      expect(problems).toContain('"broken" left out');
      expect(problems).toContain('missing credentials');
      expect(problems).toContain('"missing" left out');
      expect(problems).toContain('"silent" left out');
      expect(problems).toContain('"garbage" left out');
      expect(problems).toContain('"badlist" left out');
      expect(problems).toContain('"many" lists more tools than 500');
    } finally {
      await r.upstream.close();
    }
  });

  it('starts servers with a minimal environment plus the declared env', async () => {
    process.env['ACM_SECRET_FOR_TEST'] = 'should-not-leak';
    try {
      const r = await startMcpUpstreams({ configFile: await configFile({ inventory: { ...inventory, env: { DECLARED_VAR: 'yes' } } }), host: 'claude', managedDir: undefined });
      if (!r.ok) throw new Error(r.message);
      try {
        const entry = r.upstream.catalog.lookup('inventory', 'env');
        if (!entry) throw new Error('no env tool');
        const out = await r.upstream.call(entry, {}, { signal: new AbortController().signal, timeoutMs: 5_000 });
        expect(out.ok).toBe(true);
        const names = out.ok ? JSON.stringify(out.result) : '';
        expect(names).toContain('DECLARED_VAR');
        expect(names).not.toContain('ACM_SECRET_FOR_TEST');
      } finally {
        await r.upstream.close();
      }
    } finally {
      delete process.env['ACM_SECRET_FOR_TEST'];
    }
  });
});

describe('parseMcpConfigFlag', () => {
  it.each([
    [['--hybrid'], undefined],
    [['--mcp-config', 'a.json'], 'a.json'],
    [['--mcp-config=a.json', '--hybrid'], 'a.json'],
  ])('%j → %j', (args, expected) => {
    expect(parseMcpConfigFlag(args)).toBe(expected);
  });
  it.each([[['--mcp-config']], [['--mcp-config', '--hybrid']], [['--mcp-config=']], [['--mcp-config', 'a', '--mcp-config', 'b']]])('%j is an error', (args) => {
    expect(parseMcpConfigFlag(args)).toBeInstanceOf(Error);
  });
});

function fakeHooks(): { hooks: ExitHooks; stdin: PassThrough; signals: Map<string, () => void>; exits: number[] } {
  const stdin = new PassThrough();
  const signals = new Map<string, () => void>();
  const exits: number[] = [];
  return { hooks: { stdin, onSignal: (s, h) => void signals.set(s, h), exit: (c) => void exits.push(c) }, stdin, signals, exits };
}

describe('upstreamLifecycle', () => {
  it('stdin EOF ends the upstream server processes', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'acm-mcp-eof-'));
    const pidFile = path.join(dir, 'pid');
    const f = fakeHooks();
    const life = upstreamLifecycle(f.hooks);
    const r = await startMcpUpstreams({ configFile: await configFile({ inventory: { ...inventory, env: { FAKE_MCP_PID_FILE: pidFile } } }), host: 'claude', managedDir: undefined, signal: life.signal });
    if (!r.ok) throw new Error(r.message);
    expect(life.attach(r.upstream)).toBe(true);
    const pid = Number(await readFile(pidFile, 'utf8'));
    expect(alive(pid)).toBe(true);
    f.stdin.resume();
    f.stdin.end();
    await waitFor(() => !alive(pid));
    expect(alive(pid)).toBe(false);
    expect([...f.signals.keys()].sort()).toEqual(['SIGHUP', 'SIGINT', 'SIGTERM']);
    expect(f.exits).toEqual([]);
  });

  it('a stop signal closes the upstreams, then exits with the signal code', async () => {
    const up = new MemoryMcpUpstream({ srv: ['t'] });
    const f = fakeHooks();
    upstreamLifecycle(f.hooks).attach(up);
    f.signals.get('SIGTERM')?.();
    await waitFor(() => f.exits.length > 0);
    expect(up.closed).toBe(true);
    expect(f.exits).toEqual([143]);
  });

  it('a signal during the start closes every server spawned so far, the one still connecting included', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'acm-mcp-early-'));
    const ready = path.join(dir, 'ready.pid');
    const pending = path.join(dir, 'pending.pid');
    const f = fakeHooks();
    const life = upstreamLifecycle(f.hooks);
    const starting = startMcpUpstreams({
      configFile: await configFile({
        ready: { ...inventory, env: { FAKE_MCP_PID_FILE: ready } },
        pending: { command: process.execPath, args: [FAKE_MCP_UPSTREAM, 'never-init'], env: { FAKE_MCP_PID_FILE: pending } },
      }),
      host: 'claude',
      managedDir: undefined,
      connectTimeoutMs: 20_000,
      signal: life.signal,
    });
    await waitFor(() => existsSync(ready) && existsSync(pending));
    const pids = [Number(await readFile(ready, 'utf8')), Number(await readFile(pending, 'utf8'))];
    expect(pids.every(alive)).toBe(true);
    f.signals.get('SIGTERM')?.();
    const r = await starting;
    if (!r.ok) throw new Error(r.message);
    expect(life.attach(r.upstream)).toBe(false);
    await waitFor(() => pids.every((p) => !alive(p)) && f.exits.length > 0);
    expect(pids.map(alive)).toEqual([false, false]);
    expect(f.exits).toEqual([143]);
  }, 20_000);
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(condition: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
}
