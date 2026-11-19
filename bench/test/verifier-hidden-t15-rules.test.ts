// The hidden-test cases of T15 on the mapping rules. The verifier cases are split across files so that Vitest runs them in parallel processes.
import { describe, expect, it } from 'vitest';
import { verifierWorkspaces, edit, hiddenLine } from './verifier-workspaces.ts';

const { solvedT15 } = await verifierWorkspaces();

describe('hidden-test tasks', () => {
  // The reference solution with one mapping rule of the MIGRATION notes dropped in one caller.
  const T15_WRONG_RULE: readonly { readonly name: string; readonly file: string; readonly from: string; readonly to: string }[] = [
    { name: 'a timeout is left in seconds', file: 'catalog/search.js', from: 'timeoutMs: 3000', to: 'timeoutMs: 3' },
    { name: 'a method keeps its lower case', file: 'billing/dunning.js', from: 'method: String(method).toUpperCase(),', to: 'method,' },
    { name: 'a JSON body goes without its content-type', file: 'notifications/email.js', from: "    headers: { 'content-type': 'application/json' },\n", to: '' },
    { name: 'a JSON body is sent as a string', file: 'users/invites.js', from: 'body: { email, role },', to: 'body: JSON.stringify({ email, role }),' },
    { name: 'the query is dropped', file: 'shipping/tracking.js', from: ", query: { events: 'last' }", to: '' },
    { name: 'an undefined timeout is multiplied', file: 'notifications/webhooks.js', from: 'if (hook.timeoutSeconds !== undefined) options.timeoutMs', to: 'options.timeoutMs' },
    { name: 'an error status the caller handled now throws', file: 'shipping/pickups.js', from: 'if (err instanceof HttpError) return false;', to: '' },
    { name: 'every error is swallowed, not only HttpError', file: 'users/preferences.js', from: 'if (err instanceof HttpError) return false;\n    throw err;', to: 'return false;' },
    { name: 'the result still reads data', file: 'orders/export.js', from: 'return res.body;', to: 'return res.data;' },
  ];

  it.each(T15_WRONG_RULE)('T15 rejects a migration where $name', async ({ file, from, to }) => {
    const { ws, verify } = await solvedT15();
    await edit(ws.dir, `src/services/${file}`, from, to);
    const result = await verify();
    expect(result.pass).toBe(false);
    expect(result.details[0]).toMatch(/^ok node --test passes/);
    expect(hiddenLine(result.details)).toBe(`FAIL hidden tests pass (pass 40, fail 1: behaviour: ${file})`);
  });
});
