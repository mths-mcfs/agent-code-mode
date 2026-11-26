import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueue } from '../src/jobs/queue.js';
import { backoffDelay } from '../src/jobs/retry.js';

// A clock whose timers fire at once, so the tests never sleep.
const instantClock = { setTimeout: (fn) => queueMicrotask(fn) };
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('runs a job and resolves with its value', async () => {
  const queue = createQueue({ clock: instantClock });
  assert.equal(await queue.add('a', async () => 42), 42);
});

test('never runs more than `concurrency` jobs at once', async () => {
  const queue = createQueue({ concurrency: 2, clock: instantClock });
  let running = 0;
  let max = 0;
  const work = async () => {
    running += 1;
    max = Math.max(max, running);
    await tick();
    running -= 1;
  };
  await Promise.all(['a', 'b', 'c', 'd', 'e'].map((key) => queue.add(key, work)));
  assert.equal(max, 2);
});

test('retries a failing job', async () => {
  const queue = createQueue({ concurrency: 1, maxAttempts: 3, clock: instantClock });
  const attempts = [];
  const value = await queue.add('flaky', async (attempt) => {
    attempts.push(attempt);
    if (attempt < 3) throw new Error('not yet');
    return 'done';
  });
  assert.equal(value, 'done');
  assert.deepEqual(attempts, [1, 2, 3]);
});

test('rejects when the attempts are spent', async () => {
  const queue = createQueue({ maxAttempts: 2, clock: instantClock });
  await assert.rejects(queue.add('bad', async () => { throw new Error('boom'); }), /boom/);
});

test('returns the promise of a pending job for the same key', async () => {
  const queue = createQueue({ clock: instantClock });
  const first = queue.add('k', async () => 'first');
  const second = queue.add('k', async () => 'second');
  assert.equal(first, second);
  assert.equal(await second, 'first');
});

test('backoff grows by the factor up to the cap', () => {
  const policy = { baseMs: 100, factor: 2, maxMs: 500 };
  assert.deepEqual([1, 2, 3, 4].map((n) => backoffDelay(policy, n)), [100, 200, 400, 500]);
});
