/** The part of a Node `Writable` that `BoundedWriter` uses. */
export interface WritableLike {
  write(chunk: Buffer): boolean;
  readonly writableLength: number;
  readonly destroyed: boolean;
  once(event: 'drain', listener: () => void): unknown;
}

export interface BoundedWriterOptions {
  /** Most bytes that may wait for the reader (stream buffer plus local queue). */
  readonly maxPendingBytes: number;
  /** Most bytes written over the writer's lifetime. */
  readonly maxTotalBytes: number;
  /** Monotonic time past which nothing is written. */
  readonly deadline: number;
  /** Monotonic clock compared with `deadline`. Default `performance.now`. */
  readonly now?: () => number;
  /** Called once when the deadline stops a write; nothing is written after it. */
  readonly onExpired: () => void;
  /** Called once when a limit would be exceeded; nothing is written after it. */
  readonly onOverflow: (message: string) => void;
}

/**
 * The only writer to a stream that a possibly stalled reader consumes (the
 * sandbox child's stdin). It respects backpressure: once a write returns
 * false, lines wait in a local queue until `drain`. The bytes waiting (stream
 * buffer plus queue) and the bytes written in total are both capped, so a
 * reader that stops reading can never make the writer's process grow without
 * bound; hitting a cap calls `onOverflow` instead.
 *
 * Every byte reaches the stream through `#emit`, which reads the clock right
 * before `stream.write`, after the line is sized, encoded and taken off the
 * queue: past the deadline nothing more is written and `onExpired` is called.
 */
export class BoundedWriter {
  readonly #stream: WritableLike;
  readonly #options: BoundedWriterOptions;
  #queue: Buffer[] = [];
  #queuedBytes = 0;
  #totalBytes = 0;
  #waitingForDrain = false;
  #closed = false;

  constructor(stream: WritableLike, options: BoundedWriterOptions) {
    this.#stream = stream;
    this.#options = options;
  }

  /** Bytes buffered in the stream or queued here, not yet taken by the reader. */
  get pendingBytes(): number {
    return this.#stream.writableLength + this.#queuedBytes;
  }

  /** Writes or queues `line`, counted against both caps. Returns false when the writer is closed, a cap was hit or the deadline passed. */
  write(line: string): boolean {
    if (this.#closed) return false;
    const bytes = Buffer.byteLength(line, 'utf8');
    if (!this.#fits(bytes)) return false;
    // Buffers live outside the V8 heap, so pending replies do not count against the server's heap limit.
    const chunk = Buffer.from(line, 'utf8');
    this.#totalBytes += bytes;
    if (this.#waitingForDrain || this.#queue.length > 0) {
      this.#queue.push(chunk);
      this.#queuedBytes += bytes;
      return true;
    }
    return this.#emit(chunk);
  }

  /** Writes `value` as one JSON line, sized first so that a line over a cap is never built. */
  writeJson(value: unknown): boolean {
    if (this.#closed) return false;
    const room = Math.min(this.#options.maxTotalBytes - this.#totalBytes, this.#options.maxPendingBytes - this.pendingBytes);
    const bytes = jsonBytes(value, room) + 1;
    return this.#fits(bytes) && this.write(`${JSON.stringify(value)}\n`);
  }

  /** Writes `chunk` outside both caps: the sandbox's `start` message, sent before any reply, whose size the caller limits. */
  writeStart(chunk: Buffer): boolean {
    return this.#emit(chunk);
  }

  /** Drops queued lines; later writes are ignored. */
  close(): void {
    this.#closed = true;
    this.#queue = [];
    this.#queuedBytes = 0;
  }

  /** The single call of `stream.write`. */
  #emit(chunk: Buffer): boolean {
    if (this.#closed || this.#stream.destroyed) return false;
    if (this.#expired()) {
      this.close();
      this.#options.onExpired();
      return false;
    }
    if (!this.#stream.write(chunk)) this.#waitForDrain();
    return true;
  }

  #expired(): boolean {
    return (this.#options.now?.() ?? performance.now()) >= this.#options.deadline;
  }

  #fits(bytes: number): boolean {
    if (this.#totalBytes + bytes > this.#options.maxTotalBytes) {
      return this.#overflow(`binding results sent to the script exceeded ${this.#options.maxTotalBytes} bytes in total`);
    }
    if (this.pendingBytes + bytes > this.#options.maxPendingBytes) {
      return this.#overflow(`binding results the script has not read yet exceeded ${this.#options.maxPendingBytes} bytes`);
    }
    return true;
  }

  /** Past the deadline a full buffer is a timeout, not an overflow. */
  #overflow(message: string): false {
    this.close();
    if (this.#expired()) this.#options.onExpired();
    else this.#options.onOverflow(message);
    return false;
  }

  #waitForDrain(): void {
    this.#waitingForDrain = true;
    this.#stream.once('drain', () => {
      this.#waitingForDrain = false;
      this.#flush();
    });
  }

  #flush(): void {
    while (!this.#waitingForDrain && this.#queue.length > 0) {
      const chunk = this.#queue.shift();
      if (chunk === undefined) break;
      this.#queuedBytes -= chunk.length;
      if (!this.#emit(chunk)) return;
    }
  }
}

/** UTF-8 bytes of `JSON.stringify(value)` for plain JSON data (binding replies), without building it; stops once past `limit`. */
export function jsonBytes(value: unknown, limit: number): number {
  let n = 0;
  const visit = (v: unknown): void => {
    if (typeof v === 'string') {
      n += 2;
      for (let i = 0; i < v.length && n <= limit; i++) {
        const c = v.charCodeAt(i);
        const pair = c >= 0xd800 && c < 0xdc00 && (v.charCodeAt(i + 1) & 0xfc00) === 0xdc00;
        if (pair) i++;
        // 0x3700 marks \b \t \n \f \r, the control characters with a two-character escape; lone surrogates become \uXXXX.
        n += pair ? 4 : c < 0x20 ? ((0x3700 >> c) & 1 ? 2 : 6) : c === 0x22 || c === 0x5c ? 2 : c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c < 0xe000 ? 6 : 3;
      }
    } else if (Array.isArray(v)) {
      n += 2 + Math.max(0, v.length - 1);
      for (let index = 0; index < v.length && n <= limit; index++) visit(v[index] ?? null);
    } else if (typeof v === 'object' && v !== null) {
      n += 2;
      let first = true;
      for (const key in v) {
        if (n > limit) return;
        if (!Object.hasOwn(v, key)) continue;
        const item: unknown = Reflect.get(v, key);
        if (item === undefined) continue;
        n += first ? 1 : 2;
        first = false;
        visit(key);
        if (n > limit) return;
        visit(item);
      }
    } else {
      n += (JSON.stringify(v) ?? 'null').length;
    }
  };
  visit(value);
  return n;
}
