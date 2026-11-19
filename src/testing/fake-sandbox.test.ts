import { describe, expect, it } from 'vitest';
import type { SandboxRunOptions } from '../core/types.js';
import { FakeSandbox } from './fake-sandbox.js';

function options(overrides: Partial<SandboxRunOptions> = {}): SandboxRunOptions {
  return {
    timeoutMs: 1_000,
    memoryBytes: 1,
    signal: new AbortController().signal,
    onCall: async () => ({ ok: true, value: { files: [], truncated: false } }),
    onLog: () => undefined,
    ...overrides,
  };
}

describe('FakeSandbox', () => {
  it('leaves no timer behind when a script finishes or times out during a sleep', async () => {
    const timers = (): number => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    const before = timers();
    const sandbox = new FakeSandbox();
    expect(await sandbox.run('[]', options())).toMatchObject({ ok: true });
    expect(timers()).toBe(before);
    expect(await sandbox.run(JSON.stringify([{ sleep: 60_000 }]), options({ timeoutMs: 20 }))).toMatchObject({ ok: false, kind: 'timeout' });
    expect(timers()).toBe(before);
  });
});
