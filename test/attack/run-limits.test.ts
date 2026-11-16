import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

describe('overlapping transactional runs on the same workspace', () => {
  it('a second transaction may not write a file the first one journaled, so both roll back to the original', async () => {
    const { lab, server } = await start({ 'x': 'original', 'gateA': 'wait', 'gateB': 'wait' });
    const wait = (gate: string): string => `while ((await read({ path: '${gate}' })).content === 'wait') {}`;
    const a = server.run(`await write({ path: 'x', content: 'A' }); await write({ path: 'readyA', content: 'y' }); ${wait('gateA')}; throw new Error('abort A');`, { transaction: true });
    const ready = async (f: string): Promise<void> => {
      for (let i = 0; i < 400 && !existsSync(path.join(lab.ws, f)); i++) await sleep(25);
    };
    await ready('readyA');
    const b = server.run(
      `const w = await write({ path: 'x', content: 'B' }).then(() => 'written', (e) => e.message); await write({ path: 'readyB', content: w }); ${wait('gateB')}; throw new Error('abort B');`,
      { transaction: true },
    );
    await ready('readyB');
    expect(readFileSync(path.join(lab.ws, 'readyB'), 'utf8')).toMatch(/another transactional run/);
    writeFileSync(path.join(lab.ws, 'gateA'), 'go');
    expect((await a).ok).toBe(false);
    writeFileSync(path.join(lab.ws, 'gateB'), 'go');
    expect((await b).ok).toBe(false);
    expect(readFileSync(path.join(lab.ws, 'x'), 'utf8')).toBe('original');
    // Once the first run ended, the file is free again.
    const later = await server.run(`await write({ path: 'x', content: 'C' }); throw new Error('abort C');`, { transaction: true });
    expect(later.ok).toBe(false);
    expect(readFileSync(path.join(lab.ws, 'x'), 'utf8')).toBe('original');
    expect(existsSync(path.join(lab.ws, 'readyA'))).toBe(false);
  });
});

describe('cancellation', () => {
  it('a cancelled run makes no writes after it stops', async () => {
    const { lab, server } = await start({});
    const controller = new AbortController();
    const pending = server.run(`for (let i = 0; ; i++) await write({ path: 'out/f' + i + '.txt', content: String(i) });`, { signal: controller.signal });
    const outDir = path.join(lab.ws, 'out');
    // Only completed targets count: writes land by an atomic rename, so f<n>.txt exists only once it is whole;
    // the in-flight `.f<n>.txt.acm-*.tmp` temp file is not a write.
    const completed = (): string[] => (existsSync(outDir) ? readdirSync(outDir).filter((n) => /^f\d+\.txt$/.test(n)).sort() : []);
    const temps = (): string[] => (existsSync(outDir) ? readdirSync(outDir).filter((n) => n.endsWith('.tmp')) : []);
    // Explicit signal: the third file of the sequence is complete (writes are serialized, so f0..f2 are too).
    const third = path.join(outDir, 'f2.txt');
    for (let i = 0; i < 600 && !existsSync(third); i++) await sleep(25);
    expect(existsSync(third)).toBe(true);
    controller.abort();
    await expect(pending).rejects.toThrow();
    // The dispatcher's settle grace is 2 s: a commit already running when the run stopped may still land within it.
    await sleep(3_000);
    const settled = completed();
    expect(settled.length).toBeGreaterThanOrEqual(3);
    await sleep(2_000);
    // Strict: after the run stopped and settled, not one more file and no write in progress.
    expect(completed()).toEqual(settled);
    expect(temps()).toEqual([]);
    for (const name of settled) expect(readFileSync(path.join(outDir, name), 'utf8')).toBe(name.slice(1, -4));
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

describe('readOverflow reads back what a response cut, in this server session only', () => {
  const overflowOf = (text: string): { id: string; chars: number } => {
    const body: unknown = JSON.parse(text);
    const overflow = body !== null && typeof body === 'object' && 'overflow' in body ? body.overflow : undefined;
    if (overflow === null || typeof overflow !== 'object' || !('id' in overflow) || typeof overflow.id !== 'string' || !('chars' in overflow) || typeof overflow.chars !== 'number') {
      throw new Error(`no overflow in ${text.slice(0, 200)}`);
    }
    return { id: overflow.id, chars: overflow.chars };
  };

  it('a cut result is readable whole from the next script, with no file path in the response', async () => {
    const { lab, server } = await start({});
    const blocks = await server.runBlocks(`return Array.from({ length: 30000 }, (_, i) => 'line ' + i).join('\\n');`);
    const text = blocks.join('');
    expect(text.length).toBeLessThanOrEqual(SUCCESS_CAP_CHARS);
    expect(text).not.toContain(lab.stateDir);
    expect(readdirSync(lab.stateDir).filter((f) => f.startsWith('run-'))).toEqual([]);
    const { id, chars } = overflowOf(blocks[0] ?? '');
    const out = await server.run(
      `const parts = []; let offset = 0;
       for (;;) { const s = await readOverflow(${JSON.stringify(id)}, offset, 50000); parts.push(s.text); offset += s.text.length; if (!s.truncated) break; }
       const whole = JSON.parse(parts.join(''));
       const lines = whole.result.split('\\n');
       return { chars: offset, lines: lines.length, last: lines[lines.length - 1] };`,
    );
    expect(out.result).toEqual({ chars, lines: 30_000, last: 'line 29999' });
  });

  it('an id from another server session, a made-up id and bad arguments are refused', async () => {
    const { lab, server } = await start({});
    const { id } = overflowOf((await server.runBlocks(`return 'x\\n'.repeat(30000);`))[0] ?? '');
    const other = await claudeServer(lab, { permissions: { defaultMode: 'bypassPermissions' } });
    try {
      const out = await other.run(
        `const errors = [];
         for (const args of [[${JSON.stringify(id)}], ['ov_AAAAAAAAAAAAAAAAAAAAAA'], ['../state/run-1.json'], [${JSON.stringify(id)}, -1], [${JSON.stringify(id)}, 0, 0]]) {
           try { await readOverflow(...args); errors.push('read'); } catch (e) { errors.push(e.name + ':' + e.code); }
         }
         return errors;`,
      );
      expect(out.result).toEqual(['ToolError:not-found', 'ToolError:not-found', 'ToolError:not-found', 'ToolError:invalid-args', 'ToolError:invalid-args']);
    } finally {
      await other.close();
    }
  });
});
