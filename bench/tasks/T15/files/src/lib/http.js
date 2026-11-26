/**
 * HTTP client of the services. This is the only supported way to call another system.
 *
 * `request(options)` returns a promise of `{ status, headers, body }`.
 *
 * Options (an unknown option rejects with a TypeError):
 * - `url`: required string.
 * - `method`: 'GET' (default), 'POST', 'PUT', 'PATCH' or 'DELETE', in upper case. Anything else,
 *   lower case included, rejects with a TypeError.
 * - `headers`: object of header name to value. Names are lower-cased before they are sent.
 * - `query`: object of query parameters. Entries whose value is undefined or null are dropped, the
 *   other values are sent as strings.
 * - `body`: the payload, sent as it is. No content-type header is added for it.
 * - `timeoutMs`: a positive finite number of milliseconds. Left out (or undefined) it is 30000.
 *   Anything else (0, NaN, a string) rejects with a TypeError.
 *
 * A response whose status is 400 or above rejects with an `HttpError` that carries `status` and
 * `body`. Every other failure (a TypeError for bad options, an error thrown by the transport) is
 * not an `HttpError`.
 *
 * The transport is the function that performs the call. Tests replace it with `setTransport(fn)`:
 * `fn` gets `{ method, url, headers, query, body, timeoutMs }` after the rules above were applied
 * and returns (a promise of) `{ status, headers, body }`.
 */

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const OPTIONS = new Set(['url', 'method', 'headers', 'query', 'body', 'timeoutMs']);
const DEFAULT_TIMEOUT_MS = 30000;

export class HttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

let transport = async () => {
  throw new Error('no HTTP transport is configured');
};

/** Replaces the transport and returns the previous one. */
export function setTransport(fn) {
  const previous = transport;
  transport = fn;
  return previous;
}

function lowerCased(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) out[name.toLowerCase()] = value;
  return out;
}

function withoutEmpty(query) {
  const out = {};
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) out[name] = String(value);
  }
  return out;
}

export async function request(options) {
  if (options === null || typeof options !== 'object') throw new TypeError('request takes an options object');
  for (const name of Object.keys(options)) {
    if (!OPTIONS.has(name)) throw new TypeError(`unknown request option: ${name}`);
  }
  const { url, method = 'GET', headers = {}, query = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  if (typeof url !== 'string' || url === '') throw new TypeError('request needs a url');
  if (!METHODS.has(method)) throw new TypeError(`unsupported method: ${String(method)}`);
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be a positive number');
  const response = await transport({ method, url, headers: lowerCased(headers), query: withoutEmpty(query), body, timeoutMs });
  const result = { status: response.status, headers: response.headers ?? {}, body: response.body };
  if (result.status >= 400) throw new HttpError(result.status, result.body);
  return result;
}
