import { z } from 'zod';
import type { CallReply, Sandbox, SandboxOutcome, SandboxRunOptions } from '../core/types.js';

/**
 * A step of a FakeSandbox script:
 * - `{tool, args}` makes one binding call; its slot holds the value, or `{error}` if it failed.
 * - `{parallel: [...]}` runs the inner steps concurrently (`Promise.all`).
 * - `{log: text, level?}` writes a console line.
 * - `{throw: message}` fails the script.
 * - `{sleep: ms}` waits.
 * - `{throwOnError: true}` makes later failed calls fail the script, like an uncaught rejection.
 */
export type FakeStep =
  | { readonly tool: string; readonly args?: unknown }
  | { readonly parallel: readonly FakeStep[] }
  | { readonly log: string; readonly level?: 'log' | 'info' | 'warn' | 'error' }
  | { readonly throw: string }
  | { readonly sleep: number }
  | { readonly throwOnError: boolean };

const StepSchema: z.ZodType<FakeStep> = z.lazy(() =>
  z.union([
    z.strictObject({ tool: z.string(), args: z.unknown().optional() }),
    z.strictObject({ parallel: z.array(StepSchema) }),
    z.strictObject({ log: z.string(), level: z.enum(['log', 'info', 'warn', 'error']).optional() }),
    z.strictObject({ throw: z.string() }),
    z.strictObject({ sleep: z.number().int().min(0) }),
    z.strictObject({ throwOnError: z.boolean() }),
  ]),
);

const ScriptSchema = z.array(StepSchema);

class ScriptFailure extends Error {
  override readonly name: string;
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

class Stopped extends Error {}

/**
 * Test sandbox. `code` is a JSON array of `FakeStep`s run in sequence; the
 * outcome value is the array of step results. Honors `timeoutMs` and `signal`.
 */
export class FakeSandbox implements Sandbox {
  readonly runs: string[] = [];

  async run(code: string, opts: SandboxRunOptions): Promise<SandboxOutcome> {
    this.runs.push(code);
    let steps: FakeStep[];
    try {
      steps = ScriptSchema.parse(JSON.parse(code));
    } catch (err) {
      return { ok: false, kind: 'error', error: { name: 'SyntaxError', message: err instanceof Error ? err.message : String(err) } };
    }

    let timedOut = false;
    const stopped = new Promise<never>((_resolve, reject) => {
      const onAbort = (): void => reject(new Stopped());
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
      setTimeout(() => {
        timedOut = true;
        reject(new Stopped());
      }, opts.timeoutMs).unref();
    });
    stopped.catch(() => undefined);

    const state = { throwOnError: false };
    const exec = async (step: FakeStep): Promise<unknown> => {
      if ('tool' in step) {
        const reply: CallReply = await opts.onCall(step.tool, step.args);
        if (reply.ok) return reply.value;
        if (state.throwOnError) throw new ScriptFailure(reply.error.name, reply.error.message);
        return { error: reply.error };
      }
      if ('parallel' in step) return Promise.all(step.parallel.map(exec));
      if ('log' in step) {
        opts.onLog(step.level ?? 'log', step.log);
        return null;
      }
      if ('throw' in step) throw new ScriptFailure('Error', step.throw);
      if ('sleep' in step) {
        await new Promise((resolve) => setTimeout(resolve, step.sleep));
        return null;
      }
      state.throwOnError = step.throwOnError;
      return null;
    };

    try {
      const results: unknown[] = [];
      for (const step of steps) results.push(await Promise.race([exec(step), stopped]));
      return { ok: true, value: results };
    } catch (err) {
      if (err instanceof Stopped) {
        return timedOut
          ? { ok: false, kind: 'timeout', error: { name: 'Timeout', message: `script exceeded ${opts.timeoutMs} ms` } }
          : { ok: false, kind: 'killed', error: { name: 'Killed', message: 'script was stopped' } };
      }
      const e = err instanceof Error ? err : new Error(String(err));
      return { ok: false, kind: 'error', error: { name: e.name, message: e.message } };
    }
  }
}
