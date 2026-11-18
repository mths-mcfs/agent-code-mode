#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { stateDirPath } from './core/state-dir.js';
import type { HostKind } from './core/types.js';
import { runContextHook } from './hosts/claude/context-hook.js';
import { managedSettingsDir } from './hosts/claude/settings.js';
import { applyPlan, parseInstallArgs, planDiff, planInstall } from './install.js';
import { parseMcpConfigFlag, processExitHooks, startMcpUpstreams, upstreamLifecycle } from './mcp/start.js';
import type { McpUpstream } from './mcp/upstream.js';
import { detectHost } from './server/context.js';
import { createMcpServer } from './server/mcp.js';
import { REGISTERED_SERVER_NAME } from './server/runtime.js';
import { recoverStaleJournals } from './tools/journal.js';
import { closeSessionsOnExit, sweepDeadSessions } from './tools/session-dirs.js';

const USAGE = `Usage: agent-code-mode <command>

Commands:
  serve [--host claude|codex|generic] [--hybrid] [--mcp-config <file>]
                                        Run the MCP stdio server; --hybrid adds one line to the run description
                                        for hosts that keep their native file and shell tools next to run;
                                        --mcp-config starts the stdio MCP servers of a .mcp.json-style file and
                                        exposes their tools to scripts as mcpCall (Claude Code host only)
  hook                                  Claude Code companion PreToolUse hook (reads the hook JSON on stdin)
  install --host claude|codex [--scope user|project] [--write] [--local]
                                        Print the host configuration; --write applies it after showing the diff;
                                        --local runs this checkout with node instead of npx

Options:
  --version   Print the version
  --help      Print this help`;

function readVersion(): string {
  try {
    const pkg = z.object({ version: z.string() }).parse(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')));
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

const HostSchema = z.enum(['claude', 'codex', 'generic']);

function parseHost(args: readonly string[]): HostKind | undefined | Error {
  const i = args.findIndex((a) => a === '--host' || a.startsWith('--host='));
  if (i === -1) return undefined;
  const arg = args[i] ?? '';
  const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[i + 1];
  const parsed = HostSchema.safeParse(value);
  return parsed.success ? parsed.data : new Error(`--host must be one of claude, codex, generic`);
}

const HybridSchema = z.enum(['true', 'false']);

/** `--hybrid` (or `--hybrid=true|false`): whether the `run` description gets the hybrid guidance line. */
function parseHybrid(args: readonly string[]): boolean | Error {
  let hybrid = false;
  for (const arg of args) {
    if (arg === '--hybrid') hybrid = true;
    else if (arg.startsWith('--hybrid=')) {
      const parsed = HybridSchema.safeParse(arg.slice('--hybrid='.length));
      if (!parsed.success) return new Error('--hybrid takes no value (or =true / =false)');
      hybrid = parsed.data === 'true';
    }
  }
  return hybrid;
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === '--version' || command === '-v') {
    process.stdout.write(`${readVersion()}\n`);
    return 0;
  }
  if (command === undefined || command === '--help' || command === '-h') {
    process.stdout.write(`${USAGE}\n`);
    return command === undefined ? 1 : 0;
  }
  switch (command) {
    case 'serve': {
      const host = parseHost(rest);
      if (host instanceof Error) {
        process.stderr.write(`${host.message}\n`);
        return 2;
      }
      const hybrid = parseHybrid(rest);
      if (hybrid instanceof Error) {
        process.stderr.write(`${hybrid.message}\n`);
        return 2;
      }
      const mcpConfig = parseMcpConfigFlag(rest);
      if (mcpConfig instanceof Error) {
        process.stderr.write(`${mcpConfig.message}\n`);
        return 2;
      }
      let upstream: McpUpstream | undefined;
      let lifecycle: ReturnType<typeof upstreamLifecycle> | undefined;
      if (mcpConfig !== undefined) {
        // Installed before any upstream starts: a signal or EOF during the start must not leave one running.
        lifecycle = upstreamLifecycle(processExitHooks(process));
        const started = await startMcpUpstreams({
          signal: lifecycle.signal,
          configFile: path.resolve(mcpConfig),
          host: host ?? detectHost({ env: process.env, meta: undefined }),
          managedDir: managedSettingsDir(),
          reservedServerNames: [REGISTERED_SERVER_NAME],
          cwd: process.cwd(),
          clientVersion: readVersion(),
        });
        if (!started.ok) {
          lifecycle.release();
          process.stderr.write(`agent-code-mode: ${started.message}\n`);
          return 2;
        }
        upstream = started.upstream;
        if (!lifecycle.attach(upstream)) return -1; // the session ended while the upstreams started: they are being closed
        const { catalog } = upstream;
        for (const problem of catalog.problems) process.stderr.write(`agent-code-mode: ${problem}\n`);
        process.stderr.write(`agent-code-mode: ${catalog.servers.length} upstream MCP server(s) connected, ${catalog.tools.length} tool(s) available to mcpCall\n`);
      }
      // Undo what runs of a crashed server left in this workspace before serving.
      const recovered = await recoverStaleJournals(stateDirPath(), [process.cwd()]);
      for (const { id, report, kept } of recovered) {
        process.stderr.write(
          `agent-code-mode: recovered interrupted run ${id}: ${report.restored.length} file(s) restored, ${report.skipped.length} skipped${kept ? '; its journal is kept because some files could not be restored' : ''}\n`,
        );
        for (const s of report.skipped) process.stderr.write(`agent-code-mode:   not restored: ${s.path} (${s.reason}${s.detail ? `: ${s.detail}` : ''})\n`);
      }
      // Scratch and undo directories go with this process, and those of processes that died are removed now.
      closeSessionsOnExit(process, lifecycle === undefined);
      await sweepDeadSessions(stateDirPath());
      // With upstream servers the host is Claude Code, checked above; pin it so no request can switch it.
      const servedHost = upstream !== undefined ? 'claude' : host;
      const server = createMcpServer({ version: readVersion(), hybrid, ...(servedHost ? { host: servedHost } : {}), ...(upstream ? { mcp: upstream } : {}) });
      try {
        await server.connect(new StdioServerTransport());
        // stdin was paused when the upstreams were handed over; the transport now listens.
        lifecycle?.resumeInput();
      } catch (err) {
        // A start that fails after the upstream servers started must not leave them running.
        await upstream?.close();
        throw err;
      }
      return -1; // keep running until stdin closes
    }
    case 'hook': {
      // Prints nothing: any stdout would be read by Claude Code as the hook's decision.
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return runContextHook(Buffer.concat(chunks).toString('utf8'));
    }
    case 'install': {
      const opts = parseInstallArgs(rest, { cwd: process.cwd(), env: process.env });
      if (opts instanceof Error) {
        process.stderr.write(`${opts.message}\n${USAGE}\n`);
        return 2;
      }
      const plan = await planInstall(opts);
      process.stdout.write(plan.text);
      if (!opts.write) {
        if (plan.changes.length > 0) process.stdout.write(`\n# Run again with --write to apply the file changes above.\n`);
        return 0;
      }
      if (plan.refusals.length > 0) {
        process.stderr.write(`agent-code-mode install: nothing written:\n${plan.refusals.map((r) => `  ${r}`).join('\n')}\n`);
        return 1;
      }
      const diff = planDiff(plan);
      if (diff === '') {
        process.stdout.write('\n# Nothing to write: the configuration is already in place.\n');
        return 0;
      }
      process.stdout.write(`\n# Writing:\n${diff}`);
      await applyPlan(plan);
      for (const c of plan.changes) process.stdout.write(`# wrote ${c.file}\n`);
      if (plan.commands.length > 0) process.stdout.write(`# Still to run yourself:\n${plan.commands.join('\n')}\n`);
      return 0;
    }
    default:
      process.stderr.write(`unknown command ${JSON.stringify(command)}\n${USAGE}\n`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`agent-code-mode: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
