#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { stateDirPath } from './core/state-dir.js';
import type { HostKind } from './core/types.js';
import { runContextHook } from './hosts/claude/context-hook.js';
import { applyPlan, parseInstallArgs, planDiff, planInstall } from './install.js';
import { createMcpServer } from './server/mcp.js';
import { recoverStaleJournals } from './tools/journal.js';

const USAGE = `Usage: agent-code-mode <command>

Commands:
  serve [--host claude|codex|generic]   Run the MCP stdio server
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
      // Undo what runs of a crashed server left in this workspace before serving.
      const recovered = await recoverStaleJournals(stateDirPath(), [process.cwd()]);
      for (const { id, report } of recovered) {
        process.stderr.write(`agent-code-mode: recovered interrupted run ${id}: ${report.restored.length} file(s) restored, ${report.skipped.length} skipped\n`);
      }
      const server = createMcpServer({ version: readVersion(), ...(host ? { host } : {}) });
      await server.connect(new StdioServerTransport());
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
