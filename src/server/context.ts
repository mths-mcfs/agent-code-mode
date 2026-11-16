import path from 'node:path';
import type { ContextInput, ContextProvider, HostKind, SessionContext } from '../core/types.js';

/**
 * Host detection and the context provider for clients that are neither
 * Claude Code nor Codex. The Claude and Codex providers live with their
 * adapters (src/hosts/claude/context.ts, src/hosts/codex/context.ts).
 */

function metaObject(meta: unknown): Record<string, unknown> {
  return meta !== null && typeof meta === 'object' && !Array.isArray(meta) ? Object.fromEntries(Object.entries(meta)) : {};
}

/** Any other client: cwd from the first absolute root, else the server cwd; everything else default. */
export class GenericContextProvider implements ContextProvider {
  async resolve(input: ContextInput): Promise<SessionContext> {
    const roots = input.roots.filter((r) => path.isAbsolute(r));
    const first = roots[0];
    return {
      host: 'generic',
      cwd: first ?? input.serverCwd,
      roots,
      permissionMode: 'default',
      sources: { cwd: first === undefined ? 'default' : 'roots', permissionMode: 'default' },
    };
  }
}

/** Picks the host: explicit flag, else Claude env, else Codex `_meta`, else generic. */
export function detectHost(input: { flag?: HostKind | undefined; env: Readonly<Record<string, string | undefined>>; meta: unknown }): HostKind {
  if (input.flag) return input.flag;
  const session = input.env['CLAUDE_CODE_SESSION_ID'];
  if (session !== undefined && session !== '') return 'claude';
  const turn = metaObject(input.meta)['x-codex-turn-metadata'];
  if (turn !== null && typeof turn === 'object' && !Array.isArray(turn)) return 'codex';
  return 'generic';
}
