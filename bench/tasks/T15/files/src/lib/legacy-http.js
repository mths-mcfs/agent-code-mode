/**
 * DEPRECATED. The old HTTP helpers, kept only until their last caller is gone. They are now a thin
 * layer over `request` (src/lib/http.js).
 *
 * MIGRATION: every caller moves to `request` and then this file is deleted. Each caller imports
 * `request` from src/lib/http.js and calls it directly; do not recreate `legacyFetch`, `legacyJson`
 * or a wrapper like them anywhere. A caller must behave exactly as before, with the two intended
 * exceptions noted below (both about error statuses the caller never handled).
 *
 * `legacyFetch(url, opts)` resolves to `{ status, data }` for every status; it never rejects
 * because of a status. In terms of `request`:
 * - `url` (positional)  -> `url`.
 * - `opts.method`       -> `method`. The old helper took any letter case ('post', 'Delete') and
 *                          defaulted to GET; `request` takes upper case only.
 * - `opts.qs`           -> `query`.
 * - `opts.json`         -> `body` (the value itself, not a string) plus the header
 *                          'content-type': 'application/json'.
 * - `opts.body`         -> `body`, with no header added.
 * - `opts.headers`      -> `headers`.
 * - `opts.timeout`      -> `timeoutMs`. The old value is in SECONDS: `timeoutMs` is `timeout * 1000`.
 *                          No timeout (left out or undefined) means the default of 30 s, which is
 *                          also the default of `request`: leave `timeoutMs` out then.
 * - result `data`       -> result `body`. `status` is the same.
 * - Status 400 or above: `request` rejects with an `HttpError`, the old helper resolved.
 *   - A caller that reads `res.status` anywhere (compares it, returns it) handles error statuses:
 *     it must catch the `HttpError` and go on with `err.status` and `err.body` in place of
 *     `res.status` and `res.data`, so that it returns what it returned before for every status.
 *     Catch only `HttpError`: any other error must still propagate.
 *   - A caller that never reads `res.status` never handled error statuses (it went on with the
 *     error payload as if it were data, which was a bug): let the `HttpError` propagate.
 *
 * `legacyJson(url, opts)` takes the same options, resolves to the data alone, and rejects with
 * `new Error('HTTP <status>')` for a status of 400 or above. Its callers become
 * `(await request(...)).body`. They now reject with the `HttpError` of
 * `request` instead of that plain Error. Let it propagate.
 */
import { HttpError, request } from './http.js';

function toRequest(url, opts) {
  const options = { url, method: String(opts.method ?? 'GET').toUpperCase() };
  const headers = { ...(opts.headers ?? {}) };
  if (opts.json !== undefined) {
    options.body = opts.json;
    headers['content-type'] = 'application/json';
  } else if (opts.body !== undefined) {
    options.body = opts.body;
  }
  options.headers = headers;
  if (opts.qs !== undefined) options.query = opts.qs;
  if (opts.timeout !== undefined) options.timeoutMs = opts.timeout * 1000;
  return options;
}

export async function legacyFetch(url, opts = {}) {
  try {
    const res = await request(toRequest(url, opts));
    return { status: res.status, data: res.body };
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, data: err.body };
    throw err;
  }
}

export async function legacyJson(url, opts = {}) {
  const res = await legacyFetch(url, opts);
  if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
  return res.data;
}
