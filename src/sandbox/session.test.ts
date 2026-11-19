import { describe, expect, it } from 'vitest';
import type { CallReply, LogLevel, SandboxOutcome, ToolResult } from '../core/types.js';
import type { ParentMessage, SandboxLimits } from './protocol.js';
import { ChildSession } from './session.js';

const LIMITS: SandboxLimits = {
  memoryBytes: 1024 * 1024,
  stackBytes: 64 * 1024,
  maxCalls: 3,
  maxLogBytes: 100,
  maxLogLineChars: 50,
  maxResultChars: 500,
  maxArgsChars: 200,
};

function setup(onCall?: (tool: string, args: unknown) => Promise<CallReply>) {
  const sent: ParentMessage[] = [];
  const logs: { level: LogLevel; text: string }[] = [];
  const calls: { tool: string; args: unknown }[] = [];
  let kills = 0;
  const session = new ChildSession({
    limits: LIMITS,
    maxFrameBytes: 1_000,
    hooks: {
      onCall: (tool, args) => {
        calls.push({ tool, args });
        return onCall ? onCall(tool, args) : Promise.resolve({ ok: true, value: { files: [], truncated: false, filtered: 0 } satisfies ToolResult });
      },
      onLog: (level, text) => logs.push({ level, text }),
      send: (m) => sent.push(m),
      kill: () => kills++,
    },
  });
  const line = (message: unknown): void => session.feed(Buffer.from(`${JSON.stringify(message)}\n`));
  return { session, sent, logs, calls, line, kills: () => kills };
}

async function killed(session: ChildSession): Promise<string> {
  const outcome: SandboxOutcome = await session.outcome;
  if (outcome.ok || outcome.kind !== 'killed') throw new Error(`expected killed, got ${JSON.stringify(outcome)}`);
  return outcome.error.message;
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('ChildSession: valid traffic', () => {
  it('forwards calls, replies with the same id, passes logs and settles on done', async () => {
    const t = setup();
    t.line({ type: 'call', id: 1, tool: 'glob', args: '{"pattern":"*.ts"}' });
    t.line({ type: 'log', level: 'warn', text: 'careful' });
    await tick();
    expect(t.calls).toEqual([{ tool: 'glob', args: { pattern: '*.ts' } }]);
    expect(t.sent).toEqual([{ type: 'reply', id: 1, reply: { ok: true, value: { files: [], truncated: false, filtered: 0 } } }]);
    expect(t.logs).toEqual([{ level: 'warn', text: 'careful' }]);
    t.line({ type: 'done', outcome: { ok: true, value: '{"a":[1,2]}' } });
    expect(await t.session.outcome).toEqual({ ok: true, value: { a: [1, 2] } });
    expect(t.kills()).toBe(1);
  });

  it('reassembles messages split across chunks and several messages in one chunk', async () => {
    const t = setup();
    const text = `${JSON.stringify({ type: 'log', level: 'log', text: 'one' })}\n${JSON.stringify({ type: 'log', level: 'log', text: 'two' })}\n`;
    t.session.feed(Buffer.from(text.slice(0, 7)));
    t.session.feed(Buffer.from(text.slice(7, 40)));
    t.session.feed(Buffer.from(text.slice(40)));
    expect(t.logs.map((l) => l.text)).toEqual(['one', 'two']);
  });

  it('passes error outcomes through', async () => {
    const t = setup();
    t.line({ type: 'done', outcome: { ok: false, kind: 'oom', error: { name: 'InternalError', message: 'out of memory' } } });
    expect(await t.session.outcome).toEqual({ ok: false, kind: 'oom', error: { name: 'InternalError', message: 'out of memory' } });
  });

  it('parses hostile keys in the return value as own data', async () => {
    const t = setup();
    t.line({ type: 'done', outcome: { ok: true, value: '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}' } });
    const outcome = await t.session.outcome;
    expect(outcome.ok).toBe(true);
    const result = outcome.ok ? outcome.value : undefined;
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.keys(result as object)).toEqual(['__proto__', 'constructor']);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it('drops log output past the cap without killing the child', () => {
    const t = setup();
    for (let i = 0; i < 100; i++) t.line({ type: 'log', level: 'log', text: 'x'.repeat(40) });
    expect(t.session.finished).toBe(false);
    const bytes = t.logs.reduce((n, l) => n + l.text.length + 1, 0);
    expect(bytes).toBeLessThanOrEqual(LIMITS.maxLogBytes + 1_024);
    expect(t.logs.length).toBeLessThan(100);
  });
});

describe('ChildSession: hostile child messages', () => {
  it('kills on a line larger than the frame limit, even without a newline', async () => {
    const t = setup();
    t.session.feed(Buffer.alloc(600, 0x61));
    expect(t.session.finished).toBe(false);
    t.session.feed(Buffer.alloc(600, 0x61));
    expect(await killed(t.session)).toContain('larger than 1000 bytes');
    expect(t.kills()).toBe(1);
  });

  it('kills on an oversize string field', async () => {
    const t = setup();
    t.line({ type: 'log', level: 'log', text: 'y'.repeat(300) });
    expect(await killed(t.session)).toContain('invalid message');
  });

  it('kills on a line that is not JSON', async () => {
    const t = setup();
    t.session.feed(Buffer.from('{"type": "call", \n'));
    expect(await killed(t.session)).toContain('not JSON');
  });

  it.each([
    ['unknown type', { type: 'exec', command: 'rm -rf /' }],
    ['missing fields', { type: 'call', id: 1 }],
    ['extra field', { type: 'log', level: 'log', text: 'x', extra: 1 }],
    ['bad level', { type: 'log', level: 'debug', text: 'x' }],
    ['non-integer id', { type: 'call', id: 1.5, tool: 'read', args: '{}' }],
    ['outcome kind the child may not claim', { type: 'done', outcome: { ok: false, kind: 'killed', error: { name: 'x', message: 'y' } } }],
    ['array instead of object', [1, 2, 3]],
    ['null', null],
  ])('kills on %s', async (_label, message) => {
    const t = setup();
    t.line(message);
    expect(await killed(t.session)).toContain('invalid message');
    expect(t.calls).toEqual([]);
  });

  it('kills on a call id out of sequence', async () => {
    const t = setup();
    t.line({ type: 'call', id: 2, tool: 'read', args: '{}' });
    expect(await killed(t.session)).toContain('expected 1');
    expect(t.calls).toEqual([]);
  });

  it('kills on a repeated call id', async () => {
    const t = setup();
    t.line({ type: 'call', id: 1, tool: 'read', args: '{}' });
    t.line({ type: 'call', id: 1, tool: 'read', args: '{}' });
    expect(await killed(t.session)).toContain('expected 2');
    expect(t.calls).toHaveLength(1);
  });

  it('kills when the child exceeds the call cap', async () => {
    const t = setup();
    for (let id = 1; id <= 4; id++) t.line({ type: 'call', id, tool: 'read', args: '{}' });
    expect(await killed(t.session)).toContain('limit of 3');
    expect(t.calls).toHaveLength(3);
  });

  it('kills on call arguments that are not JSON', async () => {
    const t = setup();
    t.line({ type: 'call', id: 1, tool: 'read', args: '{nope' });
    expect(await killed(t.session)).toContain('not JSON');
    expect(t.calls).toEqual([]);
  });

  it('kills on a return value that is not JSON', async () => {
    const t = setup();
    t.line({ type: 'done', outcome: { ok: true, value: 'undefined' } });
    expect(await killed(t.session)).toContain('not JSON');
  });

  it('ignores everything after the outcome and sends no late replies', async () => {
    let release: (reply: CallReply) => void = () => undefined;
    const t = setup(() => new Promise<CallReply>((resolve) => (release = resolve)));
    t.line({ type: 'call', id: 1, tool: 'read', args: '{}' });
    t.session.kill('stopped by test');
    t.line({ type: 'call', id: 2, tool: 'read', args: '{}' });
    t.line({ type: 'log', level: 'log', text: 'late' });
    release({ ok: true, value: { files: [], truncated: false, filtered: 0 } });
    await tick();
    expect(await killed(t.session)).toBe('stopped by test');
    expect(t.calls).toHaveLength(1);
    expect(t.sent).toEqual([]);
    expect(t.logs).toEqual([]);
    expect(t.kills()).toBe(1);
  });

  it('turns an unexpected exit into killed with the stderr tail', async () => {
    const t = setup();
    t.session.stderr(Buffer.from('fatal: something broke\n'));
    t.session.exited(134, null);
    const message = await killed(t.session);
    expect(message).toContain('exited unexpectedly (code 134)');
    expect(message).toContain('something broke');
  });

  it('answers a throwing onCall with a tool error instead of crashing', async () => {
    const t = setup(() => {
      throw new Error('dispatcher bug');
    });
    t.line({ type: 'call', id: 1, tool: 'read', args: '{}' });
    await tick();
    expect(t.sent).toEqual([{ type: 'reply', id: 1, reply: { ok: false, error: { name: 'ToolError', code: 'tool-error', message: 'dispatcher bug' } } }]);
  });
});
