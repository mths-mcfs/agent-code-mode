import { realpathSync } from 'node:fs';
import path from 'node:path';

/** Set in the environment of every upstream server this server starts: a `serve` that has it starts no upstream server. */
export const UPSTREAM_ENV = 'AGENT_CODE_MODE_UPSTREAM';

const PACKAGE = /^agent-code-mode(@.*)?$/;

function real(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** Subcommands a package runner takes before the package it runs (`pnpm dlx x`, `yarn exec x`). */
const RUNNER_SUBCOMMANDS = new Set(['dlx', 'exec', 'x']);

/**
 * Whether a server entry would start agent-code-mode itself, judged in
 * program position only: the command is this package or resolves to this
 * process's entry file, or the first operand of the command (`npx -y
 * agent-code-mode`, `node ./dist/cli.js`) is. A later argument that merely
 * names the package is data. Starting it would recurse; the
 * `AGENT_CODE_MODE_UPSTREAM` marker stops any nesting this misses.
 */
export function startsThisServer(command: string, args: readonly string[], cwd: string, selfEntry: string | undefined = process.argv[1]): boolean {
  const self = selfEntry === undefined ? undefined : real(selfEntry);
  const isSelf = (word: string): boolean =>
    PACKAGE.test(word) ||
    PACKAGE.test(path.basename(word).replace(/\.(cmd|exe|ps1)$/i, '')) ||
    (self !== undefined && (path.isAbsolute(word) || word.includes('/') || word.includes(path.sep)) && real(path.resolve(cwd, word)) === self);
  const operand = args.find((a, i) => !a.startsWith('-') && !(i === 0 && RUNNER_SUBCOMMANDS.has(a)));
  return isSelf(command) || (operand !== undefined && isSelf(operand));
}
