import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { containmentUnavailableReason } from '../../src/tools/sandbox.js';
import { Checks, checkNodeTests, runHiddenTests, runNodeTests } from '../tasks/checks.ts';

const unavailable = process.platform === 'win32' ? 'no OS sandbox on Windows' : await containmentUnavailableReason();

let root: string;
let ws: string;

beforeEach(async () => {
  // The workspace sits in a directory of its own, so `../outside` is this test's and no one else's.
  root = await mkdtemp(path.join(os.tmpdir(), 'acm-node-tests-'));
  ws = path.join(root, 'ws');
  await mkdir(path.join(ws, 'test'), { recursive: true });
});

afterEach(async () => {
  delete process.env['BENCH_FAKE_SECRET'];
  await rm(root, { recursive: true, force: true });
});

describe('the verifiers\' node --test run', () => {
  it('writes the hidden tests into a new hidden-tests directory, never through one the agent left', async () => {
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    const hidden = { 'h.test.js': "require('node:test').test('hidden', () => {});\n" };
    // A hidden-tests link to a directory outside the workspace.
    await symlink(outside, path.join(ws, 'hidden-tests'), process.platform === 'win32' ? 'junction' : 'dir');
    const viaDir = await runHiddenTests(ws, hidden);
    expect(await readdir(outside)).toEqual([]);
    // A real hidden-tests directory whose test file links to a file outside it.
    await rm(path.join(ws, 'hidden-tests'));
    await mkdir(path.join(ws, 'hidden-tests'));
    await writeFile(path.join(outside, 'target'), 'kept\n');
    await symlink(path.join(outside, 'target'), path.join(ws, 'hidden-tests', 'h.test.js')).catch(() => {});
    const viaFile = await runHiddenTests(ws, hidden);
    expect(await readFile(path.join(outside, 'target'), 'utf8')).toBe('kept\n');
    if (unavailable === null) for (const r of [viaDir, viaFile]) expect(r, r.output).toMatchObject({ ok: true, pass: 1, fail: 0 });
  });

  it('fails the check, without throwing, when the workspace is missing', async () => {
    const checks = new Checks();
    await checkNodeTests(checks, path.join(ws, 'missing'));
    expect(checks.result()).toMatchObject({ pass: false, details: [expect.stringMatching(/^FAIL node --test passes \(pass 0, fail 0\): Error: node --test could not start/)] });
  });

  it.skipIf(process.platform === 'win32')('on timeout leaves no test process behind', async () => {
    const pidFile = path.join(ws, 'pid');
    await writeFile(path.join(ws, 'test', 'loop.test.js'), `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nrequire('node:test').test('spins', () => { for (;;) {} });\n`);
    const result = await runNodeTests(ws, 3_000);
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/timed out after 3000 ms/);
    const pid = Number(await readFile(pidFile, 'utf8'));
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('keeps the operator\'s environment out of the tests', async () => {
    process.env['BENCH_FAKE_SECRET'] = 'leaked';
    await writeFile(path.join(ws, 'test', 'env.test.js'), "require('node:test').test('env', () => { require('node:assert').equal(process.env.BENCH_FAKE_SECRET, undefined); });\n");
    expect(await runNodeTests(ws)).toMatchObject({ ok: true, pass: 1, fail: 0 });
  });

  it.skipIf(unavailable !== null)('keeps the agent\'s tests from writing outside the workspace or opening a connection', async () => {
    const connections: net.Socket[] = [];
    const server = net.createServer((socket) => connections.push(socket));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = address !== null && typeof address === 'object' ? address.port : 0;
    try {
      await writeFile(path.join(ws, 'test', 'escape.test.js'), [
        "const { test } = require('node:test');",
        "test('writes ../outside', () => { require('node:fs').writeFileSync(require('node:path').join(process.cwd(), '..', 'outside'), 'x'); });",
        `test('opens a TCP connection', () => new Promise((resolve, reject) => { const s = require('node:net').connect(${port}, '127.0.0.1'); s.on('connect', () => { s.end(); resolve(); }); s.on('error', reject); }));`,
      ].join('\n'));
      const checks = new Checks();
      await checkNodeTests(checks, ws);
      expect(checks.result()).toMatchObject({ pass: false, details: [expect.stringMatching(/^FAIL node --test passes \(pass 0, fail 2\)/)] });
      expect(existsSync(path.join(root, 'outside'))).toBe(false);
      expect(connections).toHaveLength(0);
    } finally {
      for (const s of connections) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
