/** Counting semaphore: at most `limit` holders at a time; waiters are served first come, first served. */
export function createSlots(limit) {
  let active = 0;
  const waiters = [];

  const release = () => {
    const next = waiters.shift();
    if (next) next(release); // the slot goes straight to the next waiter
    else active -= 1;
  };

  return {
    /** Resolves with the function that gives the slot back. */
    acquire() {
      if (active < limit) {
        active += 1;
        return Promise.resolve(release);
      }
      return new Promise((resolve) => waiters.push(resolve));
    },
    get active() {
      return active;
    },
    get waiting() {
      return waiters.length;
    },
  };
}
