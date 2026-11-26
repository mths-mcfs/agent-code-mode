import * as cache from '../../vendor/cache/legacy.js';

/** Session lookups go to the in-memory cache only: cache.legacyFetch(key) is not an HTTP call. */
export function getSession(sessionId) {
  return cache.legacyFetch(`session:${sessionId}`) ?? null;
}

export function putSession(sessionId, session) {
  cache.legacyStore(`session:${sessionId}`, session, 1800);
}
