/**
 * The native Codex shape of each prepared call, as Codex hooks and exec
 * policy rules see it, and the mapping of a hook's `updatedInput` back to
 * binding args.
 *
 * - bash        → `Bash {command}` (Codex `exec_command`; the hook cwd is the command's workdir).
 * - write, edit → `apply_patch {command: <patch>}`, matched also by `Write` and `Edit`.
 * - read has no native Codex tool (Codex reads through the shell), so it is
 *   shown as the `Bash` command Codex would typically run; the tool runtime
 *   performs the equivalent read in-process.
 * - grep and glob run as an exact rg command through the bash executor
 *   (search.ts), so they reach hooks and rules as that `Bash` call.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { EditArgs, PreparedCall, PreparedCallOf, SessionContext, WriteArgs } from '../../core/types.js';
import { applyHunk, generatePatch, parsePatch, PatchError } from './apply-patch.js';
import { shellQuote } from './shell.js';

export const APPLY_PATCH_NAMES = ['apply_patch', 'Write', 'Edit'] as const;
export const BASH_NAMES = ['Bash'] as const;

export function shellCommandFor(prepared: PreparedCall): string | undefined {
  switch (prepared.tool) {
    case 'bash':
      return prepared.effect.command;
    case 'read': {
      const e = prepared.effect;
      return `sed -n ${shellQuote(`${e.offset},${e.offset + e.limit - 1}p`)} -- ${shellQuote(e.absPath)}`;
    }
    case 'grep':
    case 'glob':
      return undefined;
    case 'write':
    case 'edit':
      return undefined;
  }
}

export interface NativeCall {
  readonly toolName: 'Bash' | 'apply_patch';
  readonly toolInput: { readonly command: string };
  /** Names hook matchers are tested against. */
  readonly names: readonly string[];
  /** `cwd` field of the hook input (and the hook process cwd). */
  readonly cwd: string;
  /** For write/edit: the current file content the patch was generated from (null: no file). */
  readonly before?: string | null;
  /** For write/edit: whether the patch reproduces the after content byte for byte. */
  readonly exact?: boolean;
}

export class NativeShapeError extends Error {
  override readonly name = 'NativeShapeError';
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function patchPath(absPath: string, cwd: string): string {
  const rel = path.relative(cwd, absPath);
  if (rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  return absPath;
}

async function currentContent(absPath: string, beforeHash: string | null): Promise<string | null> {
  let buf: Buffer;
  try {
    buf = await readFile(absPath);
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      if (beforeHash === null) return null;
      throw new NativeShapeError(`${absPath} no longer exists`);
    }
    throw new NativeShapeError(`cannot read ${absPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (beforeHash === null) throw new NativeShapeError(`${absPath} was created after the call was prepared`);
  if (sha256(buf) !== beforeHash) throw new NativeShapeError(`${absPath} changed after the call was prepared`);
  const text = buf.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buf)) throw new NativeShapeError(`${absPath} is not valid UTF-8 text`);
  return text;
}

/**
 * Builds the native call. For write/edit it reads the file (I/O), verifies
 * its hash against the prepared before-hash and generates the patch.
 * Throws `NativeShapeError` when the file no longer matches.
 */
export async function nativeCall(prepared: PreparedCall, ctx: SessionContext, readCurrent = currentContent): Promise<NativeCall> {
  if (prepared.tool === 'write' || prepared.tool === 'edit') {
    const e = prepared.effect;
    const before = await readCurrent(e.absPath, e.beforeHash);
    let generated;
    try {
      generated = generatePatch(patchPath(e.absPath, ctx.cwd), before, e.afterContent);
    } catch (err) {
      throw new NativeShapeError(`cannot express the change as a Codex patch: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { toolName: 'apply_patch', toolInput: { command: generated.patch }, names: APPLY_PATCH_NAMES, cwd: ctx.cwd, before, exact: generated.exact };
  }
  const command = shellCommandFor(prepared);
  if (command === undefined) throw new NativeShapeError('no shell command for this call');
  return { toolName: 'Bash', toolInput: { command }, names: BASH_NAMES, cwd: prepared.tool === 'bash' ? prepared.effect.cwd : ctx.cwd };
}

/** Codex's `updatedInput` for Bash and apply_patch: exactly `{command}`. */
const UpdatedCommandSchema = z.strictObject({ command: z.string() });

export type MappedUpdate =
  | { readonly kind: 'unchanged' }
  /**
   * `bindsPreparedFile`: the args were computed from the file version the hook
   * evaluated, so the dispatcher must commit them only against that version.
   */
  | { readonly kind: 'updated'; readonly args: unknown; readonly bindsPreparedFile?: true }
  | { readonly kind: 'invalid'; readonly reason: string }
  | { readonly kind: 'unsupported'; readonly reason: string };

function mapPatch(prepared: PreparedCallOf<'write'> | PreparedCallOf<'edit'>, native: NativeCall, patch: string, ctx: SessionContext): MappedUpdate {
  let parsed;
  try {
    parsed = parsePatch(patch);
  } catch (err) {
    return { kind: 'unsupported', reason: `hook returned an apply_patch that does not parse: ${err instanceof PatchError ? err.message : String(err)}` };
  }
  if (parsed.environmentId !== null) return { kind: 'unsupported', reason: 'hook returned an apply_patch with an environment id' };
  const [hunk] = parsed.hunks;
  if (parsed.hunks.length !== 1 || hunk === undefined) return { kind: 'unsupported', reason: 'hook returned an apply_patch that is not a single-file change' };
  if (hunk.kind === 'delete') return { kind: 'unsupported', reason: 'hook returned an apply_patch that deletes a file' };
  if (hunk.kind === 'update' && hunk.movePath !== null) return { kind: 'unsupported', reason: 'hook returned an apply_patch that moves a file' };
  if (path.resolve(ctx.cwd, hunk.path) !== prepared.effect.absPath) {
    return { kind: 'unsupported', reason: 'hook returned an apply_patch for another file' };
  }
  const before = native.before ?? null;
  let content: string;
  try {
    content = applyHunk(before, hunk);
  } catch (err) {
    return { kind: 'unsupported', reason: `hook apply_patch does not apply: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (prepared.tool === 'write') {
    const args: WriteArgs = { path: prepared.args.path, content };
    return { kind: 'updated', args, bindsPreparedFile: true };
  }
  if (before === null || before === '') return { kind: 'unsupported', reason: 'hook apply_patch cannot be expressed as an edit of an empty file' };
  const args: EditArgs = { path: prepared.args.path, oldString: before, newString: content };
  return { kind: 'updated', args, bindsPreparedFile: true };
}

/** Maps a hook's `updatedInput` (untrusted) back to binding args for the same tool. */
export function mapUpdatedInput(prepared: PreparedCall, native: NativeCall, updatedInput: unknown, ctx: SessionContext): MappedUpdate {
  const parsed = UpdatedCommandSchema.safeParse(updatedInput);
  if (!parsed.success) return { kind: 'invalid', reason: 'hook returned updatedInput that is not exactly {command: string}' };
  const command = parsed.data.command;
  if (command === native.toolInput.command) return { kind: 'unchanged' };
  switch (prepared.tool) {
    case 'bash':
      return { kind: 'updated', args: { ...prepared.args, command } };
    case 'read':
    case 'grep':
    case 'glob':
      return { kind: 'unsupported', reason: `hook rewrote the shell command shown for ${prepared.tool}, which cannot be mapped back to ${prepared.tool} arguments` };
    case 'write':
    case 'edit':
      return mapPatch(prepared, native, command, ctx);
  }
}
