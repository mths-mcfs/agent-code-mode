import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ensureStateDir, stateDirPath } from '../../core/state-dir.js';
import { SAFE_TOOL_USE_ID, contextDir, type ContextFile } from './context.js';

/**
 * Companion PreToolUse hook for Claude Code (`agent-code-mode hook`).
 *
 * Install it with matcher `mcp__agent-code-mode__run`. It reads the hook
 * input on stdin and writes the trusted session context of this `run` call
 * (session id, transcript path, cwd, permission mode, subagent id/type) to
 * `<stateDir>/ctx/<tool_use_id>.json` (directory 0700, file 0600, atomic
 * rename). Files older than one hour are pruned. It prints nothing and always
 * exits 0: it never makes a permission decision.
 */

const HookInputSchema = z.looseObject({
  hook_event_name: z.string().optional(),
  tool_use_id: z.string().regex(SAFE_TOOL_USE_ID),
  session_id: z.string().min(1).max(512),
  transcript_path: z.string().min(1).max(4096).optional().catch(undefined),
  cwd: z.string().min(1).max(4096).optional().catch(undefined),
  permission_mode: z.string().min(1).max(64).optional().catch(undefined),
  agent_id: z.string().min(1).max(512).optional().catch(undefined),
  agent_type: z.string().min(1).max(512).optional().catch(undefined),
});

/** Context files older than this are deleted. */
export const CONTEXT_TTL_MS = 60 * 60 * 1000;

export interface ContextHookOptions {
  readonly stateDir?: string;
  readonly now?: () => number;
}

async function prune(dir: string, now: number): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  await Promise.all(
    names.map(async (name) => {
      const file = path.join(dir, name);
      try {
        const st = await stat(file);
        if (now - st.mtimeMs > CONTEXT_TTL_MS) await rm(file, { force: true });
      } catch {
        // Gone already.
      }
    }),
  );
}

/** Runs the companion hook on its stdin text. Resolves the exit code (always 0). */
export async function runContextHook(stdin: string, opts: ContextHookOptions = {}): Promise<number> {
  try {
    const parsed = HookInputSchema.safeParse(JSON.parse(stdin));
    if (!parsed.success) return 0;
    const input = parsed.data;
    if (input.hook_event_name !== undefined && input.hook_event_name !== 'PreToolUse') return 0;
    // Windows has no owner and mode bits, so no reader could trust a record: none is written.
    if (process.platform === 'win32') return 0;
    const stateDir = await ensureStateDir(opts.stateDir ?? stateDirPath());
    const dir = contextDir(stateDir);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const record: ContextFile = {
      tool_use_id: input.tool_use_id,
      session_id: input.session_id,
      ...(input.transcript_path === undefined ? {} : { transcript_path: input.transcript_path }),
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.permission_mode === undefined ? {} : { permission_mode: input.permission_mode }),
      ...(input.agent_id === undefined ? {} : { agent_id: input.agent_id }),
      ...(input.agent_type === undefined ? {} : { agent_type: input.agent_type }),
    };
    const target = path.join(dir, `${input.tool_use_id}.json`);
    const temp = path.join(dir, `.${input.tool_use_id}.${randomBytes(6).toString('hex')}.tmp`);
    await writeFile(temp, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
    try {
      await rename(temp, target);
    } catch (err) {
      await rm(temp, { force: true });
      throw err;
    }
    await prune(dir, (opts.now ?? Date.now)());
  } catch {
    // Never block the call: without a record the server falls back to conservative defaults.
  }
  return 0;
}
