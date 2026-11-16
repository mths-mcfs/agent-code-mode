import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ERROR_CAP_CHARS, SUCCESS_CAP_CHARS } from '../../src/core/output.js';
import { claudeServer, makeLab, posix, snapshot, type Lab, type Server } from './harness.js';

let lab: Lab | undefined;
let server: Server | undefined;
afterEach(async () => {
  await server?.close();
  lab?.cleanup();
  server = undefined;
  lab = undefined;
});

async function start(files: Record<string, string>, settings: Record<string, unknown> = {}): Promise<{ lab: Lab; server: Server }> {
  lab = makeLab(files);
  server = await claudeServer(lab, { permissions: { defaultMode: 'bypassPermissions', ...settings } });
  return { lab, server };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('transactions roll back after a denied call', () => {
  it.runIf(posix)('restores edited and created files when a later bash call is denied', async () => {
    const { lab, server } = await start({ 'keep.txt': 'original\n' }, { deny: ['Bash(rm:*)'] });
    const before = snapshot(lab.ws);
    const out = await server.run(
      `await edit({ path: 'keep.txt', oldString: 'original', newString: 'changed' });
       await write({ path: 'created.txt', content: 'new' });
       await write({ path: 'deep/dir/file.txt', content: 'nested' });
       await bash({ command: 'rm -f keep.txt' });
       return 'unreachable';`,
      { transaction: true },
    );
    expect(out.ok).toBe(false);
    expect(out.error?.kind).toBe('denied');
    expect(out.rolledBack).toBeDefined();
    expect(readFileSync(path.join(lab.ws, 'keep.txt'), 'utf8')).toBe('original\n');
    expect(existsSync(path.join(lab.ws, 'created.txt'))).toBe(false);
    expect(existsSync(path.join(lab.ws, 'deep'))).toBe(false);
    expect(snapshot(lab.ws)).toEqual(before);
  });

  it('restores files when a protected-path write is refused mid-transaction and the script rethrows', async () => {
    const { lab, server } = await start({ 'a.txt': 'a\n' });
    const before = snapshot(lab.ws);
    const out = await server.run(`await write({ path: 'a.txt', content: 'changed' }); await write({ path: '.mcp.json', content: '{}' });`, { transaction: true });
    expect(out.ok).toBe(false);
    expect(snapshot(lab.ws)).toEqual(before);
  });
});

describe('cancellation', () => {
  it('a cancelled run makes no writes after it stops', async () => {
    const { lab, server } = await start({});
    const controller = new AbortController();
    const pending = server.run(`for (let i = 0; ; i++) await write({ path: 'out/f' + i + '.txt', content: String(i) });`, { signal: controller.signal });
    const outDir = path.join(lab.ws, 'out');
    for (let i = 0; i < 300 && !(existsSync(outDir) && readdirSync(outDir).length >= 3); i++) await sleep(50);
    controller.abort();
    await expect(pending).rejects.toThrow();
    // The dispatcher's settle grace is 2 s; after it nothing may land.
    await sleep(3_000);
    const settled = readdirSync(outDir).length;
    await sleep(2_000);
    expect(readdirSync(outDir).length).toBe(settled);
    expect(settled).toBeGreaterThanOrEqual(3);
  });

  it.runIf(posix)('a cancelled bash call is killed and its later effect never happens', async () => {
    const { lab, server } = await start({});
    const controller = new AbortController();
    const pending = server.run(`await bash({ command: 'sleep 2 && echo late > late.txt' });`, { signal: controller.signal });
    await sleep(700);
    controller.abort();
    await expect(pending).rejects.toThrow();
    await sleep(3_500);
    expect(existsSync(path.join(lab.ws, 'late.txt'))).toBe(false);
  });
});

describe('oversized outputs are capped', () => {
  it('a huge return value is refused or capped below the host limit', async () => {
    const { server } = await start({});
    const text = await server.runText(`return 'x'.repeat(5_000_000);`);
    expect(text.length).toBeLessThanOrEqual(Math.max(SUCCESS_CAP_CHARS, ERROR_CAP_CHARS) + 2_000);
  });

  it('a large but legal result is shaped under the success cap with an overflow file', async () => {
    const { server } = await start({});
    const text = await server.runText(`return Array.from({ length: 20000 }, (_, i) => 'line ' + i);`);
    expect(text.length).toBeLessThanOrEqual(SUCCESS_CAP_CHARS + 2_000);
    expect(text).toMatch(/overflow/i);
  });

  it.runIf(posix)('bash output is cut and flagged as truncated', async () => {
    const { server } = await start({});
    const out = await server.run(`const r = await bash({ command: 'head -c 20000000 /dev/zero | tr "\\\\0" a' }); return { len: r.stdout.length, truncated: r.truncated };`);
    expect(out.ok).toBe(true);
    expect(out.result).toMatchObject({ truncated: true });
  });

  it('console flooding is capped', async () => {
    const { server } = await start({});
    const text = await server.runText(`for (let i = 0; i < 100000; i++) console.log('spam ' + i + ' ' + 'y'.repeat(200)); return 'done';`);
    expect(text.length).toBeLessThanOrEqual(SUCCESS_CAP_CHARS + 2_000);
  });

  it('a huge read is cut to the read cap', async () => {
    const big = Array.from({ length: 50_000 }, (_, i) => `row ${i} ${'z'.repeat(40)}`).join('\n');
    const { server } = await start({ 'big.txt': big });
    const out = await server.run(`const r = await read({ path: 'big.txt', limit: 100000 }); return { truncated: r.truncated, chars: r.content.length };`);
    expect(out.result).toMatchObject({ truncated: true });
  });
});
