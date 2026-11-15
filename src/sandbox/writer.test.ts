import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { BoundedWriter } from './writer.js';

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

describe('BoundedWriter', () => {
  it('stops writing on backpressure and resumes in order on drain', () => {
    const stream = new StalledStream();
    const writer = new BoundedWriter(stream, { maxPendingBytes: 100, maxTotalBytes: 1_000, onOverflow: () => undefined });
    for (const line of ['aaaaaaaaaaaa', 'b', 'c']) expect(writer.write(line)).toBe(true);
    expect(stream.written).toEqual(['aaaaaaaaaaaa']);
    expect(writer.pendingBytes).toBe(14);
    stream.drainAll();
    expect(stream.written).toEqual(['aaaaaaaaaaaa', 'b', 'c']);
  });

  it('calls onOverflow once and keeps memory bounded when the reader never reads', () => {
    const stream = new StalledStream();
    const overflows: string[] = [];
    const writer = new BoundedWriter(stream, { maxPendingBytes: 50, maxTotalBytes: 10_000, onOverflow: (m) => overflows.push(m) });
    let accepted = 0;
    for (let i = 0; i < 1_000; i++) if (writer.write('0123456789')) accepted++;
    expect(accepted).toBe(5);
    expect(writer.pendingBytes).toBeLessThanOrEqual(50);
    expect(overflows).toHaveLength(1);
    expect(overflows[0]).toContain('not read yet');
  });

  it('caps the total bytes even when the reader keeps up', () => {
    const stream = new StalledStream();
    const overflows: string[] = [];
    const writer = new BoundedWriter(stream, { maxPendingBytes: 1_000, maxTotalBytes: 25, onOverflow: (m) => overflows.push(m) });
    expect(writer.write('012345678')).toBe(true);
    stream.drainAll();
    expect(writer.write('012345678')).toBe(true);
    stream.drainAll();
    expect(writer.write('012345678')).toBe(false);
    expect(overflows[0]).toContain('in total');
  });
});
