/**
 * Vendored in-memory cache (legacy edition). Not an HTTP client: `legacyFetch` here looks a key up
 * in the cache. The name comes from the upstream package and must stay, other vendored code
 * imports it.
 */
const entries = new Map();

/** Returns the cached value of `key`, or undefined when it is missing or expired. */
export function legacyFetch(key, opts = {}) {
  const now = opts.now ?? Date.now();
  const entry = entries.get(key);
  if (entry === undefined) return undefined;
  if (entry.expiresAt <= now) {
    entries.delete(key);
    return undefined;
  }
  return entry.value;
}

/** Stores `value` under `key` for `ttlSeconds`. */
export function legacyStore(key, value, ttlSeconds = 60, opts = {}) {
  const now = opts.now ?? Date.now();
  entries.set(key, { value, expiresAt: now + ttlSeconds * 1000 });
}

export function legacyClear() {
  entries.clear();
}
