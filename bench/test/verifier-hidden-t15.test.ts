// The hidden-test cases of T15 on imports, shims and look-alikes. The verifier cases are split across files so that Vitest runs them in parallel processes.
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifierWorkspaces, edit, hiddenLine } from './verifier-workspaces.ts';

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

  it('T15 rejects a shim: the old helper kept as a wrapper over request', async () => {
    const { ws, verify } = await solvedT15();
    await writeFile(
      path.join(ws.dir, 'src', 'lib', 'http-compat.js'),
      "import { request } from './http.js';\nexport const legacyFetch = async (url, opts = {}) => {\n  const res = await request({ url, query: opts.qs });\n  return { status: res.status, data: res.body };\n};\n",
    );
    await writeFile(
      path.join(ws.dir, 'src', 'services', 'catalog', 'products.js'),
      (ws.initial.get('src/services/catalog/products.js') ?? '').replace('../../lib/legacy-http.js', '../../lib/http-compat.js'),
    );
    const result = await verify();
    expect(result.pass).toBe(false);
    expect(result.details[0]).toMatch(/^ok node --test passes/);
    expect(hiddenLine(result.details)).toMatch(/static: every former caller imports src\/lib\/http\.js and calls request itself; static: the old helpers are not recreated/);
    // The same wrapper under another name is still caught: its caller does not call request itself.
    await edit(ws.dir, 'src/lib/http-compat.js', 'export const legacyFetch =', 'export const fetchCompat =');
    await edit(ws.dir, 'src/services/catalog/products.js', 'import { legacyFetch }', 'import { fetchCompat as legacyFetch }');
    await edit(ws.dir, 'src/services/catalog/products.js', "import { API } from '../config.js';", "import { API } from '../config.js';\nimport { request } from '../../lib/http.js';");
    const renamed = await verify();
    expect(hiddenLine(renamed.details)).toMatch(/static: the old helpers are not recreated/);
  });

  it('T15 rejects a migration that also rewrote a look-alike, and any deletion but the old module', async () => {
    const trap = await solvedT15();
    await edit(trap.ws.dir, 'src/services/billing/tax-rules.js', 'legacyFetch(url)', 'request(options)');
    const rewritten = await trap.verify();
    expect(rewritten.pass).toBe(false);
    expect(rewritten.details.filter((d) => d.startsWith('FAIL'))).toEqual(['FAIL files that are not callers of legacy-http changed: src/services/billing/tax-rules.js']);

    const vendor = await solvedT15();
    await edit(vendor.ws.dir, 'src/services/users/session-cache.js', "import * as cache from '../../vendor/cache/legacy.js';", "import * as cache from '../../vendor/cache/legacy.js'; // not HTTP");
    expect((await vendor.verify()).details.join('\n')).toMatch(/FAIL files that are not callers of legacy-http changed: src\/services\/users\/session-cache\.js/);

    const deleted = await solvedT15();
    await rm(path.join(deleted.ws.dir, 'src', 'services', 'config.js'));
    await rm(path.join(deleted.ws.dir, 'src', 'lib', 'dates.js'));
    expect((await deleted.verify()).details.join('\n')).toMatch(/FAIL changed outside the task: deleted src\/lib\/dates\.js, deleted src\/services\/config\.js/);

    const http = await solvedT15();
    await edit(http.ws.dir, 'src/lib/http.js', "const DEFAULT_TIMEOUT_MS = 30000;", "const DEFAULT_TIMEOUT_MS = 30_000;");
    expect((await http.verify()).details.join('\n')).toMatch(/FAIL changed outside the task: modified src\/lib\/http\.js/);
  });
});
