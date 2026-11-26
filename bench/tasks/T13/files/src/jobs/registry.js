/** Keys of the jobs that have not settled yet, each with the promise handed to its callers. */
export function createRegistry() {
  const pending = new Map();
  return {
    get(key) {
      return pending.get(key);
    },
    hold(key, promise) {
      pending.set(key, promise);
    },
    release(key) {
      pending.delete(key);
    },
  };
}
