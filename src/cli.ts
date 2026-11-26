#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { HostKind } from './core/types.js';
import { runContextHook } from './hosts/claude/context-hook.js';
import { applyPlan, parseInstallArgs, planDiff, planInstall } from './install.js';
import { createMcpServer } from './server/mcp.js';

const USAGE = `Usage: agent-code-mode <command>

Commands:
  serve [--host claude|codex|generic] [--hybrid]
                                        Run the MCP stdio server; --hybrid tells the model when to use run
                                        and when a native tool is enough (for hosts that keep their own tools)
  hook                                  Claude Code companion hook (reads the hook input on stdin, prints nothing)
  install --host claude|codex [--scope user|project] [--write] [--local]
                                        Print, and with --write apply, the host configuration

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

interface ServeArgs {
  readonly host?: HostKind;
  readonly hybrid: boolean;
}

function parseServeArgs(args: readonly string[]): ServeArgs | Error {
  let host: HostKind | undefined;
  let hybrid = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--hybrid' && !hybrid) {
      hybrid = true;
      continue;
    }
    const value = arg === '--host' ? args[++i] : arg.startsWith('--host=') ? arg.slice('--host='.length) : undefined;
    const parsed = HostSchema.safeParse(value);
    if (host !== undefined || !parsed.success) return new Error('serve accepts one --host option (claude, codex or generic) and --hybrid');
    host = parsed.data;
  }
  return { hybrid, ...(host ? { host } : {}) };
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
      const serve = parseServeArgs(rest);
      if (serve instanceof Error) {
        process.stderr.write(`${serve.message}\n`);
        return 2;
      }
      const server = createMcpServer({ version: readVersion(), ...serve });
      await server.connect(new StdioServerTransport());
      return -1; // keep running until stdin closes
    }
    case 'hook': {
      // Prints nothing: Claude Code would read any stdout as the hook's decision.
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
        if (plan.changes.length > 0) process.stdout.write('\n# Run again with --write to apply the file changes above.\n');
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
