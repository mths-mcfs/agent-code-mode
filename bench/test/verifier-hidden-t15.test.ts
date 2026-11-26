// The hidden-test cases of T15 on callers left on the old API. The verifier cases are split across files so that Vitest runs them in parallel processes.
import { describe, expect, it } from 'vitest';
import { verifierWorkspaces, hiddenLine } from './verifier-workspaces.ts';

const { solvedT15 } = await verifierWorkspaces();

describe('hidden-test tasks', () => {
  // One caller per import shape left on the old API (with the old module kept, so that it still runs).
  it.each([
    { shape: 'named import', file: 'src/services/catalog/products.js' },
    { shape: 'aliased import', file: 'src/services/users/search.js' },
    { shape: 'namespace import', file: 'src/services/orders/cancel.js' },
    { shape: 'aliased legacyJson', file: 'src/services/shipping/zones.js' },
  ])('T15 rejects a migration that missed the $shape', async ({ file }) => {
    const { verify, restore } = await solvedT15();
    await restore(file);
    await restore('src/lib/legacy-http.js');
    const result = await verify();
    expect(result.pass).toBe(false);
    expect(result.details[0]).toMatch(/^ok node --test passes/);
    expect(hiddenLine(result.details)).toMatch(/static: src\/lib\/legacy-http\.js is deleted; static: no file imports legacy-http; static: every former caller imports/);
  });
});
