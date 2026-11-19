#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { HostKind } from './core/types.js';
import { createMcpServer } from './server/mcp.js';

const USAGE = `Usage: agent-code-mode <command>

Commands:
  serve [--host claude|codex|generic]   Run the MCP stdio server
  hook                                  Companion hook entry point (not implemented yet)
  install                               Register the server with a host (not implemented yet)

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
  const [arg, valueAfterFlag] = args;
  if (arg === undefined) return undefined;
  const value = arg === '--host' && args.length === 2 ? valueAfterFlag :
    args.length === 1 && arg.startsWith('--host=') ? arg.slice('--host='.length) : undefined;
  const parsed = HostSchema.safeParse(value);
  return parsed.success ? parsed.data : new Error('serve accepts only one --host option: claude, codex or generic');
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
      const server = createMcpServer({ version: readVersion(), ...(host ? { host } : {}) });
      await server.connect(new StdioServerTransport());
      return -1; // keep running until stdin closes
    }
    case 'hook':
    case 'install':
      process.stderr.write(`agent-code-mode ${command}: not implemented yet\n`);
      return 1;
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
