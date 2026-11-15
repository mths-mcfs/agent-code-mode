import { constants } from 'node:fs';
import { open, rm } from 'node:fs/promises';
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

/**
 * The Claude Code context provider: `CLAUDE_CODE_SESSION_ID` from env, the
 * tool-use id from `_meta`, MCP roots, and the companion-hook record keyed by
 * that tool-use id. Tool arguments (including any `_ctx`) are never read.
 */
export function createClaudeContextProvider(opts: { readonly stateDir?: string } = {}): ContextProvider {
  return new ClaudeContextProvider(new FileHookContextStore(opts.stateDir ?? stateDirPath()));
}
