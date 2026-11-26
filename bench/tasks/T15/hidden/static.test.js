import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const read = (rel) => readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8');

/** Every .js file under src/, as POSIX paths relative to the workspace. */
function sourceFiles(rel = 'src') {
  const out = [];
  for (const e of readdirSync(path.join(ROOT, ...rel.split('/')), { withFileTypes: true })) {
    const child = `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...sourceFiles(child));
    else if (/\.[cm]?js$/.test(e.name)) out.push(child);
  }
  return out.sort();
}

// The modules that called src/lib/legacy-http.js, listed by hand.
const CALLERS = [
  'catalog/products.js', 'catalog/search.js', 'catalog/categories.js', 'catalog/inventory.js', 'catalog/reviews.js', 'catalog/product-cache.js',
  'orders/create.js', 'orders/lookup.js', 'orders/cancel.js', 'orders/refunds.js', 'orders/export.js', 'orders/notes.js',
  'billing/invoices.js', 'billing/payments.js', 'billing/subscriptions.js', 'billing/tax.js', 'billing/credits.js', 'billing/dunning.js',
  'users/profile.js', 'users/auth.js', 'users/preferences.js', 'users/avatars.js', 'users/invites.js', 'users/search.js',
  'shipping/rates.js', 'shipping/labels.js', 'shipping/tracking.js', 'shipping/pickups.js', 'shipping/zones.js', 'shipping/customs.js',
  'notifications/email.js', 'notifications/sms.js', 'notifications/webhooks.js', 'notifications/templates.js', 'notifications/push.js', 'notifications/digest.js',
].map((f) => `src/services/${f}`);

// Files that mention the old names for another reason (a vendored cache with a function of the same
// name, its callers, a text check, a comment). They are compared byte for byte by the verifier.
const NOT_HTTP = ['src/vendor/cache/legacy.js', 'src/services/catalog/price-cache.js', 'src/services/users/session-cache.js', 'src/tools/lint-legacy.js', 'src/services/billing/tax-rules.js'];

const IMPORTS_LEGACY_HTTP = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"`][^'"`\n]*legacy-http(?:\.[cm]?js)?['"`]/;
const IMPORTS_HTTP = /\bfrom\s*['"]\.\.\/\.\.\/lib\/http\.js['"]/;
// A declaration, alias, property or re-export that brings the old helper names back.
const OLD_HELPER = /\b(?:function\s*\*?|const|let|var|class)\s+legacy(?:Fetch|Json)\b|\bas\s+legacy(?:Fetch|Json)\b|\blegacy(?:Fetch|Json)\s*[:=]|\bexport\s*\{[^}]*\blegacy(?:Fetch|Json)\b/;

/** True when the file calls `request` from ../../lib/http.js, by its own name or the alias it is imported as. */
function callsRequest(text) {
  const named = /\bimport\s*\{([^}]*)\}\s*from\s*['"]\.\.\/\.\.\/lib\/http\.js['"]/.exec(text)?.[1] ?? '';
  const alias = /\brequest\s+as\s+([A-Za-z_$][\w$]*)/.exec(named)?.[1];
  const names = ['request', ...(alias === undefined ? [] : [alias.replace(/\$/g, '\\$')])];
  // `transport.send(` is a method of another object, not a call of the imported binding.
  return new RegExp(`(?<![\\w$.])(?:${names.join('|')})\\s*\\(`).test(text);
}

test('static: src/lib/legacy-http.js is deleted', () => {
  assert.equal(existsSync(path.join(ROOT, 'src', 'lib', 'legacy-http.js')), false, 'src/lib/legacy-http.js still exists');
  const left = sourceFiles().filter((f) => /legacy-http/.test(path.posix.basename(f)));
  assert.deepEqual(left, [], 'a file named like legacy-http is still in src/');
});

test('static: no file imports legacy-http', () => {
  const importing = sourceFiles().filter((f) => IMPORTS_LEGACY_HTTP.test(read(f)));
  assert.deepEqual(importing, [], 'files that still import legacy-http');
});

test('static: every former caller imports src/lib/http.js and calls request itself', () => {
  const missing = [];
  for (const file of CALLERS) {
    if (!existsSync(path.join(ROOT, ...file.split('/')))) {
      missing.push(`${file}: file is gone`);
      continue;
    }
    const text = read(file);
    if (!IMPORTS_HTTP.test(text)) missing.push(`${file}: does not import ../../lib/http.js`);
    else if (!callsRequest(text)) missing.push(`${file}: does not call request`);
  }
  assert.deepEqual(missing, []);
});

test('static: the old helpers are not recreated (no legacyFetch/legacyJson wrapper, alias or re-export)', () => {
  const recreated = sourceFiles().filter((f) => !NOT_HTTP.includes(f) && OLD_HELPER.test(read(f)));
  assert.deepEqual(recreated, [], 'files that define, alias or re-export legacyFetch/legacyJson');
});

test('static: product-cache.js still reads through the vendored cache', () => {
  const text = read('src/services/catalog/product-cache.js');
  assert.match(text, /\bfrom\s*['"]\.\.\/\.\.\/vendor\/cache\/legacy\.js['"]/, 'product-cache.js no longer imports the vendored cache');
});
