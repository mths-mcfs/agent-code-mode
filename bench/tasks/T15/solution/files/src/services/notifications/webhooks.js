import { HttpError, request } from '../../lib/http.js';

/**
 * Delivers an event to a customer webhook. `hook` is `{ url, secret, method?, timeoutSeconds? }`:
 * the method defaults to POST and a hook without `timeoutSeconds` gets the default timeout.
 * Never throws for an HTTP status: the result says whether the hook accepted the event.
 */
export async function deliver(hook, event) {
  const options = {
    method: String(hook.method ?? 'POST').toUpperCase(),
    url: hook.url,
    body: event,
    headers: { 'x-signature': `sha1=${hook.secret}`, 'content-type': 'application/json' },
  };
  if (hook.timeoutSeconds !== undefined) options.timeoutMs = hook.timeoutSeconds * 1000;
  try {
    const res = await request(options);
    return { delivered: res.status < 400, status: res.status };
  } catch (err) {
    if (err instanceof HttpError) return { delivered: false, status: err.status };
    throw err;
  }
}
