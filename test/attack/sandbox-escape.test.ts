import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claudeServer, makeLab, snapshot, type Lab, type Server } from './harness.js';

describe('sandbox escape attempts through run', () => {
  let lab: Lab;
  let server: Server;
  let before: Record<string, string>;

  beforeAll(async () => {
    lab = makeLab({ 'a.txt': 'hello\n' });
    server = await claudeServer(lab, {});
    before = snapshot(lab.base);
  });
  afterAll(async () => {
    await server.close();
    lab.cleanup();
  });

  it('exposes no require, process, fetch, module loading or timers', async () => {
    const out = await server.run(`return {
      require: typeof require, process: typeof process, fetch: typeof fetch, Buffer: typeof Buffer,
      importFn: await import('node:fs').then(() => 'loaded', (e) => 'refused: ' + e.name),
      setTimeout: typeof setTimeout, WebAssembly: typeof WebAssembly, XMLHttpRequest: typeof XMLHttpRequest, WebSocket: typeof WebSocket,
    };`);
    expect(out.ok).toBe(true);
    expect(out.result).toMatchObject({
      require: 'undefined', process: 'undefined', fetch: 'undefined', Buffer: 'undefined', setTimeout: 'undefined', XMLHttpRequest: 'undefined', WebSocket: 'undefined',
      importFn: expect.stringMatching(/^refused/),
    });
  });

  it('Function("return this") and constructor chains only reach the VM global', async () => {
    const out = await server.run(`
      const g1 = Function('return this')();
      const g2 = (() => {}).constructor.constructor('return this')();
      const g3 = Object.getPrototypeOf(async function () {}).constructor('return globalThis')();
      let viaBinding;
      try { viaBinding = read.constructor.constructor('return typeof process')(); } catch (e) { viaBinding = 'threw ' + e.name; }
      return { p1: typeof g1.process, p2: typeof g2.process, p3: typeof (await g3).process, req: typeof g1.require, viaBinding };`);
    expect(out.ok).toBe(true);
    expect(out.result).toEqual({ p1: 'undefined', p2: 'undefined', p3: 'undefined', req: 'undefined', viaBinding: 'undefined' });
  });

  it('eval-free code generation tricks do not escape either', async () => {
    const out = await server.run(`
      const tries = [];
      for (const src of ['return process', 'return require("fs")', 'return globalThis.process.mainModule']) {
        try { tries.push(String(new Function(src)())); } catch (e) { tries.push(e.name); }
      }
      return tries;`);
    expect(out.ok).toBe(true);
    expect(out.result).toEqual(['ReferenceError', 'ReferenceError', 'TypeError']);
  });

  it('prototype pollution inside the VM does not reach the server or later runs', async () => {
    const polluted = await server.run(`
      Object.prototype.polluted = 'yes';
      Array.prototype.push = () => { throw new Error('hijacked'); };
      JSON.parse = () => ({ path: '/etc/passwd' });
      Object.defineProperty(Object.prototype, 'path', { get() { return '../outside/secret.txt'; }, configurable: true });
      let r;
      try { r = await read({}); } catch (e) { r = e.name + ':' + e.code; }
      const w = await write({ path: 'own.txt', content: 'x', ['__proto__']: { path: '../outside/evil.txt' } }).then(() => 'written', (e) => e.name + ':' + e.code);
      return { r, w };`);
    expect(polluted.ok).toBe(true);
    expect(polluted.result).toMatchObject({ r: 'ToolError:invalid-args' });
    expect(Reflect.get({}, 'polluted')).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'path')).toBe(false);
    const clean = await server.run(`return { polluted: ({}).polluted, path: ({}).path };`);
    expect(clean.result).toEqual({});
    const after = snapshot(lab.base);
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => after[k] !== before[k] && !k.startsWith(lab.stateDir));
    expect(changed.every((k) => k === path.join(lab.ws, 'own.txt'))).toBe(true);
    expect(after[path.join(lab.outside, 'secret.txt')]).toBe('file:outside secret\n');
  });

  it('a runaway script is killed at its timeout and leaves nothing behind', async () => {
    const out = await server.run(`for (;;) {}`, { timeoutMs: 1_500 });
    expect(out.ok).toBe(false);
    expect(out.error?.kind).toBe('timeout');
    const huge = await server.run(`const a = []; for (;;) a.push('x'.repeat(1 << 20));`, { timeoutMs: 20_000 });
    expect(huge.ok).toBe(false);
    expect(['oom', 'error', 'killed']).toContain(huge.error?.kind);
  });
});
