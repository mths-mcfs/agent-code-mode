import path from 'node:path';
import { z } from 'zod';
import type { ContextInput, ContextProvider, ContextSource, HookContextStore, HostKind, SessionContext } from '../core/types.js';

/**
 * Context providers. They read only host-controlled channels (env, request
 * `_meta`, MCP roots, the companion-hook context file) and validate each one
 * here, at the boundary. Unknown fields fall back to conservative defaults.
 */

const id = z.string().min(1).max(512);

/** `_meta` fields Claude Code sends on `tools/call`. */
export const ClaudeMetaSchema = z.object({
  'claudecode/toolUseId': id.optional().catch(undefined),
});

/** `_meta["x-codex-turn-metadata"]` as Codex CLI sends it. */
export const CodexTurnMetadataSchema = z.object({
  session_id: id.optional().catch(undefined),
  turn_id: id.optional().catch(undefined),
  model: id.optional().catch(undefined),
  sandbox_mode: id.optional().catch(undefined),
});

/** `_meta` fields Codex CLI sends on `tools/call`. */
export const CodexMetaSchema = z.object({
  sessionId: id.optional().catch(undefined),
  'x-codex-turn-metadata': CodexTurnMetadataSchema.optional().catch(undefined),
});

const DEFAULT_PERMISSION_MODE = 'default';

function metaObject(meta: unknown): Record<string, unknown> {
  return meta !== null && typeof meta === 'object' && !Array.isArray(meta) ? Object.fromEntries(Object.entries(meta)) : {};
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

class Builder {
  readonly fields: Record<string, string | undefined> = {};
  readonly sources: Record<string, ContextSource> = {};

  set(field: string, value: string | undefined, source: ContextSource): void {
    if (value === undefined || this.fields[field] !== undefined) return;
    this.fields[field] = value;
    this.sources[field] = source;
  }

  build(host: HostKind, roots: readonly string[], fallbackCwd: string): SessionContext {
    this.set('cwd', fallbackCwd, 'default');
    this.set('permissionMode', DEFAULT_PERMISSION_MODE, 'default');
    const f = this.fields;
    const optional = (key: string): Record<string, string> => (f[key] === undefined ? {} : { [key]: f[key] });
    return {
      host,
      cwd: f['cwd'] ?? fallbackCwd,
      roots: [...roots],
      permissionMode: f['permissionMode'] ?? DEFAULT_PERMISSION_MODE,
      ...optional('sessionId'),
      ...optional('transcriptPath'),
      ...optional('agentId'),
      ...optional('agentType'),
      ...optional('toolUseId'),
      ...optional('turnId'),
      ...optional('model'),
      ...optional('sandboxMode'),
      sources: { ...this.sources },
    };
  }
}

function absoluteRoots(roots: readonly string[]): string[] {
  return roots.filter((r) => path.isAbsolute(r));
}

/** Claude Code: session id from env, tool-use id from `_meta`, the rest from the companion-hook record when present. */
export class ClaudeContextProvider implements ContextProvider {
  constructor(private readonly store?: HookContextStore) {}

  async resolve(input: ContextInput): Promise<SessionContext> {
    const b = new Builder();
    const roots = absoluteRoots(input.roots);
    const envSession = input.env['CLAUDE_CODE_SESSION_ID'];
    const sessionId = envSession !== undefined && id.safeParse(envSession).success ? envSession : undefined;
    b.set('sessionId', sessionId, 'env');
    const meta = ClaudeMetaSchema.parse(metaObject(input.meta));
    const toolUseId = meta['claudecode/toolUseId'];
    b.set('toolUseId', toolUseId, 'meta');

    if (toolUseId !== undefined && this.store) {
      let record;
      try {
        record = await this.store.lookup(toolUseId);
      } catch {
        record = undefined;
      }
      // Only a record for this exact call and session is trusted.
      if (record && record.toolUseId === toolUseId && (sessionId === undefined || record.sessionId === sessionId)) {
        b.set('sessionId', record.sessionId, 'ctx-file');
        if (record.cwd !== undefined && path.isAbsolute(record.cwd) && (roots.length === 0 || roots.some((r) => isInside(record.cwd ?? '', r)))) {
          b.set('cwd', record.cwd, 'ctx-file');
        }
        b.set('transcriptPath', record.transcriptPath, 'ctx-file');
        b.set('permissionMode', record.permissionMode, 'ctx-file');
        b.set('agentId', record.agentId, 'ctx-file');
        b.set('agentType', record.agentType, 'ctx-file');
      }
    }
    b.set('cwd', roots[0], 'roots');
    return b.build('claude', roots, input.serverCwd);
  }
}

/** Codex CLI: session, turn, model and sandbox mode from `_meta`. */
export class CodexContextProvider implements ContextProvider {
  async resolve(input: ContextInput): Promise<SessionContext> {
    const b = new Builder();
    const roots = absoluteRoots(input.roots);
    const meta = CodexMetaSchema.parse(metaObject(input.meta));
    const turn = meta['x-codex-turn-metadata'];
    b.set('sessionId', turn?.session_id ?? meta.sessionId, 'meta');
    b.set('turnId', turn?.turn_id, 'meta');
    b.set('model', turn?.model, 'meta');
    b.set('sandboxMode', turn?.sandbox_mode, 'meta');
    b.set('cwd', roots[0], 'roots');
    return b.build('codex', roots, input.serverCwd);
  }
}

/** Any other client: cwd from roots, everything else default. */
export class GenericContextProvider implements ContextProvider {
  async resolve(input: ContextInput): Promise<SessionContext> {
    const b = new Builder();
    const roots = absoluteRoots(input.roots);
    b.set('cwd', roots[0], 'roots');
    return b.build('generic', roots, input.serverCwd);
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
