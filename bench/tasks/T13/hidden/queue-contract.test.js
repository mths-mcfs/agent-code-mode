import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueue } from '../src/jobs/queue.js';

// Everything is driven by hand: job functions return promises the test settles, and the clock only
// moves when the test advances it. `flush` lets every pending promise reaction run.
const flush = () => new Promise((resolve) => setImmediate(resolve));

function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = [];
  const delays = [];
  const clock = {
    delays,
    setTimeout(fn, ms) {
      delays.push(ms);
      seq += 1;
      timers.push({ at: now + ms, seq, fn });
      return seq;
    },
    pending: () => timers.length,
    nextDelay: () => Math.min(...timers.map((t) => t.at)) - now,
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        await flush();
        const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
        if (!due) break;
        timers.splice(timers.indexOf(due), 1);
        now = due.at;
        due.fn();
      }
      now = target;
      await flush();
    },
  };
  return clock;
}

/** Job functions that stay running until the test settles them, with a count of how many run at once. */
function tracker() {
  const t = { running: 0, max: 0, open: [], started: [] };
  t.job = (name) => (attempt) => {
    t.running += 1;
    t.max = Math.max(t.max, t.running);
    t.started.push(`${name}#${attempt}`);
    return new Promise((resolve, reject) => {
      const done = (settle) => (value) => {
        t.running -= 1;
        settle(value);
      };
      t.open.push({ name, attempt, ok: done(resolve), fail: done(reject) });
    });
  };
  t.take = (name) => {
    const i = t.open.findIndex((o) => o.name === name);
    assert.notEqual(i, -1, `${name} should be running; running: ${t.open.map((o) => o.name).join(', ') || 'nothing'}`);
    return t.open.splice(i, 1)[0];
  };
  return t;
}

const quiet = (promise) => {
  promise.catch(() => {});
  return promise;
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

test('rule 3: a job in backoff frees exactly one slot', async () => {
  const clock = fakeClock();
  const t = tracker();
  const queue = createQueue({ concurrency: 1, maxAttempts: 3, backoff: { baseMs: 100 }, clock });
  const a = queue.add('a', t.job('a'));
  const b = queue.add('b', t.job('b'));
  const c = queue.add('c', t.job('c'));
  await flush();
  assert.deepEqual(t.started, ['a#1']);
  assert.deepEqual(queue.stats(), { running: 1, waiting: 2, delayed: 0 });

  t.take('a').fail(new Error('a1'));
  await flush();
  assert.deepEqual(t.started, ['a#1', 'b#1'], 'the freed slot goes to b, and only to b');
  assert.equal(t.running, 1);
  assert.deepEqual(queue.stats(), { running: 1, waiting: 1, delayed: 1 });

  t.take('b').ok('B');
  await flush();
  assert.deepEqual(t.started, ['a#1', 'b#1', 'c#1']);
  await clock.advance(100);
  assert.deepEqual(queue.stats(), { running: 1, waiting: 1, delayed: 0 });
  t.take('c').ok('C');
  await flush();
  assert.deepEqual(t.started, ['a#1', 'b#1', 'c#1', 'a#2']);
  t.take('a').ok('A');
  assert.deepEqual(await Promise.all([a, b, c]), ['A', 'B', 'C']);
  assert.equal(t.max, 1);
  assert.deepEqual(queue.stats(), { running: 0, waiting: 0, delayed: 0 });
});

test('rule 1: the limit holds for jobs added after a retry, with nobody waiting at the failure', async () => {
  const clock = fakeClock();
  const t = tracker();
  const queue = createQueue({ concurrency: 2, maxAttempts: 2, backoff: { baseMs: 50 }, clock });
  const a = queue.add('a', t.job('a'));
  queue.add('b', t.job('b'));
  await flush();
  t.take('a').fail(new Error('a1'));
  await flush();
  assert.deepEqual(queue.stats(), { running: 1, waiting: 0, delayed: 1 });
  queue.add('c', t.job('c'));
  queue.add('d', t.job('d'));
  await flush();
  assert.equal(t.running, 2, 'b and c run, d waits');
  assert.deepEqual(t.started, ['a#1', 'b#1', 'c#1']);
  assert.deepEqual(queue.stats(), { running: 2, waiting: 1, delayed: 1 });
  await clock.advance(50);
  assert.equal(t.running, 2);
  assert.deepEqual(queue.stats(), { running: 2, waiting: 2, delayed: 0 });
  t.take('b').ok();
  await flush();
  t.take('c').ok();
  await flush();
  assert.deepEqual(t.started, ['a#1', 'b#1', 'c#1', 'd#1', 'a#2']);
  t.take('a').ok('A');
  assert.equal(await a, 'A');
  assert.equal(t.max, 2);
});

test('rules 1 and 4: the limit holds after a job has given up', async () => {
  const clock = fakeClock();
  const t = tracker();
  const queue = createQueue({ concurrency: 1, maxAttempts: 2, backoff: { baseMs: 10 }, clock });
  const a = quiet(queue.add('a', t.job('a')));
  await flush();
  t.take('a').fail(new Error('a1'));
  await clock.advance(10);
  t.take('a').fail(new Error('a2'));
  await assert.rejects(a, /a2/);
  await flush();
  assert.deepEqual(queue.stats(), { running: 0, waiting: 0, delayed: 0 });
  const rest = ['b', 'c', 'd'].map((k) => queue.add(k, t.job(k)));
  await flush();
  assert.equal(t.running, 1);
  assert.deepEqual(queue.stats(), { running: 1, waiting: 2, delayed: 0 });
  for (const k of ['b', 'c', 'd']) {
    t.take(k).ok(k);
    await flush();
  }
  assert.deepEqual(await Promise.all(rest), ['b', 'c', 'd']);
  assert.equal(t.max, 1);
});

test('rule 3: a retry queues behind the jobs that are already waiting', async () => {
  const clock = fakeClock();
  const t = tracker();
  const queue = createQueue({ concurrency: 1, maxAttempts: 2, backoff: { baseMs: 100 }, clock });
  for (const k of ['a', 'b', 'c', 'd']) queue.add(k, t.job(k));
  await flush();
  t.take('a').fail(new Error('a1'));
  await clock.advance(100); // b runs, c and d wait, a joins the line behind them
  queue.add('e', t.job('e'));
  for (const k of ['b', 'c', 'd', 'a', 'e']) {
    await flush();
    t.take(k).ok();
  }
  await flush();
  assert.deepEqual(t.started, ['a#1', 'b#1', 'c#1', 'd#1', 'a#2', 'e#1']);
});

test('rules 2 and 4: backoff delays, the cap, and rejection with the last error', async () => {
  const clock = fakeClock();
  const queue = createQueue({ concurrency: 2, maxAttempts: 5, backoff: { baseMs: 100, factor: 2, maxMs: 500 }, clock });
  const attempts = [];
  const p = quiet(queue.add('k', (attempt) => {
    attempts.push(attempt);
    if (attempt % 2 === 0) throw new Error(`sync ${attempt}`); // a synchronous throw is a failed attempt
    return Promise.reject(new Error(`async ${attempt}`));
  }));
  await flush();
  assert.deepEqual(attempts, [1]);
  await clock.advance(99);
  assert.deepEqual(attempts, [1], 'no retry before the delay has passed');
  await clock.advance(1);
  assert.deepEqual(attempts, [1, 2]);
  await clock.advance(10_000);
  assert.deepEqual(attempts, [1, 2, 3, 4, 5]);
  assert.deepEqual(clock.delays, [100, 200, 400, 500]);
  await assert.rejects(p, /^Error: async 5$/);
  assert.equal(clock.pending(), 0);
  assert.deepEqual(queue.stats(), { running: 0, waiting: 0, delayed: 0 });
});

test('rule 5: a pending key is de-duplicated while waiting, running and in backoff', async () => {
  const clock = fakeClock();
  const t = tracker();
  const queue = createQueue({ concurrency: 1, maxAttempts: 2, backoff: { baseMs: 100 }, clock });
  let extra = 0;
  const never = () => {
    extra += 1;
    return 'duplicate';
  };
  const a = queue.add('a', t.job('a'));
  const b = queue.add('b', t.job('b'));
  await flush();
  assert.equal(queue.add('b', never), b, 'b is waiting for a slot');
  assert.equal(queue.add('a', never), a, 'a is running');
  t.take('a').fail(new Error('a1'));
  await flush();
  assert.deepEqual(queue.stats(), { running: 1, waiting: 0, delayed: 1 });
  assert.equal(queue.add('a', never), a, 'a is in backoff');
  await clock.advance(100);
  assert.equal(queue.add('a', never), a, 'a waits for a slot again');
  t.take('b').ok('B');
  await flush();
  assert.equal(queue.add('a', never), a, 'a runs its second attempt');
  t.take('a').ok('A');
  assert.equal(await a, 'A');
  assert.equal(await b, 'B');
  await flush();
  assert.equal(extra, 0);
  assert.deepEqual(t.started, ['a#1', 'b#1', 'a#2']);
});

test('rule 6: a key that resolved runs again as a new job', async () => {
  const clock = fakeClock();
  const queue = createQueue({ clock });
  const calls = [];
  const fn = (value) => (attempt) => {
    calls.push(`${value}#${attempt}`);
    return value;
  };
  const first = queue.add('k', fn('one'));
  assert.equal(await first, 'one');
  const second = queue.add('k', fn('two'));
  assert.notEqual(second, first);
  assert.equal(await second, 'two');
  assert.deepEqual(calls, ['one#1', 'two#1']);
});

test('rule 6: a key that gave up is free again and starts from attempt 1', async () => {
  const clock = fakeClock();
  const queue = createQueue({ concurrency: 1, maxAttempts: 2, backoff: { baseMs: 10 }, clock });
  const calls = [];
  const failing = quiet(queue.add('k', (attempt) => {
    calls.push(`bad#${attempt}`);
    throw new Error(`bad ${attempt}`);
  }));
  await clock.advance(10);
  await assert.rejects(failing, /bad 2/);
  await flush();

  const again = queue.add('k', (attempt) => {
    calls.push(`flaky#${attempt}`);
    if (attempt === 1) throw new Error('flaky 1');
    return 'recovered';
  });
  assert.notEqual(again, failing);
  await clock.advance(10);
  assert.equal(await again, 'recovered');
  assert.deepEqual(calls, ['bad#1', 'bad#2', 'flaky#1', 'flaky#2']);

  const third = queue.add('k', () => 'third');
  assert.equal(await third, 'third');
});

test('rule 6: the key is already free inside the handlers of the promise', async () => {
  const clock = fakeClock();
  const queue = createQueue({ concurrency: 2, maxAttempts: 1, clock });
  const order = [];
  const fromCatch = queue.add('k', () => Promise.reject(new Error('first'))).catch((err) => {
    order.push(`caught ${err.message}`);
    return queue.add('k', () => {
      order.push('second ran');
      return 'second';
    });
  });
  assert.equal(await fromCatch, 'second');
  const fromThen = queue.add('ok', () => 'v1').then((v) => {
    order.push(`got ${v}`);
    return queue.add('ok', () => 'v2');
  });
  assert.equal(await fromThen, 'v2');
  assert.deepEqual(order, ['caught first', 'second ran', 'got v1']);
});

test('rules 1 to 7 together: seeded mix of failures never exceeds the limit or stalls', async () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const random = mulberry32(seed);
    const limit = 1 + (seed % 3);
    const maxAttempts = 3;
    const clock = fakeClock();
    const t = tracker();
    const queue = createQueue({ concurrency: limit, maxAttempts, backoff: { baseMs: 10, factor: 3, maxMs: 40 }, clock });
    const names = Array.from({ length: 14 }, (_, i) => `j${i}`);
    const expected = new Map();
    const results = new Map();
    const add = (name) => {
      queue.add(name, t.job(name)).then(
        (v) => results.set(name, `ok ${v}`),
        (e) => results.set(name, `fail ${e.message}`),
      );
    };
    names.slice(0, 8).forEach(add);
    let next = 8;
    for (let step = 0; results.size < names.length; step += 1) {
      assert.ok(step < 500, `seed ${seed}: the queue stalled with ${results.size} of ${names.length} jobs settled`);
      await flush();
      if (results.size === names.length) break;
      const where = `seed ${seed}, step ${step}`;
      assert.ok(t.running <= limit, `${where}: ${t.running} jobs running, limit ${limit}`);
      const stats = queue.stats();
      assert.equal(stats.running, t.running, `${where}: stats().running`);
      assert.equal(stats.delayed, clock.pending(), `${where}: stats().delayed`);
      if (stats.waiting > 0) assert.equal(t.running, limit, `${where}: jobs wait while a slot is free`);
      if (next < names.length && random() < 0.3) {
        add(names[next]);
        next += 1;
        continue;
      }
      if (t.open.length === 0) {
        if (clock.pending() > 0) await clock.advance(clock.nextDelay());
        else if (next < names.length) {
          add(names[next]);
          next += 1;
        } else assert.fail(`${where}: nothing is running or scheduled, but ${names.length - results.size} jobs never settled`);
        continue;
      }
      const job = t.open.splice(Math.floor(random() * t.open.length), 1)[0];
      if (random() < 0.45) {
        if (job.attempt === maxAttempts) expected.set(job.name, `fail ${job.name} failed ${job.attempt}`);
        job.fail(new Error(`${job.name} failed ${job.attempt}`));
      } else {
        expected.set(job.name, `ok ${job.name}@${job.attempt}`);
        job.ok(`${job.name}@${job.attempt}`);
      }
      if (random() < 0.3 && clock.pending() > 0) await clock.advance(clock.nextDelay());
    }
    await flush();
    assert.deepEqual([...results].sort(), [...expected].sort(), `seed ${seed}`);
    assert.deepEqual(queue.stats(), { running: 0, waiting: 0, delayed: 0 }, `seed ${seed}`);
    assert.ok(clock.delays.every((ms) => [10, 30].includes(ms)), `seed ${seed}: delays ${clock.delays}`);
  }
});
