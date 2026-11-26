import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema, ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ClaudeHostAdapter } from '../../src/hosts/claude/adapter.js';
import { ClaudeContextProvider, FileHookContextStore } from '../../src/hosts/claude/context.js';
import { runContextHook } from '../../src/hosts/claude/context-hook.js';
import { CodexHostAdapter } from '../../src/hosts/codex/adapter.js';
import { nodeConfigIo } from '../../src/hosts/codex/config.js';
import { CodexContextProvider } from '../../src/hosts/codex/context.js';
import { commandHookHash } from '../../src/hosts/codex/hooks.js';
import { QuickJsSandbox } from '../../src/sandbox/quickjs-sandbox.js';
import { createMcpServer } from '../../src/server/mcp.js';
import type { Runtime } from '../../src/server/runtime.js';
import { NodeToolRuntime } from '../../src/tools/runtime.js';
import { containmentUnavailableReason } from '../../src/tools/sandbox.js';

export const posix = process.platform !== 'win32';

export const BASH_SANDBOX_AVAILABLE = (await containmentUnavailableReason()) === null;

export const RunOutputSchema = z.looseObject({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.looseObject({ name: z.string(), message: z.string(), kind: z.string() }).optional(),
  logs: z.array(z.string()).optional(),
  // Above the response cap even a verbose run comes back as counts, with nothing listed per allowed call.
  calls: z
    .union([
      z.array(z.looseObject({ id: z.string(), tool: z.string(), decision: z.string(), reason: z.string().optional() })),
      z.looseObject({ total: z.number() }).transform(() => []),
    ])
    .optional(),
  changedFiles: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
  rolledBack: z.unknown().optional(),
  truncated: z.unknown().optional(),
});
export type RunOutput = z.infer<typeof RunOutputSchema>;

export interface Lab {
  readonly base: string;
  readonly ws: string;
  readonly outside: string;
  readonly home: string;
  readonly stateDir: string;
  hook(name: string, body: string): string;
  cleanup(): void;
}

export function makeLab(files: Record<string, string> = {}): Lab {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'acm-attack-')));
  const ws = path.join(base, 'ws');
  const outside = path.join(base, 'outside');
  const home = path.join(base, 'home');
  const stateDir = path.join(base, 'state');
  const hooksDir = path.join(base, 'hooks');
  for (const d of [ws, outside, home, hooksDir]) mkdirSync(d, { recursive: true });
  mkdirSync(stateDir, { mode: 0o700 });
  mkdirSync(path.join(stateDir, 'ctx'), { mode: 0o700 });
  writeFileSync(path.join(outside, 'secret.txt'), 'outside secret\n');
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    writeFileSync(path.join(ws, rel), content);
  }
  return {
    base,
    ws,
    outside,
    home,
    stateDir,
    hook(name, body) {
      const file = path.join(hooksDir, `${name}.mjs`);
      writeFileSync(file, `import { readFileSync } from 'node:fs';\nconst input = JSON.parse(readFileSync(0, 'utf8'));\n${body}\n`);
      return file;
    },
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

export function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = path.join(d, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) out[p] = `link:${readlinkSync(p)}`;
      else if (st.isDirectory()) {
        out[p] = 'dir';
        walk(p);
      } else out[p] = `file:${readFileSync(p, 'utf8')}`;
    }
  };
  walk(dir);
  return out;
}

export interface Server {
  run(code: string, opts?: { transaction?: boolean; timeoutMs?: number; signal?: AbortSignal }): Promise<RunOutput>;
  runText(code: string): Promise<string>;
  close(): Promise<void>;
}

async function serve(runtime: Runtime, lab: Lab, meta: () => Promise<Record<string, unknown>>, roots: boolean): Promise<Server> {
  const server = createMcpServer({
    version: '0.0.0-attack',
    host: runtime.host,
    env: {},
    serverCwd: lab.ws,
    stateDir: lab.stateDir,
    createRuntime: () => runtime,
  });
  const client = new Client({ name: 'attack-client', version: '1.0.0' }, { capabilities: roots ? { roots: {} } : {} });
  if (roots) client.setRequestHandler(ListRootsRequestSchema, () => ({ roots: [{ uri: pathToFileURL(lab.ws).href }] }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (args: Record<string, unknown>, signal?: AbortSignal): Promise<string> => {
    const res = await client.callTool({ name: 'run', arguments: args, _meta: await meta() }, CallToolResultSchema, { timeout: 120_000, ...(signal ? { signal } : {}) });
    const parsed = z.object({ content: z.array(z.object({ type: z.literal('text'), text: z.string() })).min(1) }).parse(res);
    return parsed.content[0]?.text ?? '';
  };
  return {
    async run(code, opts = {}) {
      const text = await call(
        { code, verbose: true, ...(opts.transaction ? { transaction: true } : {}), ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) },
        opts.signal,
      );
      return RunOutputSchema.parse(JSON.parse(text));
    },
    runText: (code) => call({ code }),
    async close() {
      await client.close();
      await server.close();
    },
  };
}

/**
 * A server for Claude Code with the given project `.claude/settings.json`
 * (trusted project, no managed settings). Before each call the companion hook
 * records `mode` as the live permission mode, as Claude Code's PreToolUse hook
 * on the run tool does: project settings cannot start bypassPermissions. Bash
 * runs inside Claude's sandbox unless the settings configure `sandbox`.
 */
export async function claudeServer(lab: Lab, settings: Record<string, unknown>, opts: { mode?: string } = {}): Promise<Server> {
  mkdirSync(path.join(lab.ws, '.claude'), { recursive: true });
  writeFileSync(path.join(lab.ws, '.claude', 'settings.json'), JSON.stringify({ sandbox: { enabled: true }, ...settings }));
  mkdirSync(path.join(lab.home, '.claude'), { recursive: true });
  writeFileSync(path.join(lab.home, '.claude.json'), JSON.stringify({ projects: { [lab.ws]: { hasTrustDialogAccepted: true } } }));
  const runtime: Runtime = {
    host: 'claude',
    contextProvider: new ClaudeContextProvider(new FileHookContextStore(lab.stateDir)),
    adapter: new ClaudeHostAdapter({ env: {}, home: lab.home, managedDir: null, stateDir: lab.stateDir, readParent: async () => undefined }),
    tools: new NodeToolRuntime({ stateDir: lab.stateDir }),
    sandbox: new QuickJsSandbox(),
    maxTimeoutMs: 60_000,
  };
  let call = 0;
  const meta = async (): Promise<Record<string, unknown>> => {
    const toolUseId = `toolu_attack_${++call}`;
    const record = { hook_event_name: 'PreToolUse', tool_use_id: toolUseId, session_id: 'session-attack', cwd: lab.ws, permission_mode: opts.mode ?? 'bypassPermissions' };
    await runContextHook(JSON.stringify(record), { stateDir: lab.stateDir });
    return { 'claudecode/toolUseId': toolUseId };
  };
  return serve(runtime, lab, meta, true);
}

export interface CodexHook {
  readonly matcher?: string;
  readonly script: string;
  readonly timeoutSec?: number;
}

/**
 * A server for Codex with a temp `CODEX_HOME`: `config.toml` (`approval_policy
 * = "never"` plus `extraToml`), `rules/default.rules` and `hooks.json` with
 * each hook trusted through `[hooks.state]` the way Codex records trust.
 */
export async function codexServer(
  lab: Lab,
  opts: { rules?: string; hooks?: readonly CodexHook[]; sandboxMode?: string; extraToml?: string } = {},
): Promise<Server> {
  const codexHome = path.join(lab.base, 'codex-home');
  mkdirSync(path.join(codexHome, 'rules'), { recursive: true });
  const hooksFile = path.join(codexHome, 'hooks.json');
  const groups = (opts.hooks ?? []).map((h) => ({
    ...(h.matcher === undefined ? {} : { matcher: h.matcher }),
    hooks: [{ type: 'command', command: `"${process.execPath}" "${h.script}"`, timeout: h.timeoutSec ?? 10 }],
  }));
  writeFileSync(hooksFile, JSON.stringify({ hooks: { PreToolUse: groups } }));
  const state = (opts.hooks ?? [])
    .map((h, i) => {
      const hash = commandHookHash({ matcher: h.matcher, command: `"${process.execPath}" "${h.script}"`, timeoutSec: h.timeoutSec ?? 10, async: false });
      return `[hooks.state."${hooksFile}:pre_tool_use:${i}:0"]\ntrusted_hash = "${hash}"\n`;
    })
    .join('\n');
  const sandboxMode = opts.sandboxMode ?? 'danger-full-access';
  writeFileSync(path.join(codexHome, 'config.toml'), `approval_policy = "never"\nsandbox_mode = "${sandboxMode}"\n${opts.extraToml ?? ''}\n[features]\nhooks = true\n\n${state}`);
  if (opts.rules) writeFileSync(path.join(codexHome, 'rules', 'default.rules'), opts.rules);
  const io = { ...nodeConfigIo({ CODEX_HOME: codexHome }), home: lab.home, systemDir: path.join(lab.base, 'etc-codex'), parentArgv: () => ['codex', 'exec'] };
  const runtime: Runtime = {
    host: 'codex',
    contextProvider: new CodexContextProvider(),
    adapter: new CodexHostAdapter({ io: () => io, hookEnv: { PATH: process.env['PATH'], SHELL: '/bin/sh' }, stateDir: lab.stateDir }),
    tools: new NodeToolRuntime({ stateDir: lab.stateDir }),
    sandbox: new QuickJsSandbox(),
    maxTimeoutMs: 50_000,
  };
  const meta = {
    sessionId: 'session-attack',
    callId: 'call-attack',
    'x-codex-turn-metadata': { session_id: 'session-attack', turn_id: 'turn-1', model: 'test-model', sandbox_mode: sandboxMode },
  };
  return serve(runtime, lab, async () => meta, false);
}

export function callAt(out: RunOutput, n: number): { decision: string; reason?: string | undefined } | undefined {
  return out.calls?.find((c) => c.id === `c${n}`);
}
