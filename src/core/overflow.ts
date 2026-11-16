import { randomBytes } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { formatIssues } from './schemas.js';
import type { BindingError, CallReply, OverflowSlice } from './types.js';

/** How long a kept result stays readable. */
export const OVERFLOW_TTL_MS = 30 * 60_000;
/** Total characters the store keeps; the oldest entries go first. */
export const OVERFLOW_MAX_CHARS = 32_000_000;
/** Characters `readOverflow` returns when the script gives no limit. */
export const READ_OVERFLOW_DEFAULT_LIMIT = 100_000;
/** Largest `limit` a script may ask for. */
export const READ_OVERFLOW_MAX_LIMIT = 1_000_000;

const ID_PATTERN = /^ov_[A-Za-z0-9_-]{22}$/;

const ReadOverflowArgsSchema = z.strictObject({
  id: z.string().max(64),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(READ_OVERFLOW_MAX_LIMIT).optional(),
});

export interface OverflowStoreOptions {
  readonly ttlMs?: number;
  readonly maxChars?: number;
  /** Clock, for tests. */
  readonly now?: () => number;
}

interface Entry {
  readonly text: string;
  readonly expiresAt: number;
}

/**
 * In-memory store of the run results a response cut. Ids are random and
 * opaque; entries live only in this server process (one MCP session), expire
 * after `ttlMs` and are never written to disk.
 */
export class OverflowStore {
  readonly #entries = new Map<string, Entry>();
  readonly #ttlMs: number;
  readonly #maxChars: number;
  readonly #now: () => number;
  #chars = 0;

  constructor(opts: OverflowStoreOptions = {}) {
    this.#ttlMs = opts.ttlMs ?? OVERFLOW_TTL_MS;
    this.#maxChars = opts.maxChars ?? OVERFLOW_MAX_CHARS;
    this.#now = opts.now ?? Date.now;
  }

  /** Number of live entries. */
  get size(): number {
    this.#prune();
    return this.#entries.size;
  }

  /** Keeps `text` and returns its id, or undefined when it cannot be kept. */
  put(text: string): string | undefined {
    this.#prune();
    if (text.length > this.#maxChars) return undefined;
    for (const [id, entry] of this.#entries) {
      if (this.#chars + text.length <= this.#maxChars) break;
      this.#drop(id, entry);
    }
    const id = `ov_${randomBytes(16).toString('base64url')}`;
    this.#entries.set(id, { text, expiresAt: this.#now() + this.#ttlMs });
    this.#chars += text.length;
    return id;
  }

  /** The `readOverflow` binding. `args` comes from the script and is validated here. */
  read(args: unknown): CallReply {
    const parsed = ReadOverflowArgsSchema.safeParse(args);
    if (!parsed.success) return toolError('invalid-args', `readOverflow: ${formatIssues(parsed.error)}`);
    const { id, offset = 0, limit = READ_OVERFLOW_DEFAULT_LIMIT } = parsed.data;
    this.#prune();
    const entry = ID_PATTERN.test(id) ? this.#entries.get(id) : undefined;
    if (entry === undefined) return toolError('not-found', `readOverflow: no kept result with id ${JSON.stringify(id.slice(0, 40))} (unknown or expired)`);
    const text = entry.text.slice(offset, offset + limit);
    const value: OverflowSlice = { text, offset, totalChars: entry.text.length, truncated: offset + text.length < entry.text.length };
    return { ok: true, value };
  }

  /** Drops every entry. */
  clear(): void {
    this.#entries.clear();
    this.#chars = 0;
  }

  #prune(): void {
    const now = this.#now();
    for (const [id, entry] of this.#entries) if (entry.expiresAt <= now) this.#drop(id, entry);
  }

  #drop(id: string, entry: Entry): void {
    this.#entries.delete(id);
    this.#chars -= entry.text.length;
  }
}

function toolError(code: Extract<BindingError, { name: 'ToolError' }>['code'], message: string): CallReply {
  return { ok: false, error: { name: 'ToolError', code, message } };
}

/** Name of the overflow files older versions wrote to the state directory. */
const LEGACY_OVERFLOW_FILE = /^run-\d+-[0-9a-f]{12}\.json$/;

/**
 * Deletes the overflow files older versions left in `stateDir` (whole run
 * results, never cleaned up). Only files with that exact name pattern are
 * touched. Returns how many were removed; never rejects.
 */
export async function removeLegacyOverflowFiles(stateDir: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(stateDir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names.filter((n) => LEGACY_OVERFLOW_FILE.test(n))) {
    try {
      await rm(path.join(stateDir, name), { force: true });
      removed++;
    } catch {
      // Left for a later start.
    }
  }
  return removed;
}
