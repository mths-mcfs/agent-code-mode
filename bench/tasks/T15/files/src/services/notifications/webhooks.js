import * as legacy from '../../lib/legacy-http.js';

/**
 * Delivers an event to a customer webhook. `hook` is `{ url, secret, method?, timeoutSeconds? }`:
 * the method defaults to POST and a hook without `timeoutSeconds` gets the default timeout.
 * Never throws for an HTTP status: the result says whether the hook accepted the event.
 */
export async function deliver(hook, event) {
  const res = await legacy.legacyFetch(hook.url, {
    method: hook.method ?? 'POST',
    json: event,
    headers: { 'x-signature': `sha1=${hook.secret}` },
    timeout: hook.timeoutSeconds,
  });
  return { delivered: res.status < 400, status: res.status };
}
