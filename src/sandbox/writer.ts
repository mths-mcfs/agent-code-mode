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
  /** Stops writing and discards queued lines when the owning run expires. */
  readonly expired?: () => boolean;
  /** Called once when a limit would be exceeded; nothing is written after it. */
  readonly onOverflow: (message: string) => void;
}

/**
 * Writes lines to a stream that a possibly stalled reader consumes (the
 * sandbox child's stdin). It respects backpressure: once `write()` returns
 * false, lines wait in a local queue until `drain`. The bytes waiting (stream
 * buffer plus queue) and the bytes written in total are both capped, so a
 * reader that stops reading can never make the writer's process grow without
 * bound; hitting a cap calls `onOverflow` instead.
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

  /** Writes or queues `line`. Returns false when the writer is closed or a cap was hit. */
  write(line: string): boolean {
    if (!this.#ready()) return false;
    const bytes = Buffer.byteLength(line, 'utf8');
    if (!this.#ready() || !this.#fits(bytes)) return false;
    // Buffers live outside the V8 heap, so pending replies do not count against the server's heap limit.
    const chunk = Buffer.from(line, 'utf8');
    if (!this.#ready()) return false;
    this.#totalBytes += bytes;
    if (this.#waitingForDrain || this.#queue.length > 0) {
      this.#queue.push(chunk);
      this.#queuedBytes += bytes;
      return true;
    }
    if (!this.#stream.write(chunk)) this.#waitForDrain();
    return true;
  }

  /** Writes `value` as one JSON line, sized first so that a line over a cap is never built. */
  writeJson(value: unknown): boolean {
    if (!this.#ready()) return false;
    const room = Math.min(this.#options.maxTotalBytes - this.#totalBytes, this.#options.maxPendingBytes - this.pendingBytes);
    const bytes = jsonBytes(value, room) + 1;
    return this.#ready() && this.#fits(bytes) && this.write(`${JSON.stringify(value)}\n`);
  }

  /** Drops queued lines; later writes are ignored. */
  close(): void {
    this.#closed = true;
    this.#queue = [];
    this.#queuedBytes = 0;
  }

  #ready(): boolean {
    if (this.#closed || this.#stream.destroyed) return false;
    if (!this.#options.expired?.()) return true;
    this.close();
    return false;
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

  #overflow(message: string): false {
    this.close();
    this.#options.onOverflow(message);
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
    while (!this.#waitingForDrain && this.#queue.length > 0 && this.#ready()) {
      const chunk = this.#queue.shift();
      if (chunk === undefined) break;
      this.#queuedBytes -= chunk.length;
      if (!this.#stream.write(chunk)) this.#waitForDrain();
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
