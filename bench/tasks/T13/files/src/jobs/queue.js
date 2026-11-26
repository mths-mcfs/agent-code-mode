/**
 * Job queue: bounded concurrency, retry with backoff, de-duplication by key.
 *
 *   const queue = createQueue({ concurrency, maxAttempts, backoff: { baseMs, factor, maxMs }, clock });
 *   const result = await queue.add(key, fn);
 *
 * Contract:
 * 1. Concurrency. At most `concurrency` job functions are running at any moment. A job function is
 *    called as `fn(attempt)`, with attempt = 1, 2, ...; it may return a value or a promise, and a
 *    synchronous throw is a failed attempt like a rejection. Jobs waiting for a slot start in the
 *    order in which they began to wait.
 * 2. Retry. A failed attempt is retried until `maxAttempts` attempts have been made. The wait before
 *    attempt n + 1 is min(maxMs, baseMs * factor ** (n - 1)) milliseconds, scheduled with one
 *    `clock.setTimeout(fn, ms)` call and with nothing else (no real timers).
 * 3. Backoff does not hold a slot. While a job waits out its backoff its slot is free for other
 *    jobs. When the wait ends the job queues for a slot like a newly added job, behind the jobs
 *    that are already waiting.
 * 4. Giving up. When attempt number `maxAttempts` fails, the promise rejects with the error of that
 *    last attempt and the job function is not called again.
 * 5. De-duplication. While a job is pending (waiting for a slot, running or in backoff), `add` with
 *    the same key does not call the new function: it returns the promise of the pending job (the
 *    same object).
 * 6. Key reuse. A key is free again as soon as its job settles, whether it resolved or rejected:
 *    the next `add` with that key runs its function as a new job, with attempts counted from 1.
 *    Nothing is cached. The key is already free when the handlers of the promise run, so a `then`
 *    or `catch` handler may add the same key again.
 * 7. `stats()` returns `{ running, waiting, delayed }`: the jobs whose function is running, the jobs
 *    waiting for a slot and the jobs in backoff.
 */
import { systemClock } from './clock.js';
import { createRegistry } from './registry.js';
import { handleFailure } from './retry.js';
import { createSlots } from './slots.js';

export function createQueue({ concurrency = 4, maxAttempts = 3, backoff = {}, clock = systemClock } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError('concurrency must be a positive integer');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new RangeError('maxAttempts must be a positive integer');
  const policy = { maxAttempts, baseMs: backoff.baseMs ?? 100, factor: backoff.factor ?? 2, maxMs: backoff.maxMs ?? 30_000 };
  const slots = createSlots(concurrency);
  const keys = createRegistry();
  const counters = { delayed: 0 };

  async function run(job) {
    const release = await slots.acquire();
    job.attempt += 1;
    try {
      const value = await job.fn(job.attempt);
      keys.release(job.key);
      job.resolve(value);
    } catch (err) {
      handleFailure(job, err, { policy, clock, counters, release, requeue: run });
    } finally {
      release();
    }
  }

  function add(key, fn) {
    const pending = keys.get(key);
    if (pending) return pending;
    const job = { key, fn, attempt: 0, resolve: null, reject: null };
    const promise = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    keys.hold(key, promise);
    void run(job);
    return promise;
  }

  return {
    add,
    stats: () => ({ running: slots.active, waiting: slots.waiting, delayed: counters.delayed }),
  };
}
