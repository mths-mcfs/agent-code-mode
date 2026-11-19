import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MAX_RUN_TIMEOUT_MS } from '../core/schemas.js';
import { runScript, toRunRequest } from '../core/run.js';
import { ClaudeHostAdapter } from '../hosts/claude/adapter.js';
import { CodexHostAdapter } from '../hosts/codex/adapter.js';
import { QuickJsSandbox } from '../sandbox/quickjs-sandbox.js';
import { makeContext } from '../testing/context.js';
import { NodeToolRuntime } from '../tools/runtime.js';
import { GENERIC_ASK_REASON, GenericHostAdapter } from './generic-adapter.js';
import { codexMaxTimeoutMs, createRuntime } from './runtime.js';

const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'acm-runtime-')));
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('createRuntime', () => {
  it('wires the real components for each host', () => {
    const env = { XDG_STATE_HOME: path.join(base, 'state') };
    const claude = createRuntime('claude', { env, serverCwd: base });
    expect(claude.adapter).toBeInstanceOf(ClaudeHostAdapter);
    expect(claude.sandbox).toBeInstanceOf(QuickJsSandbox);
    expect(claude.tools).toBeInstanceOf(NodeToolRuntime);
    expect(claude.maxTimeoutMs).toBe(MAX_RUN_TIMEOUT_MS);
    expect(createRuntime('codex', { env, serverCwd: base }).adapter).toBeInstanceOf(CodexHostAdapter);
    expect(createRuntime('generic', { env, serverCwd: base }).adapter).toBeInstanceOf(GenericHostAdapter);
  });

  it('caps Codex runs 10 s below tool_timeout_sec, assuming 60 s when unknown', () => {
    expect(codexMaxTimeoutMs(undefined)).toBe(50_000);
    expect(codexMaxTimeoutMs(300)).toBe(290_000);
    expect(codexMaxTimeoutMs(5)).toBe(1_000);
    expect(codexMaxTimeoutMs(100_000)).toBe(MAX_RUN_TIMEOUT_MS);
    // The 120 s default request becomes min(120 s, cap).
    expect(toRunRequest({ code: '' }, codexMaxTimeoutMs(undefined)).timeoutMs).toBe(50_000);
    expect(toRunRequest({ code: '' }, codexMaxTimeoutMs(300)).timeoutMs).toBe(120_000);
  });
});

describe('generic host policy', () => {
  it('allows reads inside the workspace and refuses every mutation with the reason', async () => {
    const ws = path.join(base, 'ws');
    mkdirSync(ws, { recursive: true });
    writeFileSync(path.join(ws, 'a.txt'), 'hello\n');
    const result = await runScript(
      toRunRequest({ code: `const r = await read({ path: 'a.txt' }); const w = await write({ path: 'b.txt', content: 'x' }).catch((e) => e.message); const b = await bash({ command: 'echo hi' }).catch((e) => e.name); return { r: r.content, w, b };` }),
      {
        sandbox: new QuickJsSandbox(),
        adapter: new GenericHostAdapter({ stateDir: path.join(base, 'state') }),
        tools: new NodeToolRuntime({ stateDir: path.join(base, 'state') }),
        ctx: makeContext(ws),
        signal: new AbortController().signal,
      },
    );
    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({ r: 'hello', b: 'PermissionDenied' });
    expect(JSON.stringify(result.result)).toContain(GENERIC_ASK_REASON);
    expect(result.calls.map((c) => c.decision)).toEqual(['allowed', 'denied', 'denied']);
  });
});
