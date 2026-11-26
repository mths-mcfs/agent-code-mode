import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { formatIssues } from './schemas.js';
import type { CallReply } from './types.js';

export const OVERFLOW_TTL_MS = 30 * 60_000;
export const OVERFLOW_MAX_CHARS = 32_000_000;
export const READ_OVERFLOW_DEFAULT_LIMIT = 100_000;
export const READ_OVERFLOW_MAX_LIMIT = 1_000_000;

const ReadOverflowArgsSchema = z.strictObject({
  id: z.string().max(64),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(READ_OVERFLOW_MAX_LIMIT).optional(),
});

export interface OverflowStoreOptions {
  readonly ttlMs?: number;
  readonly maxChars?: number;
  readonly now?: () => number;
}

export class OverflowStore {
  readonly #entries = new Map<string, { readonly text: string; readonly expiresAt: number }>();
  readonly #ttlMs: number;
  readonly #maxChars: number;
  readonly #now: () => number;
  #chars = 0;

  constructor(opts: OverflowStoreOptions = {}) {
    this.#ttlMs = opts.ttlMs ?? OVERFLOW_TTL_MS;
    this.#maxChars = opts.maxChars ?? OVERFLOW_MAX_CHARS;
    this.#now = opts.now ?? Date.now;
  }

  put(text: string): string | undefined {
    this.#prune();
    if (text.length > this.#maxChars) return undefined;
    for (const id of this.#entries.keys()) {
      if (this.#chars + text.length <= this.#maxChars) break;
      this.#drop(id);
    }
    const id = `ov_${randomBytes(16).toString('base64url')}`;
    this.#entries.set(id, { text, expiresAt: this.#now() + this.#ttlMs });
    this.#chars += text.length;
    return id;
  }

  read(args: unknown): CallReply {
    const parsed = ReadOverflowArgsSchema.safeParse(args);
    if (!parsed.success) return { ok: false, error: { name: 'ToolError', code: 'invalid-args', message: `readOverflow: ${formatIssues(parsed.error)}` } };
    const { id, offset = 0, limit = READ_OVERFLOW_DEFAULT_LIMIT } = parsed.data;
    this.#prune();
    const entry = this.#entries.get(id);
    if (entry === undefined) {
      return { ok: false, error: { name: 'ToolError', code: 'not-found', message: `readOverflow: no kept result with id ${JSON.stringify(id)} (unknown, expired, or from another server process)` } };
    }
    const text = entry.text.slice(offset, offset + limit);
    return { ok: true, value: { text, offset, totalChars: entry.text.length, truncated: offset + text.length < entry.text.length } };
  }

  clear(): void {
    this.#entries.clear();
    this.#chars = 0;
  }

  #prune(): void {
    const now = this.#now();
    for (const [id, entry] of this.#entries) if (entry.expiresAt <= now) this.#drop(id);
  }

  #drop(id: string): void {
    const entry = this.#entries.get(id);
    if (entry === undefined) return;
    this.#entries.delete(id);
    this.#chars -= entry.text.length;
  }
}
