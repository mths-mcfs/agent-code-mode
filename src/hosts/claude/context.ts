import { constants } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { stateDirPath } from '../../core/state-dir.js';
import type { ContextInput, ContextProvider, ContextSource, HookContextRecord, HookContextStore, HostKind, SessionContext } from '../../core/types.js';

/**
 * Companion-hook context files. The companion PreToolUse hook (see
 * `context-hook.ts`) writes one file per `run` call to
 * `<stateDir>/ctx/<tool_use_id>.json`; the server reads the file named by the
 * trusted `_meta["claudecode/toolUseId"]` once and deletes it.
 *
 * Verified on Claude Code 2.1.325: the hook's `tool_use_id` equals the
 * `_meta["claudecode/toolUseId"]` of the matching `tools/call`.
 */

/** Tool-use ids become file names: only these characters, so `../x` and separators are refused. */
export const SAFE_TOOL_USE_ID = /^[A-Za-z0-9_-]{1,200}$/;

/** Largest context file read. */
const MAX_CONTEXT_FILE_BYTES = 64 * 1024;

const optionalText = z.string().min(1).max(4096).optional();

/** The file format: the hook input fields, snake_case, as Claude Code sends them. */
export const ContextFileSchema = z.object({
  tool_use_id: z.string().regex(SAFE_TOOL_USE_ID),
  session_id: z.string().min(1).max(512),
  transcript_path: optionalText,
  cwd: optionalText,
  permission_mode: z.string().min(1).max(64).optional(),
  agent_id: z.string().min(1).max(512).optional(),
  agent_type: z.string().min(1).max(512).optional(),
});
export type ContextFile = z.infer<typeof ContextFileSchema>;

/** Directory of the context files. */
export function contextDir(stateDir: string): string {
  return path.join(stateDir, 'ctx');
}

/** Reads and consumes companion-hook records. */
export class FileHookContextStore implements HookContextStore {
  readonly #dir: string;

  constructor(stateDir: string = stateDirPath()) {
    this.#dir = contextDir(stateDir);
  }

  async lookup(toolUseId: string): Promise<HookContextRecord | undefined> {
    if (!SAFE_TOOL_USE_ID.test(toolUseId)) return undefined;
    const file = path.join(this.#dir, `${toolUseId}.json`);
    // Claim the record: exclusive creation (O_EXCL, atomic on every platform)
    // of a claim file lets exactly one concurrent reader through.
    const claim = path.join(this.#dir, `.${toolUseId}.claim`);
    let claimHandle;
    try {
      claimHandle = await open(claim, 'wx', 0o600);
    } catch {
      return undefined;
    }
    let text: string | undefined;
    try {
      // O_NOFOLLOW: a symlink planted under the name is not followed.
      const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW);
      const handle = await open(file, flags);
      try {
        const st = await handle.stat();
        if (st.isFile() && st.size <= MAX_CONTEXT_FILE_BYTES) text = await handle.readFile('utf8');
      } finally {
        await handle.close();
      }
    } catch {
      text = undefined;
    } finally {
      // Read once: the record is consumed whatever it held, then the claim is released.
      await rm(file, { force: true }).catch(() => undefined);
      await claimHandle.close().catch(() => undefined);
      await rm(claim, { force: true }).catch(() => undefined);
    }
    if (text === undefined) return undefined;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return undefined;
    }
    const parsed = ContextFileSchema.safeParse(json);
    if (!parsed.success || parsed.data.tool_use_id !== toolUseId) return undefined;
    const r = parsed.data;
    return {
      sessionId: r.session_id,
      toolUseId: r.tool_use_id,
      ...(r.cwd === undefined ? {} : { cwd: r.cwd }),
      ...(r.transcript_path === undefined ? {} : { transcriptPath: r.transcript_path }),
      ...(r.permission_mode === undefined ? {} : { permissionMode: r.permission_mode }),
      ...(r.agent_id === undefined ? {} : { agentId: r.agent_id }),
      ...(r.agent_type === undefined ? {} : { agentType: r.agent_type }),
    };
  }
}

/*
 * Session context for Claude Code, from host-controlled channels only.
 */

const id = z.string().min(1).max(512);

/** `_meta` fields Claude Code sends on `tools/call`. */
export const ClaudeMetaSchema = z.object({
  'claudecode/toolUseId': id.optional().catch(undefined),
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

/**
 * The Claude Code context provider: `CLAUDE_CODE_SESSION_ID` from env, the
 * tool-use id from `_meta`, MCP roots, and the companion-hook record keyed by
 * that tool-use id. Tool arguments (including any `_ctx`) are never read.
 */
export function createClaudeContextProvider(opts: { readonly stateDir?: string } = {}): ContextProvider {
  return new ClaudeContextProvider(new FileHookContextStore(opts.stateDir ?? stateDirPath()));
}
