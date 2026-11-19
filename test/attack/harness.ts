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
import { CodexHostAdapter } from '../../src/hosts/codex/adapter.js';
import { nodeConfigIo } from '../../src/hosts/codex/config.js';
import { CodexContextProvider } from '../../src/hosts/codex/context.js';
import { commandHookHash } from '../../src/hosts/codex/hooks.js';
import { QuickJsSandbox } from '../../src/sandbox/quickjs-sandbox.js';
import { createMcpServer } from '../../src/server/mcp.js';
import type { Runtime } from '../../src/server/runtime.js';
import { NodeToolRuntime } from '../../src/tools/runtime.js';

/**
 * Attack-suite harness: the real MCP server with the real QuickJS sandbox,
 * the real tool runtime and a real host adapter, configured from fixture
 * files in a temp directory. Every script goes through the `run` tool.
 */

export const posix = process.platform !== 'win32';

/** Shape of the JSON text the `run` tool returns. */
export const RunOutputSchema = z.looseObject({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.looseObject({ name: z.string(), message: z.string(), kind: z.string() }).optional(),
  logs: z.array(z.string()).optional(),
  // Long call logs are shaped: entries past the cap become a string note, which is dropped here.
  calls: z
    .array(z.union([z.looseObject({ id: z.string(), tool: z.string(), decision: z.string(), reason: z.string().optional() }), z.string()]))
    .transform((xs) => xs.filter((x) => typeof x !== 'string'))
    .optional(),
  changedFiles: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
  rolledBack: z.unknown().optional(),
  truncated: z.unknown().optional(),
});
export type RunOutput = z.infer<typeof RunOutputSchema>;

export interface Lab {
  /** Temp base: holds ws/, outside/, home/ and state/. */
  readonly base: string;
  /** Workspace (session cwd). */
  readonly ws: string;
  /** A directory outside the workspace with a file the script must never touch. */
  readonly outside: string;
  readonly home: string;
  readonly stateDir: string;
  /** Writes an example hook script (Node) and returns its absolute path. */
  hook(name: string, body: string): string;
  cleanup(): void;
}

/** Creates the temp layout. `files` are written under the workspace. */
export function makeLab(files: Record<string, string> = {}): Lab {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'acm-attack-')));
  const ws = path.join(base, 'ws');
  const outside = path.join(base, 'outside');
  const home = path.join(base, 'home');
  const stateDir = path.join(base, 'state');
  const hooksDir = path.join(base, 'hooks');
  for (const d of [ws, outside, home, stateDir, hooksDir]) mkdirSync(d, { recursive: true });
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

/** Every entry under `dir` (links not followed) with its content, to compare before and after an attack. */
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
  /** Calls `run` and returns the parsed result. */
  run(code: string, opts?: { transaction?: boolean; timeoutMs?: number; signal?: AbortSignal }): Promise<RunOutput>;
  /** Calls `run` and returns the raw text of the response. */
  runText(code: string): Promise<string>;
  close(): Promise<void>;
}

async function serve(runtime: Runtime, lab: Lab, meta: Record<string, unknown>, roots: boolean): Promise<Server> {
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
    const res = await client.callTool({ name: 'run', arguments: args, _meta: meta }, CallToolResultSchema, { timeout: 120_000, ...(signal ? { signal } : {}) });
    const parsed = z.object({ content: z.array(z.object({ type: z.literal('text'), text: z.string() })).min(1) }).parse(res);
    return parsed.content[0]?.text ?? '';
  };
  return {
    async run(code, opts = {}) {
      const text = await call(
        { code, ...(opts.transaction ? { transaction: true } : {}), ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) },
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

/** A server for Claude Code with the given project `.claude/settings.json` (trusted project, no managed settings). */
export async function claudeServer(lab: Lab, settings: Record<string, unknown>): Promise<Server> {
  mkdirSync(path.join(lab.ws, '.claude'), { recursive: true });
  writeFileSync(path.join(lab.ws, '.claude', 'settings.json'), JSON.stringify(settings));
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
  return serve(runtime, lab, { 'claudecode/toolUseId': 'toolu_attack' }, true);
}

/** A Codex command hook entry for `hooks.json`. */
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
  writeFileSync(path.join(codexHome, 'config.toml'), `approval_policy = "never"\n${opts.extraToml ?? ''}\n[features]\nhooks = true\n\n${state}`);
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
    'x-codex-turn-metadata': { session_id: 'session-attack', turn_id: 'turn-1', model: 'test-model', sandbox_mode: opts.sandboxMode ?? 'danger-full-access' },
  };
  return serve(runtime, lab, meta, false);
}

/** The call-log entry of the n-th call (1-based). */
export function callAt(out: RunOutput, n: number): { decision: string; reason?: string | undefined } | undefined {
  return out.calls?.find((c) => c.id === `c${n}`);
}
