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

/**
 * Whether a server entry would start agent-code-mode itself: its command or
 * an argument is this package (`agent-code-mode`, `npx agent-code-mode@x`)
 * or resolves to this process's entry file. Starting it would recurse.
 */
export function startsThisServer(command: string, args: readonly string[], cwd: string, selfEntry: string | undefined = process.argv[1]): boolean {
  const self = selfEntry === undefined ? undefined : real(selfEntry);
  if (PACKAGE.test(path.basename(command).replace(/\.(cmd|exe|ps1)$/i, ''))) return true;
  return [command, ...args].some((word) => {
    if (PACKAGE.test(word)) return true;
    return self !== undefined && (path.isAbsolute(word) || word.includes('/') || word.includes(path.sep)) && real(path.resolve(cwd, word)) === self;
  });
}
