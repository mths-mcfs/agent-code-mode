import type { CallReply, LogLevel, SandboxOutcome } from '../core/types.js';
import { errorMessage } from '../core/errors.js';
import { childMessageSchema, OOM_EXIT_CODE, type ChildMessage, type ParentMessage, type SandboxLimits } from './protocol.js';

/** What a `ChildSession` needs from the outside world. */
export interface SessionHooks {
  /** Forwards a binding call to the dispatcher. Untrusted `tool` and `args`. */
  onCall(tool: string, args: unknown): Promise<CallReply>;
  onLog(level: LogLevel, text: string): void;
  /** Writes one message to the child. */
  send(message: ParentMessage): void;
  /** Kills the child (SIGKILL). Called exactly once, when the session ends. */
  kill(): void;
}

export interface SessionOptions {
  readonly limits: SandboxLimits;
  /** Longest line accepted from the child, in bytes. A longer line kills the child. */
  readonly maxFrameBytes: number;
  /** Most bytes accepted from the child's stdout over the whole run; past it the run ends with outcome `oom`. */
  readonly maxTotalBytes: number;
  /** `performance.now()` time past which no frame is handled; the run ends with outcome `timeout`. */
  readonly deadline: number;
  readonly timeoutMs: number;
  readonly hooks: SessionHooks;
}

/** Bytes of log output tolerated above `maxLogBytes` (the child's own "truncated" note). */
const LOG_SLACK_BYTES = 1_024;
const STDERR_TAIL_CHARS = 2_000;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Builds a `killed` outcome. */
export function killedOutcome(message: string): SandboxOutcome {
  return { ok: false, kind: 'killed', error: { name: 'Killed', message } };
}

/**
 * Parent side of one sandbox run. It reads the child's stdout as
 * newline-delimited JSON and treats every message as hostile: an oversize
 * line, invalid JSON, an unknown message type, an unexpected call id, more
 * calls than the cap or invalid argument JSON kills the child with outcome
 * `killed`. It forwards valid calls to `onCall`, logs to `onLog` (capped), and
 * settles `outcome` once. After the outcome is settled nothing reaches the
 * hooks any more: later messages and late `onCall` replies are dropped.
 */
export class ChildSession {
  readonly outcome: Promise<SandboxOutcome>;
  readonly #limits: SandboxLimits;
  readonly #maxFrameBytes: number;
  readonly #maxTotalBytes: number;
  readonly #deadline: number;
  readonly #timeoutMs: number;
  readonly #hooks: SessionHooks;
  readonly #schema: ReturnType<typeof childMessageSchema>;
  #resolve!: (outcome: SandboxOutcome) => void;
  #finished = false;
  #chunks: Buffer[] = [];
  #chunkBytes = 0;
  #totalBytes = 0;
  #nextCallId = 1;
  #logBytes = 0;
  #stderr = '';

  constructor(options: SessionOptions) {
    this.#limits = options.limits;
    this.#maxFrameBytes = options.maxFrameBytes;
    this.#maxTotalBytes = options.maxTotalBytes;
    this.#deadline = options.deadline;
    this.#timeoutMs = options.timeoutMs;
    this.#hooks = options.hooks;
    this.#schema = childMessageSchema(options.limits);
    this.outcome = new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  get finished(): boolean {
    return this.#finished;
  }

  /** Number of binding calls forwarded to `onCall`. */
  get callCount(): number {
    return this.#nextCallId - 1;
  }

  /** Feeds raw bytes from the child's stdout. */
  feed(chunk: Buffer): void {
    if (this.#finished) return;
    const remaining = this.#maxTotalBytes - this.#totalBytes;
    const overflow = chunk.length > remaining;
    let rest = chunk.subarray(0, remaining);
    this.#totalBytes += rest.length;
    while (!this.#finished && rest.length > 0) {
      const nl = rest.indexOf(0x0a);
      if (nl === -1) {
        this.#chunkBytes += rest.length;
        if (this.#chunkBytes > this.#maxFrameBytes) return this.kill(`sandbox sent a message larger than ${this.#maxFrameBytes} bytes`);
        if (!overflow) this.#chunks.push(rest);
        break;
      }
      const head = rest.subarray(0, nl);
      if (this.#chunkBytes + head.length > this.#maxFrameBytes) {
        return this.kill(`sandbox sent a message larger than ${this.#maxFrameBytes} bytes`);
      }
      const line = this.#chunks.length === 0 ? head : Buffer.concat([...this.#chunks, head]);
      this.#chunks = [];
      this.#chunkBytes = 0;
      rest = rest.subarray(nl + 1);
      let text: string;
      try {
        text = utf8.decode(line);
      } catch {
        return this.kill('sandbox sent a message that is not UTF-8');
      }
      this.handleLine(text);
    }
    if (overflow && !this.#finished) {
      this.finish({ ok: false, kind: 'oom', error: { name: 'OutputLimit', message: `the script sent more than ${this.#maxTotalBytes} bytes of child output` } });
    }
  }

  /** Handles one complete line from the child. */
  handleLine(line: string): void {
    if (this.#finished) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return this.kill('sandbox sent a message that is not JSON');
    }
    const parsed = this.#schema.safeParse(raw);
    if (!parsed.success) return this.kill(`sandbox sent an invalid message: ${parsed.error.issues[0]?.message ?? 'unknown issue'}`);
    // Checked per frame: one stdout chunk can carry many frames that arrive after the deadline.
    if (this.expired()) return;
    this.#handle(parsed.data);
  }

  /** Keeps the tail of the child's stderr for the `killed` message of an unexpected exit. */
  stderr(chunk: Buffer): void {
    this.#stderr = (this.#stderr + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS);
  }

  /** The child exited. Before an outcome, that is a crash, unless the child reports that its engine ran out of memory. */
  exited(code: number | null, signal: string | null): void {
    if (this.#finished) return;
    if (code === OOM_EXIT_CODE && signal === null) {
      if (this.expired()) return;
      return this.finish({ ok: false, kind: 'oom', error: { name: 'InternalError', message: 'out of memory: the script needed more memory than memoryBytes allows' } });
    }
    const how = signal !== null ? `signal ${signal}` : `code ${String(code)}`;
    const tail = this.#stderr.trim();
    this.kill(`sandbox process exited unexpectedly (${how})${tail ? `: ${tail}` : ''}`);
  }

  /** Ends the session with `outcome` and kills the child. Idempotent. */
  finish(outcome: SandboxOutcome): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#chunks = [];
    try {
      this.#hooks.kill();
    } finally {
      this.#resolve(outcome);
    }
  }

  kill(reason: string): void {
    this.finish(killedOutcome(reason));
  }

  timeOut(): void {
    this.finish({ ok: false, kind: 'timeout', error: { name: 'Timeout', message: `the script did not finish within ${this.#timeoutMs} ms` } });
  }

  /** Times the run out once the deadline has passed. Checked right before anything is forwarded, written or settled. */
  expired(): boolean {
    if (performance.now() < this.#deadline) return false;
    this.timeOut();
    return true;
  }

  #handle(message: ChildMessage): void {
    switch (message.type) {
      case 'call':
        return this.#call(message.id, message.tool, message.args);
      case 'log':
        return this.#log(message.level, message.text);
      case 'done':
        return this.#done(message.outcome);
    }
  }

  #call(id: number, tool: string, argsJson: string): void {
    if (id !== this.#nextCallId) return this.kill(`sandbox sent call id ${id}, expected ${this.#nextCallId}`);
    if (id > this.#limits.maxCalls) return this.kill(`sandbox exceeded the limit of ${this.#limits.maxCalls} binding calls`);
    let args: unknown;
    try {
      args = JSON.parse(argsJson);
    } catch {
      return this.kill('sandbox sent call arguments that are not JSON');
    }
    if (this.expired()) return;
    this.#nextCallId++;
    let pending: Promise<CallReply>;
    try {
      pending = this.#hooks.onCall(tool, args);
    } catch (err) {
      pending = Promise.reject(err);
    }
    pending
      .catch((err: unknown): CallReply => ({ ok: false, error: { name: 'ToolError', code: 'tool-error', message: errorMessage(err) } }))
      .then((reply) => {
        if (this.#finished || this.expired()) return;
        try {
          this.#hooks.send({ type: 'reply', id, reply });
        } catch (err) {
          this.kill(`could not send a reply to the sandbox: ${errorMessage(err)}`);
        }
      });
  }

  #log(level: LogLevel, text: string): void {
    const bytes = Buffer.byteLength(text, 'utf8') + 1;
    if (this.#logBytes + bytes > this.#limits.maxLogBytes + LOG_SLACK_BYTES) return this.kill(`sandbox sent more than ${this.#limits.maxLogBytes} bytes of console output`);
    this.#logBytes += bytes;
    if (this.expired()) return;
    this.#hooks.onLog(level, text);
  }

  #done(outcome: Extract<ChildMessage, { type: 'done' }>['outcome']): void {
    if (!outcome.ok) {
      const { name, message, stack } = outcome.error;
      return this.finish({ ok: false, kind: outcome.kind, error: stack === undefined ? { name, message } : { name, message, stack } });
    }
    let value: unknown;
    try {
      value = JSON.parse(outcome.value);
    } catch {
      return this.kill('sandbox sent a return value that is not JSON');
    }
    if (this.expired()) return;
    this.finish({ ok: true, value });
  }
}
