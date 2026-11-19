import { constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { lstat, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { stateDirPath } from '../../core/state-dir.js';
import type { ContextProvider, HookContextRecord, HookContextStore } from '../../core/types.js';
import { ClaudeContextProvider } from '../../server/context.js';

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

/** Whether `dir` is a directory itself (not a link to one) owned by `uid` that no one else can use. */
export async function isPrivateDir(dir: string, uid: number): Promise<boolean> {
  const st = await lstat(dir).catch(() => undefined);
  return st !== undefined && st.isDirectory() && st.uid === uid && (st.mode & 0o077) === 0;
}

/** Reads and consumes companion-hook records. */
export class FileHookContextStore implements HookContextStore {
  readonly #dir: string;

  constructor(stateDir: string = stateDirPath()) {
    this.#dir = contextDir(stateDir);
  }

  /**
   * Trusts a record only in private directories owned by this user, as a
   * regular file of this user nobody else can write; never on Windows.
   */
  async lookup(toolUseId: string): Promise<HookContextRecord | undefined> {
    if (!SAFE_TOOL_USE_ID.test(toolUseId)) return undefined;
    const uid = process.getuid?.();
    if (uid === undefined) return undefined;
    if (!(await isPrivateDir(path.dirname(this.#dir), uid)) || !(await isPrivateDir(this.#dir, uid))) return undefined;
    // Claim: an atomic rename off the lookup name gives the record to one reader, even if cleanup fails.
    const file = path.join(this.#dir, `${toolUseId}.json`);
    const claimed = path.join(this.#dir, `.${toolUseId}.${randomBytes(6).toString('hex')}.claimed`);
    try {
      await rename(file, claimed);
    } catch {
      return undefined;
    }
    let text: string | undefined;
    try {
      // O_NOFOLLOW: a symlink renamed into place is not followed.
      const handle = await open(claimed, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const st = await handle.stat();
        if (st.isFile() && st.uid === uid && (st.mode & 0o022) === 0 && st.size <= MAX_CONTEXT_FILE_BYTES) text = await handle.readFile('utf8');
      } finally {
        await handle.close();
      }
    } catch {
      text = undefined;
    } finally {
      await rm(claimed, { force: true }).catch(() => undefined);
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

/**
 * The Claude Code context provider: `CLAUDE_CODE_SESSION_ID` from env, the
 * tool-use id from `_meta`, MCP roots, and the companion-hook record keyed by
 * that tool-use id. Tool arguments (including any `_ctx`) are never read.
 */
export function createClaudeContextProvider(opts: { readonly stateDir?: string } = {}): ContextProvider {
  return new ClaudeContextProvider(new FileHookContextStore(opts.stateDir ?? stateDirPath()));
}
