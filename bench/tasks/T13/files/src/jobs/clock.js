/** Timer source of the queue. Tests pass their own object with the same `setTimeout(fn, ms)` method. */
export const systemClock = {
  setTimeout(fn, ms) {
    globalThis.setTimeout(fn, ms);
  },
};
