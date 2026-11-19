import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { BoundedWriter, jsonBytes, type BoundedWriterOptions } from './writer.js';

/** A stream whose reader is stalled until `drainAll()`; it reports false once 10 bytes are buffered. */
class StalledStream extends EventEmitter {
  readonly written: string[] = [];
  buffered = 0;
  destroyed = false;
  get writableLength(): number {
    return this.buffered;
  }
  write(chunk: Buffer): boolean {
    this.written.push(chunk.toString('utf8'));
    this.buffered += chunk.length;
    return this.buffered < 10;
  }
  drainAll(): void {
    this.buffered = 0;
    this.emit('drain');
  }
}

/** Options with no deadline; tests override what they exercise. */
function options(overrides: Partial<BoundedWriterOptions> = {}): BoundedWriterOptions {
  return { maxPendingBytes: 100, maxTotalBytes: 1_000, deadline: Infinity, onExpired: () => undefined, onOverflow: () => undefined, ...overrides };
}

/** A fake monotonic clock and the deadline the writer is given. */
function fakeClock(): { now: () => number; deadline: number; cross: () => void; expirations: () => number; onExpired: () => void } {
  let time = 0;
  let expired = 0;
  return { now: () => time, deadline: 1_000, cross: () => (time = 1_000), expirations: () => expired, onExpired: () => expired++ };
}

describe('BoundedWriter', () => {
  it('stops writing on backpressure and resumes in order on drain', () => {
    const stream = new StalledStream();
    const writer = new BoundedWriter(stream, options());
    for (const line of ['aaaaaaaaaaaa', 'b', 'c']) expect(writer.write(line)).toBe(true);
    expect(stream.written).toEqual(['aaaaaaaaaaaa']);
    expect(writer.pendingBytes).toBe(14);
    stream.drainAll();
    expect(stream.written).toEqual(['aaaaaaaaaaaa', 'b', 'c']);
  });

  it('discards queued replies if the deadline passes before drain', () => {
    const stream = new StalledStream();
    const clock = fakeClock();
    const writer = new BoundedWriter(stream, options(clock));
    expect(writer.write('first reply\n')).toBe(true);
    expect(writer.writeJson({ result: 'queued' })).toBe(true);
    clock.cross();
    stream.drainAll();
    expect(stream.written).toEqual(['first reply\n']);
    expect(writer.pendingBytes).toBe(0);
    expect(writer.writeJson({ result: 'late' })).toBe(false);
    expect(clock.expirations()).toBe(1);
  });

  it('writes nothing when the deadline passes while a queued reply is taken off the queue', () => {
    const stream = new StalledStream();
    const clock = fakeClock();
    const writer = new BoundedWriter(stream, options(clock));
    expect(writer.write('first reply\n')).toBe(true);
    expect(writer.writeJson({ result: 'queued' })).toBe(true);
    // Time passes while the writer takes the queued reply off its queue, after any check made before that.
    const shift = Array.prototype.shift;
    let dequeued = 0;
    Array.prototype.shift = function <T>(this: T[]): T | undefined {
      const item: T | undefined = Reflect.apply(shift, this, []);
      if (Buffer.isBuffer(item) && item.toString('utf8') === '{"result":"queued"}\n') {
        dequeued++;
        clock.cross();
      }
      return item;
    };
    try {
      stream.drainAll();
    } finally {
      Array.prototype.shift = shift;
    }
    expect(dequeued).toBe(1);
    expect(stream.written).toEqual(['first reply\n']);
    expect(clock.expirations()).toBe(1);
    expect(writer.pendingBytes).toBe(0);
  });

  it('writes nothing when the deadline passes while a reply is being serialized', () => {
    const stream = new StalledStream();
    const clock = fakeClock();
    const writer = new BoundedWriter(stream, options(clock));
    const reply = {
      get content(): string {
        clock.cross();
        return 'late';
      },
    };
    expect(writer.writeJson(reply)).toBe(false);
    expect(stream.written).toEqual([]);
    expect(clock.expirations()).toBe(1);
  });

  it('writes the start message outside the caps, and not once the deadline has passed', () => {
    const stream = new StalledStream();
    const clock = fakeClock();
    const writer = new BoundedWriter(stream, options({ ...clock, maxPendingBytes: 4, maxTotalBytes: 4 }));
    expect(writer.writeStart(Buffer.from('start-12\n'))).toBe(true);
    stream.drainAll();
    expect(writer.write('ab\n')).toBe(true);
    expect(stream.written).toEqual(['start-12\n', 'ab\n']);
    const late = new BoundedWriter(new StalledStream(), options(clock));
    clock.cross();
    expect(late.writeStart(Buffer.from('start\n'))).toBe(false);
    expect(clock.expirations()).toBe(1);
  });

  it('calls onOverflow once and keeps memory bounded when the reader never reads', () => {
    const stream = new StalledStream();
    const overflows: string[] = [];
    const writer = new BoundedWriter(stream, options({ maxPendingBytes: 50, maxTotalBytes: 10_000, onOverflow: (m) => overflows.push(m) }));
    let accepted = 0;
    for (let i = 0; i < 1_000; i++) if (writer.write('0123456789')) accepted++;
    expect(accepted).toBe(5);
    expect(writer.pendingBytes).toBeLessThanOrEqual(50);
    expect(overflows).toHaveLength(1);
    expect(overflows[0]).toContain('not read yet');
  });

  it('sizes a JSON line exactly and never builds one that is over a cap', () => {
    const value = { ok: true, value: { content: 'a"\\\n\u0001é€😀\ud800\udc00x', n: [1, null, undefined, -0.5], sparse: Array<string>(2), skip: undefined } };
    expect(jsonBytes(value, Infinity)).toBe(Buffer.byteLength(JSON.stringify(value)));
    const stream = new StalledStream();
    const writer = new BoundedWriter(stream, options({ maxPendingBytes: 1_000, maxTotalBytes: 50 }));
    expect(writer.writeJson({ a: 'b' })).toBe(true);
    const stringify = vi.spyOn(JSON, 'stringify');
    expect(writer.writeJson({ content: 'z'.repeat(100) })).toBe(false);
    const stringified = stringify.mock.calls.length;
    stringify.mockRestore();
    expect(stringified).toBe(0);
    expect(stream.written).toEqual(['{"a":"b"}\n']);
  });

  it('caps the total bytes even when the reader keeps up', () => {
    const stream = new StalledStream();
    const overflows: string[] = [];
    const writer = new BoundedWriter(stream, options({ maxPendingBytes: 1_000, maxTotalBytes: 25, onOverflow: (m) => overflows.push(m) }));
    expect(writer.write('012345678')).toBe(true);
    stream.drainAll();
    expect(writer.write('012345678')).toBe(true);
    stream.drainAll();
    expect(writer.write('012345678')).toBe(false);
    expect(overflows[0]).toContain('in total');
  });
});
