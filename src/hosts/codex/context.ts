import path from 'node:path';
import { z } from 'zod';
import type { ContextInput, ContextProvider, ContextSource, SessionContext } from '../../core/types.js';

/**
 * Session context for Codex CLI, from host-controlled channels only.
 *
 * Codex 0.169 sends in `_meta` of each `tools/call`: `sessionId`,
 * `threadId`, `callId` and `x-codex-turn-metadata` (`session_id`,
 * `turn_id`, `model`, `sandbox`, `sandbox_mode`, ...). It announces no MCP
 * roots. The MCP server process is started with the session cwd as its
 * working directory (checked on a real `codex exec -C <dir>`: the server's
 * `process.cwd()` was `<dir>`), so the server cwd is the session cwd.
 * Model-supplied fields (tool arguments, `_ctx`) are never read.
 */

const id = z.string().min(1).max(512);
const opt = id.optional().catch(undefined);

export const CodexTurnMetadataSchema = z.object({
  session_id: opt,
  thread_id: opt,
  turn_id: opt,
  model: opt,
  sandbox: opt,
  sandbox_mode: opt,
});

export const CodexMetaSchema = z.object({
  sessionId: opt,
  threadId: opt,
  callId: opt,
  'x-codex-turn-metadata': CodexTurnMetadataSchema.optional().catch(undefined),
});

function metaObject(meta: unknown): Record<string, unknown> {
  return meta !== null && typeof meta === 'object' && !Array.isArray(meta) ? Object.fromEntries(Object.entries(meta)) : {};
}

export class CodexContextProvider implements ContextProvider {
  async resolve(input: ContextInput): Promise<SessionContext> {
    const meta = CodexMetaSchema.parse(metaObject(input.meta));
    const turn = meta['x-codex-turn-metadata'];
    const sources: Record<string, ContextSource> = {};
    const roots = input.roots.filter((r) => path.isAbsolute(r));
    // The server process cwd is the Codex session cwd (see above).
    const cwd = path.isAbsolute(input.serverCwd) ? path.resolve(input.serverCwd) : (roots[0] ?? path.resolve(input.serverCwd));
    sources['cwd'] = path.isAbsolute(input.serverCwd) ? 'env' : roots[0] !== undefined ? 'roots' : 'default';
    const set = (key: string, value: string | undefined): Record<string, string> => {
      if (value === undefined) return {};
      sources[key] = 'meta';
      return { [key]: value };
    };
    sources['permissionMode'] = 'default';
    return {
      host: 'codex',
      cwd,
      roots,
      permissionMode: 'default',
      ...set('sessionId', turn?.session_id ?? meta.sessionId),
      ...set('turnId', turn?.turn_id),
      ...set('model', turn?.model),
      ...set('sandboxMode', turn?.sandbox_mode),
      ...set('toolUseId', meta.callId),
      sources,
    };
  }
}
